// The startup self-check (plan F14). The mod API is early access and changes
// between builds, so the mod records which of the events it depends on fire
// on this build. It keeps one record per build in $.store, adding the events
// each session sees. It's diagnostic only: a store that fails costs the
// record and nothing else.

import type { Config, Io, SelfCheckRecord, WatchedEvent } from '../types'

export const WATCHED: readonly WatchedEvent[] = [
  'agent.spawn',
  'classic.PostCompact',
  'classic.PreCompact',
  'classic.SessionStart',
  'classic.Stop',
  'classic.TaskCompleted',
  'prompt.submit',
  'session.compact',
  'session.end',
  'session.start',
  'skill.prompt',
  'tool.call',
  'tool.check',
  'turn.complete',
  'turn.start',
]

export const selfCheckKey = (build: string): string => `self-check/${build}`

const isWatched = (name: unknown): name is WatchedEvent => WATCHED.includes(name as WatchedEvent)

/** The events a stored record lists, if it's a record of this schema for this build. */
export function storedEvents(value: unknown, build: string): WatchedEvent[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Partial<SelfCheckRecord>
  if (record.schema !== 1 || record.build !== build || !Array.isArray(record.seen)) return []
  return record.seen.filter(isWatched)
}

type Started = { io: Io; build: string; config: Config }

export class SelfCheck {
  private readonly seen = new Set<WatchedEvent>()
  // Unset until session.start: events noted before it wait in `seen`.
  private started: Started | undefined

  /** Notes an event, and saves the record the first time this session sees it. */
  async note(event: WatchedEvent): Promise<void> {
    if (this.seen.has(event)) return
    this.seen.add(event)
    if (this.started) await this.save(this.started)
  }

  /** At session.start: merges what earlier sessions saw on this build, then saves, flushing what was buffered. */
  async start(io: Io, build: string, config: Config): Promise<void> {
    const started = { io, build, config }
    this.started = started
    try {
      for (const event of storedEvents(await io.storeGet(selfCheckKey(build)), build)) this.seen.add(event)
    } catch {
      // Diagnostic only: start from this session's events.
    }
    await this.save(started)
  }

  private async save({ io, build, config }: Started): Promise<void> {
    try {
      const record: SelfCheckRecord = { schema: 1, build, seen: [...this.seen].sort(), config, updatedAt: await io.now() }
      await io.storeSet(selfCheckKey(build), record)
    } catch {
      // Diagnostic only: the record is lost, every event still passes through.
    }
  }
}
