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
  | 'classic.SubagentStop'
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
  | 'turn.step'

/**
 * What the self-check keeps in `$.store`, one record per Claude Code build:
 * the events seen on that build, across sessions, and the settings of the last
 * session to save it on this machine.
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
  version: () => Promise<string>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}

/** Which loop a skill belongs to: the main loop, a subagent, or one the mod couldn't tell (P1.1). */
export type SkillLoop = { kind: 'main' } | { kind: 'agent'; agentId: string } | { kind: 'unknown' }

/**
 * How the loop was worked out: an open Skill tool call, a typed `/name` being
 * submitted, a subagent just spawned with the skill preloaded, or none of them.
 */
export type SkillVia = 'skill-tool' | 'typed' | 'agent-preload' | 'unattributed'

/**
 * A skill as it loaded (plan F1.1): what `skill.prompt` gave, a content hash, and
 * its loop. Not its text, which can hold the words of a typed command: a hook has
 * that as `e.text`, and later the file at `path` has the skill itself.
 */
export type SkillCapture = {
  skill: string
  frontmatter: Readonly<Record<string, unknown>>
  frontmatterProblem?: string
  source: string
  pluginName?: string
  path?: string
  /**
   * SHA-256 of the text as `skill.prompt` gave it, as hex. It changes with the
   * skill's folder and with every argument, so it isn't a cache key: P1.4 and
   * P1.15 hash the body.
   */
  hash: string
  loop: SkillLoop
  via: SkillVia
  /** When it was recorded, just after it loaded, from `$.clock.now()`. */
  at: number
}

/** A step the deterministic parse found (P1.2). */
export type ParsedStep = {
  /** `S1`, `S2`, … in document order. */
  id: string
  title: string
  /** Where it came from: a "Step N" or numbered heading, an ordered list item, or a checklist item. */
  kind: 'heading' | 'numbered' | 'checklist'
  /** 1-based line in the skill text as `skill.prompt` gave it. */
  line: number
}

/** A MUST, NEVER or ALWAYS line outside code (P1.2). */
export type ParsedRule = { kind: 'MUST' | 'NEVER' | 'ALWAYS'; text: string; line: number }

/** A test, lint, build or typecheck command in a shell code block: a candidate verify spec (P1.2). */
export type VerifyCandidate = {
  command: string
  line: number
  /** The step whose text holds the command, when there is one. */
  step?: string
}

/** What the deterministic parse reads from a skill (plan F1.2): no model, the same answer every time. */
export type ParsedSkill = {
  name?: string
  description?: string
  allowedTools: string[]
  /** `context: fork` in the frontmatter. */
  forked: boolean
  /** False when the frontmatter has `disable-model-invocation: true`. */
  modelInvocable: boolean
  steps: ParsedStep[]
  rules: ParsedRule[]
  verifyCandidates: VerifyCandidate[]
}

declare module 'claude-code' {
  interface PluginState {
    taskmaster: {
      /** The skills loaded this session, newest last, at most 20. */
      skills: Shaped<SkillCapture[]>
    }
  }
}
