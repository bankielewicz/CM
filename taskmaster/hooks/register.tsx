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
import { fromFrontmatter, fromOverride, overrideFile, overrideLookups, resolveDeclared, unnamedOverride } from './contract'
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
  // The captures so far, read once from $.state and emptied at each session.end.
  // Only this module writes them, so a plain write needs no compare-and-set. That
  // also keeps it clear of `update`, which retries on a read the docs say is one
  // moment per dispatch. It's current once `saves` is idle, not when a hook answers.
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
  // A /clear or a resume ends the conversation and carries on in this process, with
  // no session.start, so the captures start over here. Queued, so saves from before
  // it land first and skills loaded after it land behind it. The held list is what
  // matters: a save re-reads $.state only while it's undefined, so it's never set
  // back to that. The write keeps a later hot reload or another reader from seeing
  // the old list, and if it fails the held list is still empty.
  on('session.end', ($, e, next) => {
    seen('session.end')
    saves.add(async () => {
      captured = []
      try {
        await $.state.set({ plugin: 'taskmaster', key: 'skills' }, { shape: SKILLS_SHAPE, value: [] })
      } catch (error) {
        $.ui.log(`taskmaster: couldn't clear the recorded skills: ${reason(error)}`, { to: 'debug' })
      }
    })
    return next(e)
  })
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
    // Worked out first: the windows that say who loaded it are open now. A forked skill runs in a loop that nothing open
    // names. Frontmatter the engine flagged may have lost the `context: fork` that says so, so it stays unattributed too.
    const { loop, via } = e.frontmatter.context === 'fork' || e.frontmatterProblem !== undefined ? UNATTRIBUTED : skills.attribute(e.skill)
    // Everything else is saved after the hook answers: recording is nothing it needs to answer, and the engine holds the
    // skill's load, and the agent's first model request, until this hook does. Queued now, so captures land in the order
    // the skills loaded, and a session.end during the read below queues its reset behind this save.
    saves.add(async () => {
      try {
        // P1.3: the declared contract. Read here, after the hook answers, because nothing answers from it yet. P1.5,
        // whose footer is built from it, moves the read back into the hook (owner, 2026-11-06). An override file is
        // read only when the frontmatter gives no contract.
        const frontmatter = fromFrontmatter(e.frontmatter, e.frontmatterProblem)
        let override: Tier | undefined
        if (!frontmatter.contract) {
          // A name that can't name a file reads none, and the problem says why.
          const name = overrideFile(e.skill)
          let file: string | undefined
          let root: string | undefined
          let unreadable: string | undefined
          if (name !== undefined) {
            try {
              root = (await $.session.root()).replace(/\/+$/, '')
              file = await $.fs.read(`${root}/${config.overrideDir}/${name}`)
            } catch (error) {
              // A missing file declares nothing. One that's there but can't be read, or a path that can't be worked out,
              // is set aside with its reason, so a stricter contract isn't lost without a word. `exists` can't tell
              // the two apart, because it's false for a file under a folder that can't be searched (#21). So the file
              // is missing only when the nearest folder on its path that exists lists no such name.
              let missing = false
              try {
                for (const { dir, child } of root === undefined ? [] : overrideLookups(root, config.overrideDir, name)) {
                  if (!(await $.fs.exists(dir))) continue
                  missing = !(await $.fs.list(dir)).some(entry => entry.name === child)
                  break
                }
              } catch {
                // An `exists` or `list` that fails confirms nothing.
              }
              if (!missing) unreadable = reason(error)
            }
          }
          override = name === undefined ? unnamedOverride(e.skill) : fromOverride(file, unreadable)
        }
        const declared = resolveDeclared(frontmatter, override)
        for (const problem of declared.problems) {
          $.ui.log(`taskmaster: ${e.skill}: ${problem.where} contract set aside: ${problem.message}`, { to: 'debug' })
        }
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
