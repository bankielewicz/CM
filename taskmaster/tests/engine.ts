import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SelfCheckRecord } from '../types'

export const BUILD = '2.1.317'
export const SELF_CHECK_KEY = `self-check/${BUILD}`

export type World = {
  /** What the mod's `$.store` holds. */
  saved: Map<string, unknown>
  /** Every `$.store.set`, in order. */
  writes: string[]
  /** Every status line, toast or band the mod asked for. */
  shown: string[]
}

export type EngineOptions = {
  /** What the store holds before the session starts. */
  seed?: Record<string, unknown>
  /** Every store call fails, as a broken store would. */
  storeFails?: boolean
}

// Nothing sits beneath the plugin in a test: these hooks stand for the
// engine, answering each call the mod makes on `$`.
export function engine(on: On, options: EngineOptions = {}): World {
  const world: World = { saved: new Map(Object.entries(options.seed ?? {})), writes: [], shown: [] }
  mock.clock(on, { now: 1_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: BUILD, base: BUILD, builtAt: '2026-01-01T00:00:00Z' } }))
  on('store.get', (_, e) => {
    if (options.storeFails) throw new Error('store unavailable')
    return { value: world.saved.get(e.key) }
  })
  on('store.set', (_, e) => {
    if (options.storeFails) throw new Error('store unavailable')
    world.saved.set(e.key, e.value)
    world.writes.push(e.key)
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
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: { text: 'engine result' } }))
  on('classic.Stop', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.PreCompact', () => ({}))
  on('classic.PostCompact', () => ({}))
  on('classic.TaskCompleted', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('session.compact', () => ({ skip: 'not in a test' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  return world
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

export function selfCheck(world: World): SelfCheckRecord {
  return world.saved.get(SELF_CHECK_KEY) as SelfCheckRecord
}
