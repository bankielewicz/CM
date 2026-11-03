// An append-only event journal over $.fs, which has no append: each chunk is
// rewritten whole, and a chunk rolls over at MAX_LINES or MAX_BYTES. Every
// write is timed, so the spike can say whether journaling fits the budget.
//
// A mod may not pass `$` around, so the journal is handed the three engine
// calls it needs as plain functions.

export type JournalEvent = { kind: string } & Record<string, unknown>

export type JournalIo = {
  now: () => Promise<number>
  write: (path: string, text: string) => Promise<void>
  after: (ms: number, fn: () => void) => void
}

const MAX_LINES = 500
const MAX_BYTES = 256 * 1024
const FLUSH_DELAY_MS = 400

export type JournalStats = {
  flushes: number
  p50: number
  p95: number
  max: number
  rolls: number
  chunk: number
}

export class Journal {
  private lines: string[] = []
  private bytes = 0
  private chunk = 0
  private seq = 0
  private isScheduled = false
  private writing: Promise<void> = Promise.resolve()
  private readonly flushMs: number[] = []
  private rolls = 0

  constructor(
    private readonly io: JournalIo,
    private readonly prefix: string,
  ) {}

  private pathOf(chunk: number): string {
    return `${this.prefix}-${String(chunk).padStart(3, '0')}.jsonl`
  }

  add(event: JournalEvent, ts: number): number {
    this.seq += 1
    const line = JSON.stringify({ seq: this.seq, ts, ...event })

    if (this.lines.length >= MAX_LINES || this.bytes + line.length > MAX_BYTES) {
      this.roll()
    }

    this.lines.push(line)
    this.bytes += line.length + 1
    this.schedule()

    return this.seq
  }

  private roll(): void {
    if (this.lines.length > 0) {
      void this.enqueue(this.pathOf(this.chunk), this.lines)
      this.rolls += 1
    }
    this.chunk += 1
    this.lines = []
    this.bytes = 0
  }

  private schedule(): void {
    if (this.isScheduled) {
      return
    }
    this.isScheduled = true
    this.io.after(FLUSH_DELAY_MS, () => {
      this.isScheduled = false
      void this.flush()
    })
  }

  flush(): Promise<void> {
    if (this.lines.length === 0) {
      return this.writing
    }
    return this.enqueue(this.pathOf(this.chunk), this.lines.slice())
  }

  private enqueue(path: string, lines: readonly string[]): Promise<void> {
    this.writing = this.writing.then(async () => {
      const started = await this.io.now()
      try {
        await this.io.write(path, `${lines.join('\n')}\n`)
      } catch {
        // A failed write must never break a session; the stats show it.
      }
      const ended = await this.io.now()
      this.flushMs.push(ended - started)
      if (this.flushMs.length > 500) {
        this.flushMs.shift()
      }
    })
    return this.writing
  }

  stats(): JournalStats {
    const sorted = [...this.flushMs].sort((a, b) => a - b)
    const at = (q: number): number =>
      sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0)

    return {
      flushes: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
      rolls: this.rolls,
      chunk: this.chunk,
    }
  }
}
