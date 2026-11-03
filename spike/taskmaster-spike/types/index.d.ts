export type CheckStatus = 'pending' | 'pass' | 'fail' | 'info'

export type CheckId =
  | 'stop-block'
  | 'subagent-stop-block'
  | 'deny-write'
  | 'deny-write-subagent'
  | 'deny-complete'
  | 'taskcompleted-block'
  | 'seed-task'
  | 'tasklist-persist'
  | 'sessionstart-source'
  | 'compaction-events'
  | 'check-call-order'
  | 'readonly-query'
  | 'skill-attribution'
  | 'plugin-skills-folder'
  | 'git-commit-only'
  | 'journal-budget'

export type Check = { status: CheckStatus; evidence: string; updatedAt: number }

export type Checks = { [K in CheckId]?: Check }

export type Counters = {
  events: number
  toolCalls: number
  skills: number
  stops: number
  flushes: number
  rolls: number
}

declare module 'claude-code' {
  interface PluginState {
    'taskmaster-spike': {
      checks: Shaped<Checks>
      counters: Shaped<Counters>
    }
  }
}
