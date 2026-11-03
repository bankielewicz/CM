// Taskmaster Phase 0 spike.
//
// Observe-only by default: every hook passes the event on unchanged and
// journals what it saw to .taskmaster/spike/. Probes are opt-in, armed with
// /tm-spike probe <name>, and each fires once. The results answer the Gate A
// checks in docs/taskmaster-plan.md §10.1.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, ToolCallArgs, ToolCallResult } from 'claude-code'

import type { Check, CheckId, CheckStatus, Checks, Counters } from '../types'
import { CHECKS, formatReport, formatStatus, glyph } from './checks'
import { Journal } from './journal'
import type { JournalEvent, JournalIo } from './journal'
import { asRecord, asString, clip, MARK, shortHash } from './util'

const PLUGIN = 'taskmaster-spike'
const PANE = 'tm-spike'
const DIR = '.taskmaster/spike'
const FINDINGS = `${DIR}/findings.json`
const REPORT = `${DIR}/FINDINGS.md`
const SKILL = 'spike-probe'

const checksAtom = atom({ plugin: 'taskmaster-spike', key: 'checks' } as const, {} as Checks, {
  shape: 'checks-1',
})
const countersAtom = atom(
  { plugin: 'taskmaster-spike', key: 'counters' } as const,
  { events: 0, toolCalls: 0, skills: 0, stops: 0, flushes: 0, rolls: 0 } as Counters,
  { shape: 'counters-1' },
)

type ProbeName =
  | 'stop-block'
  | 'subagent-stop-block'
  | 'deny-write'
  | 'deny-write-subagent'
  | 'deny-complete'
  | 'taskcompleted-block'

type Probe = { firedAt?: number; agentId?: string; taskId?: string; tool?: string }

type TaskMark = { id: string; subject: string }

type Snapshot = { sessionId: string; tasks: TaskMark[]; at: number }

type Findings = {
  schema: 1
  checks: Checks
  sources: string[]
  snapshots: Snapshot[]
  attribution: Record<string, number>
  sessions: string[]
}

type OpenCall = { tool: string; agentId?: string; skill?: string; seq: number }

// A mod may not pass `$` around, so session.start builds this table of the
// engine calls the helpers need, each one spelled `$.noun.method(...)` there.
type Io = JournalIo & {
  read: (path: string) => Promise<string>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  status: (text: string) => void
  setChecks: (checks: Checks) => Promise<void>
  setCounters: (counters: Counters) => Promise<void>
  toolCall: (input: ToolCallArgs) => Promise<ToolCallResult>
  toolCheck: (input: Parameters<EngineInterface['tool']['check']>[0]) => Promise<unknown>
  run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessRunResult>
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

const PROBE_HELP: Record<ProbeName, string> = {
  'stop-block':
    'Armed. Send Claude any prompt (for example "say hi"). The mod blocks its next stop once; Claude should continue and reply SPIKE-CONTINUED.',
  'subagent-stop-block':
    'Armed. Ask Claude: "Use a subagent to read docs/taskmaster-plan.md and summarise it in one line." The mod blocks that subagent\'s stop once.',
  'deny-write':
    'Armed. Ask Claude: "Create a file named spike-deny-test.txt containing hello." The mod denies that write once.',
  'deny-write-subagent':
    'Armed. Ask Claude: "Use a subagent to create a file named spike-deny-sub.txt containing hello." The mod denies that subagent\'s write once.',
  'deny-complete':
    'Armed. Ask Claude: "Create a task called spike test, mark it in progress, then mark it completed." The mod denies the completion once.',
  'taskcompleted-block':
    'Armed. Ask Claude: "Create a task called spike backstop, mark it in progress, then mark it completed." The mod blocks the TaskCompleted event once.',
}

const IMMEDIATE_PROBES = ['seed-task', 'readonly-query', 'git-commit-only', 'journal-stress'] as const

export const register: Register = on => {
  // Module state is lost on a hot reload, so what matters is persisted to
  // findings.json and loaded again at session.start.
  let io: Io | undefined
  let journal: Journal | undefined
  const early: { event: JournalEvent; ts: number }[] = []
  let sessionId = ''
  let version = 'unknown'
  let findings: Findings = { schema: 1, checks: {}, sources: [], snapshots: [], attribution: {}, sessions: [] }
  const probes = new Map<ProbeName, Probe>()
  const openCalls = new Map<string, OpenCall>()
  const order = { inside: 0, before: 0, sampled: 0 }
  const queryResults: Record<string, boolean> = {}
  let pendingQuery: string | undefined
  const openSpawns = new Set<string>()
  let lastSpawnSeq = -100
  let lastTyped: { name: string; seq: number } | undefined
  let seeded: TaskMark | undefined
  let currentTasks: TaskMark[] = []
  const compactSeen: string[] = []
  let lastBucket = -1
  let counters: Counters = { events: 0, toolCalls: 0, skills: 0, stops: 0, flushes: 0, rolls: 0 }

  // ---------------------------------------------------------------- helpers

  async function log(event: JournalEvent): Promise<number> {
    counters = { ...counters, events: counters.events + 1 }
    const tagged = { sid: sessionId.slice(0, 8), ...event }
    if (!io || !journal) {
      early.push({ event: tagged, ts: 0 })
      return -1
    }
    return journal.add(tagged, await io.now())
  }

  async function saveFindings(): Promise<void> {
    if (!io) {
      return
    }
    try {
      await io.write(FINDINGS, `${JSON.stringify(findings, null, 2)}\n`)
      await io.storeSet('findings', findings)
    } catch {
      // Findings stay in memory; the next save tries again.
    }
  }

  async function loadFindings(): Promise<void> {
    if (!io) {
      return
    }
    let loaded: unknown
    try {
      loaded = JSON.parse(await io.read(FINDINGS))
    } catch {
      loaded = await io.storeGet('findings')
    }
    const record = asRecord(loaded)
    if (record.schema === 1) {
      findings = {
        schema: 1,
        checks: asRecord(record.checks) as Checks,
        sources: Array.isArray(record.sources) ? record.sources.map(String) : [],
        snapshots: Array.isArray(record.snapshots) ? (record.snapshots as Snapshot[]) : [],
        attribution: asRecord(record.attribution) as Record<string, number>,
        sessions: Array.isArray(record.sessions) ? record.sessions.map(String) : [],
      }
    }
    await io.setChecks(findings.checks)
  }

  async function setCheck(id: CheckId, status: CheckStatus, evidence: string): Promise<void> {
    const check: Check = { status, evidence: clip(evidence, 400), updatedAt: io ? await io.now() : 0 }
    findings = { ...findings, checks: { ...findings.checks, [id]: check } }
    await io?.setChecks(findings.checks)
    await log({ kind: 'check', id, status, evidence: check.evidence })
    refreshStatus()
    await saveFindings()
  }

  function refreshStatus(): void {
    const answered = CHECKS.filter(c => {
      const s = findings.checks[c.id]?.status
      return s === 'pass' || s === 'fail' || s === 'info'
    }).length
    const armed = [...probes.entries()]
      .map(([name, p]) => `${name}${p.firedAt === undefined ? '' : '*'}`)
      .join(',')
    io?.status(
      `tm-spike ${answered}/${CHECKS.length} checks · ${counters.events} events${armed ? ` · armed: ${armed}` : ''}`,
    )
  }

  async function pushCounters(): Promise<void> {
    const stats = journal?.stats()
    counters = { ...counters, flushes: stats?.flushes ?? 0, rolls: stats?.rolls ?? 0 }
    await io?.setCounters(counters)
  }

  function digest(input: Record<string, unknown>, tool: string): string {
    switch (tool) {
      case 'Bash':
        return clip(asString(input.command), 100)
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        return clip(asString(input.file_path) || asString(input.notebook_path), 100)
      case 'Skill':
        return asString(input.skill)
      case 'TaskCreate':
        return clip(asString(input.subject), 60)
      case 'TaskUpdate':
        return `${asString(input.taskId)}:${asString(input.status)}`
      case 'Agent':
        return asString(input.subagent_type) || 'general'
      case 'Grep':
      case 'Glob':
        return clip(asString(input.pattern), 60)
      default:
        return ''
    }
  }

  function taskMarks(result: unknown): TaskMark[] {
    const tasks = asRecord(result).tasks
    if (!Array.isArray(tasks)) {
      return []
    }
    return tasks.map(t => ({ id: asString(asRecord(t).id), subject: asString(asRecord(t).subject) }))
  }

  function rememberTasks(at: number): void {
    if (!sessionId) {
      return
    }
    const snapshot: Snapshot = { sessionId, tasks: currentTasks, at }
    const others = findings.snapshots.filter(s => s.sessionId !== sessionId)
    findings = { ...findings, snapshots: [...others, snapshot].slice(-10) }
  }

  function resultOf(answer: ToolCallResult): unknown {
    return 'result' in answer ? answer.result : undefined
  }

  async function taskStatus(taskId: string): Promise<string> {
    if (!io) {
      return 'unknown'
    }
    try {
      const got = await io.toolCall({ tool: 'TaskGet', taskId })
      return asString(asRecord(asRecord(resultOf(got)).task).status) || 'missing'
    } catch (err) {
      return `unknown (${String(err)})`
    }
  }

  async function snapshotAtStart(why: string): Promise<void> {
    if (!io) {
      return
    }
    let tasks: TaskMark[]
    try {
      tasks = taskMarks(resultOf(await io.toolCall({ tool: 'TaskList' })))
    } catch (err) {
      await log({ kind: 'snapshot.error', why, error: String(err) })
      return
    }
    const previous = findings.snapshots.filter(s => s.sessionId !== sessionId && s.tasks.length > 0).at(-1)
    currentTasks = tasks
    rememberTasks(await io.now())
    await log({ kind: 'snapshot', why, count: tasks.length })

    if (!previous) {
      await setCheck(
        'tasklist-persist',
        'pending',
        `No earlier session with tasks to compare yet (this one starts with ${tasks.length}). Create a task, then start a new session or run /clear.`,
      )
      return
    }
    const kept = previous.tasks.filter(p => tasks.some(t => t.id === p.id && t.subject === p.subject))
    await setCheck(
      'tasklist-persist',
      'info',
      kept.length > 0
        ? `PERSISTS: ${kept.length}/${previous.tasks.length} tasks from session ${previous.sessionId.slice(0, 8)} are listed in this session (${why}).`
        : `DOES NOT PERSIST: session ${previous.sessionId.slice(0, 8)} ended with ${previous.tasks.length} task(s); this session (${why}) starts with ${tasks.length}.`,
    )
  }

  async function probeReadOnlyQuery(): Promise<void> {
    if (!io) {
      return
    }
    const write = 'rm -rf ./taskmaster-spike-never-run'
    const samples = ['ls', 'git status', write]
    for (const command of samples) {
      pendingQuery = command
      queryResults[command] = false
      try {
        await io.toolCheck({ tool: 'Bash', input: { command } })
      } catch (err) {
        await log({ kind: 'readonly-query.error', command, error: String(err) })
      }
    }
    pendingQuery = undefined
    const reads = samples.filter(c => queryResults[c]).map(c => `"${c}"`)
    const isRight = queryResults.ls === true && queryResults[write] === false
    await setCheck(
      'readonly-query',
      isRight ? 'pass' : 'info',
      `isReadOnly on a $.tool.check query: ${reads.length > 0 ? `set for ${reads.join(', ')}` : 'never set'}; ` +
        `absent for the rm command: ${queryResults[write] === false ? 'yes' : 'no'}.`,
    )
  }

  async function probeGit(): Promise<string> {
    if (!io) {
      return 'git-commit-only: the session is not ready yet.'
    }
    const made = await io.run(['mktemp', '-d'])
    const dir = made.stdout.trim()
    if (made.exitCode !== 0 || !dir.startsWith('/')) {
      await setCheck('git-commit-only', 'fail', `mktemp failed: ${clip(made.stderr)}`)
      return 'git-commit-only: could not make a temporary folder.'
    }
    const run = io.run
    const write = io.write
    const git = (args: readonly string[]) => run(['git', ...args], { cwd: dir, timeoutMs: 15000 })
    try {
      const gitVersion = (await git(['--version'])).stdout.trim()
      await git(['init', '-q'])
      await git(['config', 'user.email', 'spike@example.invalid'])
      await git(['config', 'user.name', 'taskmaster-spike'])
      await write(`${dir}/a.txt`, 'a\n')
      await git(['add', 'a.txt'])
      await git(['commit', '-q', '-m', 'init'])
      await write(`${dir}/a.txt`, 'a\nuser change\n')
      await git(['add', 'a.txt'])
      await write(`${dir}/.taskmaster/checkpoint.json`, '{"spike":true}\n')

      const bare = await git(['commit', '--only', '-q', '-m', 'taskmaster: bare', '--', '.taskmaster/'])
      await git(['add', '--', '.taskmaster/'])
      const commit = await git(['commit', '--only', '-q', '-m', 'taskmaster: checkpoint spike', '--', '.taskmaster/'])
      const files = (await git(['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n').filter(Boolean)
      const staged = (await git(['diff', '--cached', '--name-only'])).stdout.trim().split('\n').filter(Boolean)

      const isPass =
        commit.exitCode === 0 && files.length === 1 && files[0] === '.taskmaster/checkpoint.json' && staged.includes('a.txt')
      const evidence =
        `${gitVersion}. "commit --only" on the untracked folder: exit ${bare.exitCode} (non-zero expected); ` +
        `"add" then "commit --only": exit ${commit.exitCode}; the commit holds [${files.join(', ')}]; still staged [${staged.join(', ')}].`
      await setCheck('git-commit-only', isPass ? 'pass' : 'fail', evidence)
      return `git-commit-only: ${isPass ? 'PASS' : 'FAIL'}. ${evidence}`
    } finally {
      if (/^\/(tmp|var\/folders|private\/var)\//.test(dir)) {
        await run(['rm', '-rf', dir])
      }
    }
  }

  async function probeJournal(): Promise<string> {
    if (!io) {
      return 'journal-stress: the session is not ready yet.'
    }
    const started = await io.now()
    const stress = new Journal(io, `${DIR}/stress-${started}`)
    for (let i = 0; i < 1200; i += 1) {
      stress.add({ kind: 'stress', i, pad: 'x'.repeat(180) }, started)
    }
    await stress.flush()
    const s = stress.stats()
    const live = journal?.stats()
    const isPass = s.rolls >= 2 && s.p95 <= 100 && s.max <= 1000
    const evidence =
      `stress: 1200 events, ${s.rolls} rollovers, ${s.flushes} writes, p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms` +
      (live ? `; live journal: ${live.flushes} writes, p95 ${live.p95} ms, max ${live.max} ms` : '') +
      '. Writes are $ calls, which do not count against the 10 s hook budget.'
    await setCheck('journal-budget', isPass ? 'pass' : 'fail', evidence)
    return `journal-stress: ${isPass ? 'PASS' : 'FAIL'}. ${evidence}`
  }

  async function seedTask(): Promise<string> {
    if (!io) {
      return 'seed-task: the session is not ready yet.'
    }
    try {
      const made = await io.toolCall({
        tool: 'TaskCreate',
        subject: '[spike] seeded by taskmaster-spike',
        description: 'Created by the taskmaster-spike seed-task probe. Safe to delete.',
      })
      const task = asRecord(asRecord(resultOf(made)).task)
      const id = asString(task.id)
      if (!id) {
        await setCheck('seed-task', 'fail', `TaskCreate from the mod returned no task id: ${clip(JSON.stringify(made), 200)}`)
        return 'seed-task: FAIL (no task id returned).'
      }
      seeded = { id, subject: asString(task.subject) }
      await setCheck(
        'seed-task',
        'pending',
        `Seeded task #${id}. Now ask Claude to "list your tasks"; this passes when Claude's own TaskList shows it.`,
      )
      return `seed-task: seeded task #${id}. Ask Claude to list its tasks.`
    } catch (err) {
      await setCheck('seed-task', 'fail', `$.tool.call(TaskCreate) rejected: ${String(err)}`)
      return `seed-task: FAIL (${String(err)}).`
    }
  }

  async function armProbe(name: string): Promise<string> {
    switch (name) {
      case 'seed-task':
        return seedTask()
      case 'readonly-query':
        await probeReadOnlyQuery()
        return `readonly-query: ${findings.checks['readonly-query']?.evidence ?? 'no result'}`
      case 'git-commit-only':
        return probeGit()
      case 'journal-stress':
        return probeJournal()
      case 'stop-block':
      case 'subagent-stop-block':
      case 'deny-write':
      case 'deny-write-subagent':
      case 'deny-complete':
      case 'taskcompleted-block':
        probes.set(name, {})
        await setCheck(name, 'pending', `Probe armed. ${PROBE_HELP[name]}`)
        return `${name}: ${PROBE_HELP[name]}`
      default:
        return `Unknown probe "${name}". Probes: ${[...Object.keys(PROBE_HELP), ...IMMEDIATE_PROBES].join(', ')}`
    }
  }

  async function writeReport(): Promise<void> {
    if (!io) {
      return
    }
    const text = formatReport(findings.checks, {
      version,
      generatedAt: new Date(await io.now()).toISOString(),
      sessions: findings.sessions.length,
    })
    await io.write(REPORT, text)
  }

  async function updateAttribution(via: string): Promise<void> {
    findings = { ...findings, attribution: { ...findings.attribution, [via]: (findings.attribution[via] ?? 0) + 1 } }
    const a = findings.attribution
    const counts = Object.entries(a)
      .map(([k, n]) => `${k} ×${n}`)
      .join(', ')
    const hasMain = (a['skill-tool:main'] ?? 0) > 0
    const hasSub = (a['skill-tool:subagent'] ?? 0) + (a['agent-preload'] ?? 0) > 0
    await setCheck(
      'skill-attribution',
      hasMain && hasSub ? 'pass' : 'info',
      `skill.prompt carries no agentId; attributed so far: ${counts}.` +
        (hasMain && hasSub ? '' : ' Still needed: a skill used in the main loop and one in a subagent (see RUNBOOK).'),
    )
  }

  async function noteCompaction(): Promise<void> {
    const hasAll =
      compactSeen.includes('PreCompact') && compactSeen.includes('session.compact') && compactSeen.includes('PostCompact')
    await setCheck(
      'compaction-events',
      hasAll ? 'pass' : 'info',
      `Order seen: ${compactSeen.join(' → ')}.` +
        (hasAll ? '' : ' Still needed: PreCompact, session.compact and PostCompact in one compaction (run /compact).'),
    )
  }

  async function noteSource(source: string): Promise<void> {
    if (!findings.sources.includes(source)) {
      findings = { ...findings, sources: [...findings.sources, source] }
    }
    const seen = findings.sources
    const hasBoth = seen.includes('clear') && seen.includes('compact')
    await setCheck(
      'sessionstart-source',
      hasBoth ? 'pass' : 'info',
      `Sources seen across sessions: ${seen.join(', ')}.` + (hasBoth ? '' : ' Still needed: run /clear once and /compact once.'),
    )
  }

  function noteSession(): void {
    if (sessionId && !findings.sessions.includes(sessionId)) {
      findings = { ...findings, sessions: [...findings.sessions, sessionId].slice(-50) }
    }
  }

  // ---------------------------------------------------------- session hooks

  on('session.start', async ($, e, next) => {
    io = {
      now: () => $.clock.now(),
      write: (path, text) => $.fs.write(path, text),
      after: (ms, fn) => {
        $.clock.after(ms, fn)
      },
      read: path => $.fs.read(path),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      status: text => $.ui.status(text),
      setChecks: async checks => {
        await update($, checksAtom, () => checks)
      },
      setCounters: async value => {
        await update($, countersAtom, () => value)
      },
      toolCall: input => $.tool.call(input),
      toolCheck: input => $.tool.check(input),
      run: (argv, init) => $.process.run(argv, init),
    }

    await $.command.register({
      name: 'tm-spike',
      description: 'Taskmaster Phase 0 spike: status, probes, report',
      argumentHint: '[status | probe <name> | report | pane | reset]',
    })
    const result = await next(e)

    sessionId = await $.session.id()
    version = (await $.session.version()).version
    const started = await $.clock.now()
    journal = new Journal(io, `${DIR}/journal-${sessionId.slice(0, 8)}-${started}`)
    for (const { event } of early.splice(0)) {
      journal.add(event, started)
    }
    await loadFindings()
    noteSession()

    try {
      await $.agent.register({
        name: 'skill-preload',
        description:
          'Taskmaster spike test agent. Use ONLY when the user explicitly asks for the taskmaster spike preload test.',
        prompt: `You are a test agent for the taskmaster-spike mod. Reply with exactly ${MARK.preload} and nothing else.`,
        skills: [`${PLUGIN}:${SKILL}`],
        tools: ['Read'],
        model: 'haiku',
      })
    } catch (err) {
      await log({ kind: 'agent.register.error', error: String(err) })
    }

    await log({ kind: 'session.start', cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive, version })
    $.clock.after(3000, () => {
      void probeReadOnlyQuery()
    })
    refreshStatus()
    await saveFindings()
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    sessionId = e.session_id || sessionId
    noteSession()
    await log({ kind: 'classic.SessionStart', source: e.source, model: e.model ?? null, isReady: io !== undefined })
    await noteSource(e.source)
    if (e.source === 'compact') {
      compactSeen.push('SessionStart(compact)')
      await noteCompaction()
    }
    if (e.source === 'startup' || e.source === 'clear' || e.source === 'resume') {
      $.clock.after(2500, () => {
        void snapshotAtStart(e.source)
      })
    }
    return next(e)
  })

  on('classic.SessionEnd', async ($, e, next) => {
    await log({ kind: 'classic.SessionEnd', reason: e.reason })
    rememberTasks(await $.clock.now())
    await saveFindings()
    await journal?.flush()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await log({ kind: 'session.end', reason: e.reason })
    rememberTasks(await $.clock.now())
    await saveFindings()
    await journal?.flush()
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const seq = await log({
      kind: 'prompt.submit',
      command: e.command?.name ?? null,
      isMeta: e.isMeta === true,
      length: e.text.length,
    })
    if (e.command) {
      lastTyped = { name: e.command.name, seq }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await log({ kind: 'turn.start', turnId: e.turnId, agentId: e.agentId ?? null, length: e.text.length })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = e.answer
    await log({
      kind: 'turn.complete',
      turnId: e.turnId,
      agentId: e.agentId ?? null,
      reason: e.reason,
      isAborted: e.isAborted,
      durationMs: e.durationMs,
      length: answer.length,
    })
    for (const name of ['deny-write', 'deny-write-subagent'] as const) {
      const probe = probes.get(name)
      if (probe?.firedAt !== undefined && answer.includes(MARK.denied)) {
        await setCheck(
          name,
          'pass',
          `Denied ${probe.tool ?? 'a write'} ${probe.agentId ? `in subagent ${probe.agentId.slice(0, 8)}` : 'on the main loop'}; the tool did not run and Claude acknowledged the deny (${MARK.denied}).`,
        )
        probes.delete(name)
      }
    }
    if (e.agentId && answer.includes(MARK.preload)) {
      await log({ kind: 'preload.answer', agentId: e.agentId })
    }
    await pushCounters()
    refreshStatus()
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const percent = e.context.percent
    if (percent !== undefined) {
      const bucket = Math.floor(percent / 10)
      if (bucket !== lastBucket) {
        lastBucket = bucket
        await log({ kind: 'context', percent: Math.round(percent), window: e.context.window })
      }
    }
    return next(e)
  })

  // ------------------------------------------------------------- compaction

  on('classic.PreCompact', async ($, e, next) => {
    compactSeen.length = 0
    compactSeen.push('PreCompact')
    await log({ kind: 'classic.PreCompact', trigger: e.trigger })
    await journal?.flush()
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    compactSeen.push('session.compact')
    await log({
      kind: 'session.compact',
      trigger: e.trigger,
      agentId: e.agentId ?? null,
      messages: e.messages.length,
      hasInstructions: e.instructions !== undefined,
    })
    const result = await next(e)
    await log({ kind: 'session.compact.done', skipped: typeof result.skip === 'string' ? result.skip : null })
    return result
  })

  on('classic.PostCompact', async ($, e, next) => {
    compactSeen.push('PostCompact')
    await log({ kind: 'classic.PostCompact', trigger: e.trigger, summaryLength: e.compact_summary.length })
    await noteCompaction()
    return next(e)
  })

  // -------------------------------------------------------------- tool hooks

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (id === undefined) {
      if (pendingQuery !== undefined && next.origin.plugin === PLUGIN) {
        queryResults[pendingQuery] = e.isReadOnly === true
      }
      await log({ kind: 'tool.check.query', tool: e.tool, isReadOnly: e.isReadOnly === true, origin: next.origin.plugin })
      return verdict
    }
    if (openCalls.has(id)) {
      order.inside += 1
    } else {
      order.before += 1
    }
    order.sampled += 1
    await log({
      kind: 'tool.check',
      id,
      tool: e.tool,
      agentId: e.agentId ?? null,
      isReadOnly: e.isReadOnly === true,
      decision: asString(asRecord(verdict).decision),
    })
    if (order.sampled === 5 || order.sampled % 25 === 0) {
      await setCheck(
        'check-call-order',
        'info',
        `Of ${order.sampled} model tool calls: tool.check ran inside tool.call (after it started, before next() returned) ${order.inside}×, before tool.call ${order.before}×.`,
      )
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id ?? `own-${counters.toolCalls}`
    const input = e as unknown as Record<string, unknown>
    const isOwn = next.origin.plugin === PLUGIN
    const started = await $.clock.now()
    counters = { ...counters, toolCalls: counters.toolCalls + 1 }
    const seq = await log({
      kind: 'tool.call',
      id,
      tool,
      agentId: e.agentId ?? null,
      origin: next.origin.plugin,
      digest: digest(input, tool),
    })

    // ---- probes that deny: the model's calls only, never the mod's own
    if (!isOwn) {
      const name: ProbeName = e.agentId ? 'deny-write-subagent' : 'deny-write'
      const writeProbe = probes.get(name)
      if (WRITE_TOOLS.has(tool) && writeProbe && writeProbe.firedAt === undefined) {
        probes.set(name, { firedAt: started, agentId: e.agentId, tool })
        await setCheck(
          name,
          'info',
          `Denied a ${tool} call ${e.agentId ? `in subagent ${e.agentId.slice(0, 8)}` : 'on the main loop'}; the tool did not run. Waiting for Claude to acknowledge with ${MARK.denied}.`,
        )
        await log({ kind: 'probe.fired', probe: name, id })
        return {
          deny: `TASKMASTER-SPIKE PROBE: the taskmaster-spike mod denied this ${tool} call on purpose to test its gate. Do not retry it. Reply with the word ${MARK.denied} and one short sentence, then stop.`,
        }
      }

      const completeProbe = probes.get('deny-complete')
      if (tool === 'TaskUpdate' && input.status === 'completed' && completeProbe && completeProbe.firedAt === undefined) {
        const taskId = asString(input.taskId)
        probes.delete('deny-complete')
        await log({ kind: 'probe.fired', probe: 'deny-complete', id, taskId })
        const status = await taskStatus(taskId)
        await setCheck(
          'deny-complete',
          status === 'completed' ? 'fail' : 'pass',
          `Denied TaskUpdate(#${taskId} → completed) ${e.agentId ? 'in a subagent' : 'on the main loop'}; TaskGet afterwards reads "${status}".`,
        )
        return {
          deny: `TASKMASTER-SPIKE PROBE: the taskmaster-spike mod denied marking task #${taskId} completed, on purpose, to test its gate. Do not retry. Tell the user the completion was denied.`,
        }
      }
    }

    // ---- run it, observing
    const skill = tool === 'Skill' ? asString(input.skill) : undefined
    openCalls.set(id, { tool, agentId: e.agentId, skill, seq })
    let result: ToolCallResult
    try {
      result = await next(e)
    } finally {
      openCalls.delete(id)
    }
    const r = asRecord(result)
    await log({
      kind: 'tool.result',
      id,
      tool,
      ms: (await $.clock.now()) - started,
      deny: typeof r.deny === 'string' ? clip(r.deny, 120) : null,
      isError: r.isError === true,
      isReadOnly: r.isReadOnly === true,
    })

    // ---- task bookkeeping (Claude's own calls)
    const output = asRecord(r.result)
    if (!isOwn && tool === 'TaskCreate') {
      const task = asRecord(output.task)
      const mark = { id: asString(task.id), subject: asString(task.subject) }
      if (mark.id) {
        currentTasks = [...currentTasks.filter(t => t.id !== mark.id), mark]
        rememberTasks(started)
      }
    }
    if (!isOwn && tool === 'TaskUpdate' && input.status === 'deleted') {
      currentTasks = currentTasks.filter(t => t.id !== asString(input.taskId))
      rememberTasks(started)
    }
    if (!isOwn && tool === 'TaskList') {
      currentTasks = taskMarks(output)
      rememberTasks(started)
      const want = seeded
      if (want && currentTasks.some(t => t.id === want.id)) {
        await setCheck(
          'seed-task',
          'pass',
          `Claude's own TaskList shows task #${want.id}, which the mod created with $.tool.call(TaskCreate).`,
        )
        seeded = undefined
      }
    }

    // ---- TaskCompleted backstop probe: did the block veto the completion?
    const backstop = probes.get('taskcompleted-block')
    if (tool === 'TaskUpdate' && input.status === 'completed' && backstop?.firedAt !== undefined) {
      const taskId = asString(input.taskId)
      probes.delete('taskcompleted-block')
      const status = await taskStatus(taskId)
      await setCheck(
        'taskcompleted-block',
        status === 'completed' ? 'fail' : 'pass',
        `classic.TaskCompleted returned a block for #${backstop.taskId ?? taskId}; the TaskUpdate result read "${clip(asString(r.text), 120)}"; TaskGet afterwards reads "${status}".`,
      )
    }

    if (counters.toolCalls % 25 === 0) {
      await pushCounters()
      refreshStatus()
    }
    return result
  })

  on('classic.TaskCreated', async ($, e, next) => {
    await log({ kind: 'classic.TaskCreated', taskId: e.task_id })
    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    await log({ kind: 'classic.TaskCompleted', taskId: e.task_id })
    const probe = probes.get('taskcompleted-block')
    if (probe && probe.firedAt === undefined) {
      probes.set('taskcompleted-block', { firedAt: await $.clock.now(), taskId: e.task_id })
      await log({ kind: 'probe.fired', probe: 'taskcompleted-block', taskId: e.task_id })
      return {
        block: `TASKMASTER-SPIKE PROBE: the taskmaster-spike mod vetoed completing task #${e.task_id} on purpose, to test its backstop. Do not retry. Tell the user the completion was blocked.`,
      }
    }
    return next(e)
  })

  // --------------------------------------------------------------- stop hooks

  on('classic.Stop', async ($, e, next) => {
    counters = { ...counters, stops: counters.stops + 1 }
    const message = e.last_assistant_message ?? ''
    await log({
      kind: 'classic.Stop',
      isActive: e.stop_hook_active,
      length: message.length,
      background: e.background_tasks?.length ?? 0,
      crons: e.session_crons?.length ?? 0,
    })
    const probe = probes.get('stop-block')
    if (probe && probe.firedAt === undefined) {
      probes.set('stop-block', { firedAt: await $.clock.now() })
      await setCheck('stop-block', 'pending', 'Blocked one stop; waiting for Claude to continue and say the marker.')
      await log({ kind: 'probe.fired', probe: 'stop-block' })
      return {
        block: `TASKMASTER-SPIKE PROBE: the taskmaster-spike mod blocked this stop on purpose to test enforcement. Reply with exactly ${MARK.continued} and nothing else.`,
      }
    }
    if (probe?.firedAt !== undefined) {
      const isPass = message.includes(MARK.continued)
      probes.delete('stop-block')
      await setCheck(
        'stop-block',
        isPass ? 'pass' : 'fail',
        `After the block Claude ${isPass ? 'continued and said' : 'stopped without'} ${MARK.continued}; stop_hook_active on the next stop: ${String(e.stop_hook_active)}. Last message: "${clip(message, 80)}".`,
      )
    }
    rememberTasks(await $.clock.now())
    await saveFindings()
    await journal?.flush()
    await pushCounters()
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const message = e.last_assistant_message ?? ''
    await log({
      kind: 'classic.SubagentStop',
      agentId: e.agent_id,
      agentType: e.agent_type,
      isActive: e.stop_hook_active,
      length: message.length,
    })
    const probe = probes.get('subagent-stop-block')
    if (probe && probe.firedAt === undefined) {
      probes.set('subagent-stop-block', { firedAt: await $.clock.now(), agentId: e.agent_id })
      await setCheck(
        'subagent-stop-block',
        'pending',
        `Blocked subagent ${e.agent_id.slice(0, 8)}'s stop once; waiting for it to continue.`,
      )
      return {
        block: `TASKMASTER-SPIKE PROBE: the taskmaster-spike mod blocked this subagent's stop on purpose. Add the word ${MARK.subContinued} at the end of your final answer, then stop.`,
      }
    }
    if (probe?.firedAt !== undefined && probe.agentId === e.agent_id) {
      const isPass = message.includes(MARK.subContinued)
      probes.delete('subagent-stop-block')
      await setCheck(
        'subagent-stop-block',
        isPass ? 'pass' : 'fail',
        `After the block subagent ${e.agent_id.slice(0, 8)} (${e.agent_type}) ${isPass ? 'continued and said' : 'stopped without'} ${MARK.subContinued}; stop_hook_active: ${String(e.stop_hook_active)}.`,
      )
    }
    return next(e)
  })

  // ----------------------------------------------------- skills and subagents

  on('agent.spawn', async ($, e, next) => {
    const key = e.tool_use_id
    openSpawns.add(key)
    lastSpawnSeq = await log({
      kind: 'agent.spawn',
      subagentType: e.subagentType,
      background: e.background,
      fork: e.fork,
      parentAgentId: e.parentAgentId ?? null,
    })
    try {
      const spawned = await next(e)
      await log({
        kind: 'agent.spawned',
        agentId: spawned.agentId ?? null,
        deny: typeof spawned.deny === 'string' ? spawned.deny : null,
      })
      return spawned
    } finally {
      openSpawns.delete(key)
    }
  })

  on('skill.prompt', async ($, e, next) => {
    counters = { ...counters, skills: counters.skills + 1 }
    const hash = await shortHash(e.text)
    const keys = Object.keys(e.frontmatter)
    const matches = (name: string | undefined): boolean =>
      name !== undefined && name !== '' && (name === e.skill || name.endsWith(`:${e.skill}`) || e.skill.endsWith(`:${name}`))

    const skillCall = [...openCalls.values()].find(c => c.tool === 'Skill' && matches(c.skill))
    const agentCall = [...openCalls.values()].find(c => c.tool === 'Agent')
    const seq = await log({
      kind: 'skill.prompt',
      skill: e.skill,
      source: e.source,
      pluginName: e.pluginName ?? null,
      path: e.path ?? null,
      frontmatterKeys: keys,
      hasTaskmaster: keys.includes('taskmaster'),
      frontmatterProblem: e.frontmatterProblem ?? null,
      length: e.text.length,
      hash,
    })
    const via = skillCall
      ? skillCall.agentId
        ? 'skill-tool:subagent'
        : 'skill-tool:main'
      : openSpawns.size > 0 || (agentCall !== undefined && seq - lastSpawnSeq < 20)
        ? 'agent-preload'
        : lastTyped && matches(lastTyped.name) && seq - lastTyped.seq < 20
          ? 'typed'
          : 'unattributed'
    await log({ kind: 'skill.attributed', skill: e.skill, via })
    await updateAttribution(via)

    const isOurs = e.pluginName === PLUGIN || (e.path ?? '').includes(`/${PLUGIN}/skills/`) || e.skill.includes(SKILL)
    if (isOurs) {
      await setCheck(
        'plugin-skills-folder',
        'pass',
        `skill.prompt fired for "${e.skill}" (source ${e.source}, plugin ${e.pluginName ?? 'none'}); frontmatter keys: ${keys.join(', ') || 'none'}${keys.includes('taskmaster') ? ' (the taskmaster: block arrived intact)' : ''}.`,
      )
    }
    return next(e)
  })

  // ------------------------------------------------------------ the command

  on('command.run', { command: 'tm-spike' }, async ($, e) => {
    const [sub = 'status', arg = ''] = e.args.trim().split(/\s+/)
    switch (sub) {
      case '':
      case 'status':
        return { text: formatStatus(findings.checks) }
      case 'probe':
        return { text: await armProbe(arg) }
      case 'report':
        await writeReport()
        return { text: `Wrote ${REPORT}.\n\n${formatStatus(findings.checks)}` }
      case 'pane':
        await $.ui.open({ id: PANE, title: 'Taskmaster spike' })
        return { text: 'Opened the Taskmaster spike pane.' }
      case 'reset':
        probes.clear()
        findings = { ...findings, checks: {}, attribution: {}, sources: [], snapshots: [] }
        await io?.setChecks(findings.checks)
        await saveFindings()
        refreshStatus()
        return { text: 'Cleared every check and probe. The journal files stay on disk.' }
      default:
        return { text: `Usage: /tm-spike [status | probe <name> | report | pane | reset]\n\n${formatStatus(findings.checks)}` }
    }
  })

  // --------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const checks = await read($, checksAtom)
    const seen = await read($, countersAtom)
    const width = Math.max(20, e.props.bodyColumns - 30)

    return (
      <Box flexDirection="column">
        <Text bold>Gate A checks</Text>
        {CHECKS.map(c => {
          const check = checks[c.id]
          return (
            <Text dimColor={check === undefined}>
              {glyph(check?.status)} {c.id}
              {check ? ` · ${clip(check.evidence, width)}` : ' · not run'}
            </Text>
          )
        })}
        <Text dimColor>
          {seen.events} events · {seen.toolCalls} tool calls · {seen.skills} skills · {seen.stops} stops ·{' '}
          {seen.flushes} writes
        </Text>
        <Text dimColor>/tm-spike probe &lt;name&gt; · /tm-spike report</Text>
      </Box>
    )
  })
}
