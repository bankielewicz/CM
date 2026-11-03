// The taskmaster mod's own types: the one place they are written.

export type Strictness = 'observe' | 'advisory' | 'enforce' | 'strict'

/**
 * The Phase 1 settings (plan F12), as the hooks read them. Each key is a
 * `userConfig` field in plugin.json with the same default.
 */
export type Config = {
  strictness: Strictness
  maxStopBlocks: number
  exemptSkills: readonly string[]
  checkpointDir: string
  checkpointGit: 'commit' | 'ignore'
  checkpointPush: 'off' | 'milestone'
  checkpointEveryWrites: number
  contextCheckpointPercent: number
  resumePolicy: 'offer' | 'auto' | 'off'
  metrics: boolean
  metricsDir: string
  ratingSample: number
  experiment: 'off' | 'on'
  experimentWeights: string
  experimentBlind: boolean
  rca: 'manual' | 'off'
  rcaModel: string
  rcaDailyCap: number
  circuitBreakerThreshold: number
  overrideDir: string
}

/** The events the mod depends on, which the startup self-check watches for (plan F14). */
export type WatchedEvent =
  | 'agent.spawn'
  | 'classic.PostCompact'
  | 'classic.PreCompact'
  | 'classic.SessionStart'
  | 'classic.Stop'
  | 'classic.TaskCompleted'
  | 'prompt.submit'
  | 'session.compact'
  | 'session.end'
  | 'session.start'
  | 'skill.prompt'
  | 'tool.call'
  | 'tool.check'
  | 'turn.complete'
  | 'turn.start'

/**
 * What the self-check keeps in `$.store`, one record per Claude Code build:
 * the events seen on that build, across sessions, and the settings in force.
 */
export type SelfCheckRecord = {
  schema: 1
  build: string
  seen: WatchedEvent[]
  config: Config
  updatedAt: number
}

/**
 * The engine calls helpers use. A mod can't pass `$` around, so session.start
 * builds this table of closures, each spelled `$.noun.method(...)` there.
 */
export type Io = {
  now: () => Promise<number>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}
