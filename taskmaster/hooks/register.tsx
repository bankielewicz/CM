// Taskmaster: holds Claude to the workflow of the skill it loads (see
// docs/taskmaster-plan.md). So far: it reads its settings, builds the engine
// table at session.start, runs the startup self-check (P1.0), and records each
// skill as it loads with the loop it belongs to (P1.1). Every hook passes its
// event on unchanged, and nothing is shown.

import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { Io, SkillCapture, WatchedEvent } from '../types'
import { parseConfig } from './config'
import { SelfCheck } from './selfcheck'
import { fromFrontmatter, fromOverride, overrideFile, resolveDeclared } from './contract'
import type { Tier } from './contract'
import { contentHash, keepLatest, reason, SaveQueue, SKILLS_SHAPE, SkillTracker, UNATTRIBUTED } from './skills'

// The skills loaded this session, newest last. In $.state, which a hot reload keeps.
const skillsAtom = atom({ plugin: 'taskmaster', key: 'skills' } as const, [] as SkillCapture[], { shape: SKILLS_SHAPE })

export const register: Register = (on, options) => {
  // Module state starts over on a hot reload. The self-check's record is in
  // $.store, which a reload keeps, and each save merges with it.
  const config = parseConfig(options)
  const selfCheck = new SelfCheck()
  const skills = new SkillTracker()
  const saves = new SaveQueue()
  // The captures so far, read once from $.state. Only this module writes them,
  // so a plain write needs no compare-and-set. That also keeps it clear of
  // `update`, which retries on a read the docs say is one moment per dispatch.
  // It's current once `saves` is idle, not when a hook answers.
  let captured: SkillCapture[] | undefined

  // Notes an event for the self-check. It never waits on the store.
  const seen = (event: WatchedEvent): void => selfCheck.note(event)

  on('session.start', async ($, e, next) => {
    // A mod can't pass `$` around, so helpers get this table of closures.
    const io: Io = {
      now: () => $.clock.now(),
      version: async () => (await $.session.version()).version,
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
    }
    try {
      return await next(e)
    } finally {
      selfCheck.note('session.start')
      // Saves start here, beginning with the events noted before this point.
      selfCheck.start(io, config)
    }
  })

  // The observers: each notes its event and passes it on unchanged. The engine
  // takes only a function literal as a hook, so each is written out here.
  on('session.end', (_, e, next) => { seen('session.end'); return next(e) })
  on('session.compact', (_, e, next) => { seen('session.compact'); return next(e) })
  on('turn.start', (_, e, next) => { seen('turn.start'); return next(e) })
  on('turn.complete', (_, e, next) => { seen('turn.complete'); skills.acted(e.agentId); return next(e) })
  on('tool.call', (_, e, next) => { seen('tool.call'); skills.acted(e.agentId); return next(e) })
  on('tool.check', (_, e, next) => { seen('tool.check'); return next(e) })
  on('classic.SessionStart', (_, e, next) => { seen('classic.SessionStart'); return next(e) })
  on('classic.PreCompact', (_, e, next) => { seen('classic.PreCompact'); return next(e) })
  on('classic.PostCompact', (_, e, next) => { seen('classic.PostCompact'); return next(e) })
  on('classic.Stop', (_, e, next) => { seen('classic.Stop'); return next(e) })
  on('classic.TaskCompleted', (_, e, next) => { seen('classic.TaskCompleted'); return next(e) })
  on('classic.SubagentStop', (_, e, next) => { seen('classic.SubagentStop'); skills.acted(e.agent_id); return next(e) })
  // A streaming event, so its hook must be an async generator. An agent's preloads
  // are in place before its first model request, so that request ends its window.
  // Not its turn.start, which fires before the preload (seen live on 2.1.318).
  on('turn.step', async function* (_, e, next) {
    seen('turn.step')
    skills.acted(e.agentId)
    return yield* next(e)
  })

  // P1.1: what is open when a skill loads says which loop it belongs to.
  on('tool.call', { tool: 'Skill' }, async (_, e, next) => {
    skills.skillCallOpened(e.tool_use_id, e.skill, e.agentId)
    try {
      return await next(e)
    } finally {
      skills.skillCallClosed(e.tool_use_id)
    }
  })

  on('prompt.submit', async (_, e, next) => {
    seen('prompt.submit')
    const typed = e.command ? skills.typedOpened(e.command.name) : undefined
    try {
      return await next(e)
    } finally {
      if (typed !== undefined) skills.typedClosed(typed)
      skills.promptEnded()
    }
  })

  on('agent.spawn', async (_, e, next) => {
    seen('agent.spawn')
    const spawned = await next(e)
    // No preload window for these. A teammate in its own pane and a workflow's
    // remote agent fire nothing here to close one, and preloads come before an
    // agent's first turn, not on a resume.
    if (typeof spawned.agentId === 'string' && !e.isTeammate && !e.workflow && !e.resume) skills.spawned(spawned.agentId)
    return spawned
  })

  on('skill.prompt', async ($, e, next) => {
    seen('skill.prompt')
    // Worked out first: the windows that say who loaded it are open now.
    const { loop, via } = e.frontmatter.context === 'fork' ? UNATTRIBUTED : skills.attribute(e.skill)
    // P1.3: the declared contract. This hook waits for it, because it's what P1.4
    // and P1.5 build their answer from. An override file is read only when the
    // frontmatter gives none, and a missing file declares nothing.
    const frontmatter = fromFrontmatter(e.frontmatter, e.frontmatterProblem)
    let override: Tier | undefined
    if (!frontmatter.contract) {
      let file: string | undefined
      try {
        const root = (await $.session.root()).replace(/\/+$/, '')
        file = await $.fs.read(`${root}/${config.overrideDir}/${overrideFile(e.skill)}`)
      } catch {
        // No override file.
      }
      override = fromOverride(file)
    }
    const declared = resolveDeclared(frontmatter, override)
    for (const problem of declared.problems) {
      $.ui.log(`taskmaster: ${e.skill}: ${problem.where} contract set aside: ${problem.message}`, { to: 'debug' })
    }
    // Saved after the hook answers: recording is nothing it needs to answer, and
    // the engine holds the skill's load, and the agent's first model request, until
    // this hook does.
    saves.add(async () => {
      try {
        const capture: SkillCapture = {
          skill: e.skill,
          frontmatter: e.frontmatter,
          ...(e.frontmatterProblem === undefined ? {} : { frontmatterProblem: e.frontmatterProblem }),
          source: e.source,
          ...(e.pluginName === undefined ? {} : { pluginName: e.pluginName }),
          ...(e.path === undefined ? {} : { path: e.path }),
          hash: await contentHash(e.text),
          loop,
          via,
          at: await $.clock.now(),
          declared,
        }
        captured = keepLatest(captured ?? (await read($, skillsAtom)), capture)
        await $.state.set({ plugin: 'taskmaster', key: 'skills' }, { shape: SKILLS_SHAPE, value: captured })
      } catch (error) {
        // A skill that can't be recorded still loads. Later tasks treat it as unknown.
        $.ui.log(`taskmaster: couldn't record skill ${e.skill}: ${reason(error)}`, { to: 'debug' })
      }
    })
    return next(e)
  })
}
