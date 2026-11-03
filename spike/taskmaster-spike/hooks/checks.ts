// The Gate A checklist: what each check answers, how to run it, and how the
// results read as a status listing and as the FINDINGS.md report.

import type { CheckId, CheckStatus, Checks } from '../types'

export type CheckInfo = {
  id: CheckId
  title: string
  /** The plan item it answers (Phase 0 list / Gate A table). */
  answers: string
  /** How to produce evidence: automatic, or the probe to run. */
  how: string
  /** What the plan does if this fails. */
  ifFails: string
  /** Whether a fail here is a no-go for enforcement. */
  isBlocking: boolean
}

export const CHECKS: readonly CheckInfo[] = [
  {
    id: 'stop-block',
    title: 'Stop block makes Claude continue (main loop)',
    answers: 'Phase 0 #5 · Gate A row 1',
    how: '/tm-spike probe stop-block, then send any prompt',
    ifFails: 'No-go for enforcement: pivot to the advisory report-card mod',
    isBlocking: true,
  },
  {
    id: 'subagent-stop-block',
    title: 'SubagentStop block makes a subagent continue',
    answers: 'G4 feasibility',
    how: '/tm-spike probe subagent-stop-block, then ask Claude to run a subagent',
    ifFails: 'Drop G4; hold subagents only through the main Stop gate',
    isBlocking: false,
  },
  {
    id: 'deny-write',
    title: 'tool.call deny on a write tool (main loop)',
    answers: 'Gate A row 2',
    how: '/tm-spike probe deny-write, then ask Claude to write a file',
    ifFails: 'No-go for G1 and the Plan Gate; keep Stop-based enforcement only',
    isBlocking: true,
  },
  {
    id: 'deny-write-subagent',
    title: 'tool.call deny on a write tool (subagent)',
    answers: 'Gate A row 2',
    how: '/tm-spike probe deny-write-subagent, then ask Claude to have a subagent write a file',
    ifFails: 'Gates cover the main loop only; document the subagent gap',
    isBlocking: false,
  },
  {
    id: 'deny-complete',
    title: 'tool.call deny on TaskUpdate status=completed',
    answers: 'G1 primary mechanism',
    how: '/tm-spike probe deny-complete, then ask Claude to create a task and complete it',
    ifFails: 'Use the TaskCompleted block as the primary G1 mechanism',
    isBlocking: true,
  },
  {
    id: 'taskcompleted-block',
    title: 'classic.TaskCompleted block vetoes a completion',
    answers: 'G1 backstop',
    how: '/tm-spike probe taskcompleted-block, then ask Claude to create a task and complete it',
    ifFails: 'G1 relies on the TaskUpdate deny alone',
    isBlocking: false,
  },
  {
    id: 'seed-task',
    title: '$.tool.call(TaskCreate) seeds a task Claude sees',
    answers: 'Phase 0 #2 · Gate A row 3',
    how: '/tm-spike probe seed-task, then ask Claude to list its tasks',
    ifFails: 'Fallback: the footer tells Claude to create the tasks; the Plan Gate enforces it',
    isBlocking: false,
  },
  {
    id: 'tasklist-persist',
    title: 'Built-in task list across sessions',
    answers: 'Phase 0 #3 · Gate A row 4',
    how: 'Automatic: create a task, then start a new session (or /clear)',
    ifFails: 'Expected not to persist; the checkpoint rebuilds the list',
    isBlocking: false,
  },
  {
    id: 'sessionstart-source',
    title: 'SessionStart.source after /clear and after compaction',
    answers: 'Phase 0 #4 · Gate A row 5',
    how: 'Automatic: run /clear once and /compact once',
    ifFails: 'Adapt the resume triggers to the sources seen',
    isBlocking: false,
  },
  {
    id: 'compaction-events',
    title: 'Compaction events fire, and in what order',
    answers: 'F8.5 feasibility',
    how: 'Automatic: run /compact once',
    ifFails: 'Checkpoint from the events that do fire',
    isBlocking: false,
  },
  {
    id: 'check-call-order',
    title: 'Order of tool.check vs tool.call',
    answers: 'Phase 0 #1',
    how: 'Automatic: any tool use',
    ifFails: 'Informational: decides where the Plan Gate reads isReadOnly',
    isBlocking: false,
  },
  {
    id: 'readonly-query',
    title: '$.tool.check query exposes isReadOnly before a call runs',
    answers: 'Plan Gate classification',
    how: 'Automatic at session start, or /tm-spike probe readonly-query',
    ifFails: 'Plan Gate keeps a conservative write-tool list instead',
    isBlocking: false,
  },
  {
    id: 'skill-attribution',
    title: 'Skill loads attributed to a loop (main, subagent, preload, typed)',
    answers: 'Phase 0 #6',
    how: 'Use the spike-probe skill in the main loop and in a subagent (see RUNBOOK)',
    ifFails: 'Contracts stay main-loop only until attribution is solved',
    isBlocking: false,
  },
  {
    id: 'plugin-skills-folder',
    title: "A plugin's skills/ folder loads beside its hooks module",
    answers: 'Phase 0 #9',
    how: 'Ask Claude to use the spike-probe skill',
    ifFails: 'Ship the frontmatter advisor as the slash command only',
    isBlocking: false,
  },
  {
    id: 'git-commit-only',
    title: 'git add + commit --only leaves staged work untouched',
    answers: 'Phase 0 #7 · Gate A row 6',
    how: '/tm-spike probe git-commit-only (runs in a throwaway repo)',
    ifFails: 'Fallback: checkpointGit ignore, then ref mode',
    isBlocking: false,
  },
  {
    id: 'journal-budget',
    title: 'Journal writes and rollover fit the hook budget',
    answers: 'Phase 0 #8',
    how: '/tm-spike probe journal-stress',
    ifFails: 'Batch writes less often; move heavy writes to timers',
    isBlocking: false,
  },
]

const GLYPH: Record<CheckStatus | 'none', string> = {
  pass: '✓',
  fail: '✗',
  pending: '…',
  info: 'i',
  none: '·',
}

export function glyph(status: CheckStatus | undefined): string {
  return GLYPH[status ?? 'none']
}

export function formatStatus(checks: Checks): string {
  const done = CHECKS.filter(c => {
    const s = checks[c.id]?.status
    return s === 'pass' || s === 'fail' || s === 'info'
  }).length
  const rows = CHECKS.map(c => {
    const check = checks[c.id]
    const line = check ? check.evidence : `not run · ${c.how}`
    return `${glyph(check?.status)} ${c.id.padEnd(22)} ${line}`
  })
  return [
    `Taskmaster spike · ${done}/${CHECKS.length} checks answered`,
    '',
    ...rows,
    '',
    'Probes: /tm-spike probe <stop-block|subagent-stop-block|deny-write|deny-write-subagent|deny-complete|taskcompleted-block|seed-task|readonly-query|git-commit-only|journal-stress>',
    'Report: /tm-spike report  ·  Pane: /tm-spike pane',
  ].join('\n')
}

export function gateVerdict(checks: Checks): string {
  const blocking = CHECKS.filter(c => c.isBlocking)
  const failed = blocking.filter(c => checks[c.id]?.status === 'fail')
  const open = blocking.filter(c => checks[c.id]?.status !== 'pass' && checks[c.id]?.status !== 'fail')

  if (failed.length > 0) {
    return `NO-GO for part of enforcement: ${failed.map(c => `${c.id} (${c.ifFails})`).join('; ')}`
  }
  if (open.length > 0) {
    return `Undecided: blocking checks still open: ${open.map(c => c.id).join(', ')}`
  }
  return 'GO: every blocking check passed. Apply the fallbacks listed for any non-blocking check that failed.'
}

export function formatReport(
  checks: Checks,
  facts: { version: string; generatedAt: string; sessions: number },
): string {
  const escape = (text: string): string => text.replace(/\|/g, '\\|')
  const rows = CHECKS.map(c => {
    const check = checks[c.id]
    const status = check ? `${glyph(check.status)} ${check.status}` : '· not run'
    const evidence = check ? escape(check.evidence) : escape(`Run: ${c.how}`)
    return `| ${c.id} | ${escape(c.title)} | ${status} | ${evidence} | ${escape(c.ifFails)} |`
  })

  return [
    '# Taskmaster Phase 0 spike: findings',
    '',
    `Generated ${facts.generatedAt} on Claude Code ${facts.version}, across ${facts.sessions} session(s).`,
    '',
    `**Gate A verdict:** ${gateVerdict(checks)}`,
    '',
    '| Check | What it answers | Result | Evidence | If it fails |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Blocking checks (a fail is a no-go for that part of enforcement): ' +
      CHECKS.filter(c => c.isBlocking)
        .map(c => c.id)
        .join(', '),
    '',
  ].join('\n')
}
