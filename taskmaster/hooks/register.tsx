// Taskmaster: holds Claude to the workflow of the skill it loads (see
// docs/taskmaster-plan.md). This is the P1.0 scaffold: it reads its settings,
// builds the engine table at session.start, and runs the startup self-check.
// Every hook passes its event on unchanged, and nothing is shown.

import type { Register } from 'claude-code'

import type { Io, WatchedEvent } from '../types'
import { parseConfig } from './config'
import { SelfCheck, UNKNOWN_BUILD } from './selfcheck'

export const register: Register = (on, options) => {
  // Module state starts over on a hot reload. The self-check's record is in
  // $.store, which a reload keeps, and each save merges with it.
  const config = parseConfig(options)
  const selfCheck = new SelfCheck()

  // Notes an event for the self-check. It never waits on the store.
  const seen = (event: WatchedEvent): void => selfCheck.note(event)

  on('session.start', async ($, e, next) => {
    // A mod can't pass `$` around, so helpers get this table of closures.
    const io: Io = {
      now: () => $.clock.now(),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
    }
    const result = await next(e)
    selfCheck.note('session.start')
    let build = UNKNOWN_BUILD
    try {
      build = (await $.session.version()).version
    } catch {
      // The record is kept under "unknown" until the engine can say.
    }
    // Saves start here, beginning with the events noted before this point.
    selfCheck.start(io, build, config)
    return result
  })

  // The observers: each notes its event and passes it on unchanged. The engine
  // takes only a function literal as a hook, so each is written out here.
  on('session.end', (_, e, next) => { seen('session.end'); return next(e) })
  on('session.compact', (_, e, next) => { seen('session.compact'); return next(e) })
  on('prompt.submit', (_, e, next) => { seen('prompt.submit'); return next(e) })
  on('turn.start', (_, e, next) => { seen('turn.start'); return next(e) })
  on('turn.complete', (_, e, next) => { seen('turn.complete'); return next(e) })
  on('tool.call', (_, e, next) => { seen('tool.call'); return next(e) })
  on('tool.check', (_, e, next) => { seen('tool.check'); return next(e) })
  on('skill.prompt', (_, e, next) => { seen('skill.prompt'); return next(e) })
  on('agent.spawn', (_, e, next) => { seen('agent.spawn'); return next(e) })
  on('classic.SessionStart', (_, e, next) => { seen('classic.SessionStart'); return next(e) })
  on('classic.PreCompact', (_, e, next) => { seen('classic.PreCompact'); return next(e) })
  on('classic.PostCompact', (_, e, next) => { seen('classic.PostCompact'); return next(e) })
  on('classic.Stop', (_, e, next) => { seen('classic.Stop'); return next(e) })
  on('classic.TaskCompleted', (_, e, next) => { seen('classic.TaskCompleted'); return next(e) })
}
