import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SelfCheckRecord, WatchedEvent } from '../types'

export const BUILD = '2.1.317'
export const SELF_CHECK_KEY = `self-check/${BUILD}`

export type World = {
  /** What the mod's `$.store` holds. */
  saved: Map<string, unknown>
  /** Every completed `$.store.set`, in order. */
  writes: string[]
  /** Every status line, toast or band the mod asked for. */
  shown: string[]
  /** Each watched event whose engine answer below the mod ran: the mod called `next(e)`. */
  reached: WatchedEvent[]
  /** Lets the first `$.store.set` finish, when `holdFirstWrite` held it. */
  release: () => void
  /** Called after each completed `$.store.set`. */
  onWrite: (() => void)[]
}

export type EngineOptions = {
  /** What the store holds before the session starts. */
  seed?: Record<string, unknown>
  /** This many `$.store.get` calls fail first, as a broken store would. */
  failGets?: number
  /** This many `$.store.set` calls fail first. */
  failSets?: number
  /** Every `$.store.set` waits forever, as a hung store would. */
  hangWrites?: boolean
  /** The first `$.store.set` waits until `world.release()`. */
  holdFirstWrite?: boolean
  /** `$.session.version()` fails. */
  versionFails?: boolean
  /** `$.session.version()` never answers, as a hung engine would. */
  hangVersion?: boolean
  /** This many `$.session.version()` calls fail first. */
  failVersions?: number
  /** What `$.session.version()` answers in place of this build's, whatever its shape. */
  versionAnswer?: unknown
  /** The engine's own `session.start` throws, after noting it was reached. */
  failStart?: boolean
}

// Nothing sits beneath the plugin in a test: these hooks stand for the
// engine, answering each call the mod makes on `$`.
export function engine(on: On, options: EngineOptions = {}): World {
  let failGets = options.failGets ?? 0
  let failSets = options.failSets ?? 0
  let failVersions = options.failVersions ?? 0
  let held = options.holdFirstWrite ?? false
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const world: World = {
    saved: new Map(Object.entries(options.seed ?? {})),
    writes: [],
    shown: [],
    reached: [],
    release: () => release(),
    onWrite: [],
  }
  const reach = (event: WatchedEvent): void => {
    world.reached.push(event)
  }

  mock.clock(on, { now: 1_000 })
  on('session.version', async () => {
    if (options.hangVersion) await new Promise<never>(() => {})
    if (options.versionFails) throw new Error('version unavailable')
    if (failVersions > 0) {
      failVersions -= 1
      throw new Error('version unavailable')
    }
    if ('versionAnswer' in options) return { value: options.versionAnswer as never }
    return { value: { version: BUILD, base: BUILD, builtAt: '2026-01-01T00:00:00Z' } }
  })
  on('store.get', (_, e) => {
    if (failGets > 0) {
      failGets -= 1
      throw new Error('store unavailable')
    }
    return { value: world.saved.get(e.key) }
  })
  on('store.set', async (_, e) => {
    if (options.hangWrites) await new Promise<never>(() => {})
    if (held) {
      held = false
      await released
    }
    if (failSets > 0) {
      failSets -= 1
      throw new Error('store unavailable')
    }
    world.saved.set(e.key, e.value)
    world.writes.push(e.key)
    for (const listener of world.onWrite.splice(0)) listener()
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.shown.push(`status: ${String(e.text)}`)
    return { value: undefined }
  })
  on('ui.toast', () => {
    world.shown.push('toast')
    return { value: undefined }
  })

  // The engine's own answers to the watched events, each noting it was reached.
  on('session.start', (_, e) => {
    reach('session.start')
    if (options.failStart) throw new Error('session.start failed')
    return { cwd: e.cwd }
  })
  on('session.end', () => {
    reach('session.end')
    return { sessionId: 'engine-session' }
  })
  on('session.compact', () => {
    reach('session.compact')
    return { skip: 'engine skip' }
  })
  on('prompt.submit', (_, e) => {
    reach('prompt.submit')
    return { text: `engine: ${e.text}` }
  })
  on('turn.start', () => {
    reach('turn.start')
    return { turnId: 'engine-turn' }
  })
  on('turn.complete', () => {
    reach('turn.complete')
    return { text: 'engine summary' }
  })
  on('tool.call', () => {
    reach('tool.call')
    return { result: { text: 'engine result' } }
  })
  on('tool.check', () => {
    reach('tool.check')
    return { decision: 'allow' }
  })
  on('skill.prompt', () => {
    reach('skill.prompt')
    return { text: 'engine skill text' }
  })
  on('agent.spawn', () => {
    reach('agent.spawn')
    return { model: 'haiku', agentId: 'engine-agent' }
  })
  on('classic.SessionStart', () => {
    reach('classic.SessionStart')
    return {}
  })
  on('classic.PreCompact', () => {
    reach('classic.PreCompact')
    return {}
  })
  on('classic.PostCompact', () => {
    reach('classic.PostCompact')
    return {}
  })
  on('classic.Stop', () => {
    reach('classic.Stop')
    return {}
  })
  on('classic.TaskCompleted', () => {
    reach('classic.TaskCompleted')
    return {}
  })
  return world
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

/** The self-check record now in the store, if any. */
export function selfCheck(world: World, key = SELF_CHECK_KEY): SelfCheckRecord | undefined {
  return world.saved.get(key) as SelfCheckRecord | undefined
}

/**
 * Waits until a saved self-check record passes `test`. Saves run after the
 * hook that caused them has answered, so a test waits for them here.
 */
export function untilSaved(
  world: World,
  test: (record: SelfCheckRecord) => boolean,
  key = SELF_CHECK_KEY,
): Promise<SelfCheckRecord> {
  return new Promise(resolve => {
    const check = (): void => {
      const record = selfCheck(world, key)
      if (record && test(record)) resolve(record)
      else world.onWrite.push(check)
    }
    check()
  })
}

/** Waits until the saved record lists every one of `events`. */
export function untilSeen(world: World, ...events: WatchedEvent[]): Promise<SelfCheckRecord> {
  return untilSaved(world, record => events.every(event => record.seen.includes(event)))
}
