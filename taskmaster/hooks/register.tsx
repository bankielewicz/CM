// Taskmaster: holds Claude to the workflow of the skill it loads (see
// docs/taskmaster-plan.md). This is the P1.0 scaffold: it reads its settings,
// builds the engine table at session.start, and runs the startup self-check.
// Every hook passes its event on unchanged, and nothing is shown.

import type { Register } from 'claude-code'

import type { Io } from '../types'
import { parseConfig } from './config'
import { SelfCheck } from './selfcheck'

export const register: Register = (on, options) => {
  // Module state starts over on a hot reload. The self-check's record is in
  // $.store, which a reload keeps, and session.start reads it back.
  const config = parseConfig(options)
  const selfCheck = new SelfCheck()

  on('session.start', async ($, e, next) => {
    // A mod can't pass `$` around, so helpers get this table of closures.
    const io: Io = {
      now: () => $.clock.now(),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
    }
    const result = await next(e)
    await selfCheck.note('session.start')
    const build = (await $.session.version()).version
    // Saves the record, with the events buffered before this point.
    await selfCheck.start(io, build, config)
    return result
  })

  // Observers for the self-check: each notes its event and passes it on.
  on('session.end', async ($, e, next) => {
    await selfCheck.note('session.end')
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    await selfCheck.note('session.compact')
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    await selfCheck.note('prompt.submit')
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    await selfCheck.note('turn.start')
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    await selfCheck.note('turn.complete')
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    await selfCheck.note('tool.call')
    return next(e)
  })
  on('tool.check', async ($, e, next) => {
    await selfCheck.note('tool.check')
    return next(e)
  })
  on('skill.prompt', async ($, e, next) => {
    await selfCheck.note('skill.prompt')
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    await selfCheck.note('agent.spawn')
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    await selfCheck.note('classic.SessionStart')
    return next(e)
  })
  on('classic.PreCompact', async ($, e, next) => {
    await selfCheck.note('classic.PreCompact')
    return next(e)
  })
  on('classic.PostCompact', async ($, e, next) => {
    await selfCheck.note('classic.PostCompact')
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await selfCheck.note('classic.Stop')
    return next(e)
  })
  on('classic.TaskCompleted', async ($, e, next) => {
    await selfCheck.note('classic.TaskCompleted')
    return next(e)
  })
}
