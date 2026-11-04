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
  /** The latest value the mod wrote under each `$.state` key, as `plugin/key`. */
  state: Map<string, unknown>
  /** Every `$.ui.log` line, with where it was sent. */
  logs: { text: string; to: string }[]
  /** True once `holdFirstStateWrite` is holding a write. */
  stateHeld: boolean
  /** Lets the first `$.state` write finish, when `holdFirstStateWrite` held it. */
  releaseState: () => void
  /** Called after each `$.state` write and each `$.ui.log` line. */
  onChange: (() => void)[]
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
  /**
   * Runs inside the engine's answer to these events, before it answers: the
   * engine expanding a skill while a Skill call, a typed command or a spawn is
   * still open. Each gets the event's input.
   */
  during?: {
    toolCall?: (e: { tool: string; agentId?: string }) => Promise<unknown>
    promptSubmit?: (e: { text: string }) => Promise<unknown>
    agentSpawn?: () => Promise<unknown>
  }
  /** The agent id each `agent.spawn` answers with, in turn; `null` denies that spawn. */
  spawnAgentIds?: (string | null)[]
  /** Every `$.state` write waits forever, as a hung engine would. */
  hangStateWrites?: boolean
  /** The first `$.state` write waits until `world.releaseState()`. */
  holdFirstStateWrite?: boolean
  /**
   * `$.clock.now()` fails, which makes a capture fail. A `$.state` write can't be
   * made to fail here: beneath `$.state` the kit answers, so a hook that throws is
   * skipped and the write goes on, and a `{ deny }` fails the test itself.
   */
  failClock?: boolean
  /** What `$.state` holds at the start, by `plugin/key`, as a reload would leave it. */
  seedState?: Record<string, unknown>
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
  let heldState = options.holdFirstStateWrite ?? false
  let releaseState: () => void = () => {}
  const stateReleased = new Promise<void>(resolve => {
    releaseState = resolve
  })
  const world: World = {
    saved: new Map(Object.entries(options.seed ?? {})),
    writes: [],
    shown: [],
    reached: [],
    release: () => release(),
    onWrite: [],
    state: new Map(),
    logs: [],
    stateHeld: false,
    releaseState: () => releaseState(),
    onChange: [],
  }
  const reach = (event: WatchedEvent): void => {
    world.reached.push(event)
  }
  const changed = (): void => {
    for (const listener of world.onChange.splice(0)) listener()
  }

  if (options.failClock) {
    on('clock.now', () => {
      throw new Error('clock unavailable')
    })
  } else {
    mock.clock(on, { now: 1_000 })
  }
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
  on('ui.log', (_, e) => {
    const to = e.to ?? 'transcript'
    world.logs.push({ text: e.text, to })
    // A line in the transcript is something the person sees.
    if (to !== 'debug') world.shown.push(`log: ${e.text}`)
    changed()
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
  on('prompt.submit', async (_, e) => {
    reach('prompt.submit')
    await options.during?.promptSubmit?.(e)
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
  on('tool.call', async (_, e) => {
    reach('tool.call')
    await options.during?.toolCall?.(e)
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
  const spawnIds = [...(options.spawnAgentIds ?? [])]
  on('agent.spawn', async () => {
    reach('agent.spawn')
    await options.during?.agentSpawn?.()
    const agentId = spawnIds.length > 0 ? spawnIds.shift() : 'engine-agent'
    if (agentId === null) return { deny: 'engine refused the spawn' }
    return { model: 'haiku', agentId }
  })
  // A test's `$` has no state noun, so the mod's state is read from its writes.
  on('state.set', async (_, e, next) => {
    if (options.hangStateWrites) await new Promise<never>(() => {})
    if (heldState) {
      heldState = false
      world.stateHeld = true
      changed()
      await stateReleased
    }
    world.state.set(`${e.plugin}/${e.key}`, e.value)
    changed()
    return next(e)
  })
  on('state.get', (_, e, next) => {
    const seeded = options.seedState?.[`${e.plugin}/${e.key}`]
    // Only until the mod writes, as a value that a reload kept.
    if (seeded === undefined || world.state.has(`${e.plugin}/${e.key}`)) return next(e)
    return { value: { value: seeded, version: 0 } } as never
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
  on('classic.SubagentStop', () => {
    reach('classic.SubagentStop')
    return {}
  })
  on('turn.step', async function* (_, e) {
    reach('turn.step')
    yield { kind: 'text', index: 0, text: 'engine chunk' }
    return { turnId: e.turnId, index: e.index, answer: 'engine step', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return world
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

/** A model request, in the loop `agentId` names, read to its end. Gives the chunks and what the step answered. */
export async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const chunks: unknown[] = []
  let read = await stream.next()
  while (!read.done) {
    chunks.push(read.value)
    read = await stream.next()
  }
  return { chunks, answer: read.value }
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

/**
 * Waits until `test` passes. A capture and its log line come after the hook has
 * answered, so a test waits for them here. It's checked after each `$.state`
 * write and each `$.ui.log` line.
 */
export function until(world: World, test: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const check = (): void => {
      if (test()) resolve()
      else world.onChange.push(check)
    }
    check()
  })
}

/**
 * The latest value the mod wrote under a `$.state` key (`plugin/key`). A
 * value written through an atom with a `shape` is stored as `{ shape, value }`,
 * so it is unwrapped here.
 */
export function stateValue(world: World, key: string): unknown {
  const written = world.state.get(key)
  if (typeof written === 'object' && written !== null && 'shape' in written && 'value' in written) {
    return (written as { value: unknown }).value
  }
  return written
}
