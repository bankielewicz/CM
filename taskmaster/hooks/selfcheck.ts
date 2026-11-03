// The startup self-check (plan F14). The mod API is early access and changes
// between builds, so the mod records which of the events it depends on fire
// on this build. It keeps one record per build in $.store, which every
// session on this machine shares, and adds the events each session sees.
//
// It's diagnostic only, so it never holds an event up: note() returns at
// once, and saves run afterwards, one at a time. Each save reads the stored
// record and merges it before writing, so it keeps what other sessions saved
// meanwhile. A save whose read fails writes nothing, so a broken read can't
// replace the history with this session's events alone. (Two sessions that
// save in the same instant can still race; the store has no compare-and-set.)

import type { Config, Io, SelfCheckRecord, WatchedEvent } from '../types'

export const WATCHED = [
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
] as const satisfies readonly WatchedEvent[]

// Fails the typecheck if WatchedEvent names an event WATCHED leaves out.
export const WATCHES_EVERY_EVENT: [Exclude<WatchedEvent, (typeof WATCHED)[number]>] extends [never] ? true : never = true

/** The build name the record is kept under when the engine can't say which build this is. */
export const UNKNOWN_BUILD = 'unknown'

export const selfCheckKey = (build: string): string => `self-check/${build}`

const isWatched = (name: unknown): name is WatchedEvent => (WATCHED as readonly unknown[]).includes(name)

/** The events a stored record lists, if it's a record of this schema for this build. */
export function storedEvents(value: unknown, build: string): WatchedEvent[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Partial<SelfCheckRecord>
  if (record.schema !== 1 || record.build !== build || !Array.isArray(record.seen)) return []
  return record.seen.filter(isWatched)
}

type Started = { io: Io; build: Promise<string>; config: Config }

export class SelfCheck {
  private readonly seen = new Set<WatchedEvent>()
  // Unset until session.start: events noted before it wait in `seen`.
  private started: Started | undefined
  // The save in flight, and whether another must follow it.
  private saving: Promise<void> | undefined
  private again = false

  /** Notes an event. The first time this session sees it, a save is queued. */
  note(event: WatchedEvent): void {
    if (this.seen.has(event)) return
    this.seen.add(event)
    this.queue()
  }

  /** At session.start: from here on events are saved, starting with the ones noted before it. */
  start(io: Io, config: Config): void {
    // One lookup per session.start, so every save from it uses one key.
    this.started = { io, build: io.version().catch(() => UNKNOWN_BUILD), config }
    this.queue()
  }

  // One save at a time. A note made while one runs asks for one more, which
  // runs after it and saves the latest events.
  private queue(): void {
    const started = this.started
    if (!started) return
    if (this.saving) {
      this.again = true
      return
    }
    this.saving = (async () => {
      do {
        this.again = false
        await this.save(started)
      } while (this.again)
      this.saving = undefined
    })()
  }

  private async save({ io, build: lookup, config }: Started): Promise<void> {
    const build = await lookup
    const key = selfCheckKey(build)
    let stored: unknown
    try {
      stored = await io.storeGet(key)
    } catch {
      // Without the stored record a write would drop what other sessions saw,
      // so write nothing. The next new event tries again.
      return
    }
    for (const event of storedEvents(stored, build)) this.seen.add(event)
    try {
      const record: SelfCheckRecord = { schema: 1, build, seen: [...this.seen].sort(), config, updatedAt: await io.now() }
      await io.storeSet(key, record)
    } catch {
      // This write is lost; the next new event's save carries the same events.
    }
  }
}
