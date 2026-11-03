import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gateVerdict, modeVerdict } from '../hooks/checks'

// Nothing sits beneath the plugin in a test: these hooks stand for the
// engine, answering each call the spike makes on `$`.
function engine(on: On, tasks: Record<string, string> = {}): string[] {
  const writes: string[] = []
  mock.clock(on)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session-0001' }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.version', () => ({ value: { version: '2.1.317', base: '2.1.317', builtAt: '2026-01-01T00:00:00Z' } }))
  on('command.register', () => ({ value: { command: 'tm-spike' } }))
  on('agent.register', () => ({ value: { agent: 'taskmaster-spike:skill-preload' } }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: '{}' }))
  on('fs.write', (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskGet') {
      return { result: { task: { id: e.taskId, status: tasks[e.taskId] ?? 'in_progress' } } }
    }
    return { result: {} }
  })
  on('classic.Stop', () => ({}))
  return writes
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

// /tm-spike as the person types it.
function spike($: Engine, args: string) {
  return $.command.run({
    command: 'tm-spike',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

test('an unarmed spike only observes: no deny, no block', async ($, on) => {
  engine(on)
  await start($)

  const wrote = await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'hi' })
  expect(wrote.deny).toBeUndefined()

  const stopped = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  expect(stopped.block).toBeUndefined()
})

test('stop-block blocks one stop, then passes when Claude says the marker', async ($, on) => {
  engine(on)
  await start($)
  await spike($, 'probe stop-block')

  const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'hi' })
  expect(first.block).toContain('SPIKE-CONTINUED')

  const second = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'SPIKE-CONTINUED' })
  expect(second.block).toBeUndefined()

  const status = await spike($, 'status')
  expect(status.text).toContain('✓ stop-block')
})

test('stop-block fails when Claude stops without the marker', async ($, on) => {
  engine(on)
  await start($)
  await spike($, 'probe stop-block')

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'hi' })
  await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'ok bye' })

  const status = await spike($, 'status')
  expect(status.text).toContain('✗ stop-block')
})

test('deny-write denies exactly one main-loop write', async ($, on) => {
  engine(on)
  await start($)
  await spike($, 'probe deny-write')

  const first = await $.tool.call({ tool: 'Write', file_path: '/repo/x.txt', content: 'hi' })
  expect(first.deny).toContain('SPIKE-DENIED-SEEN')

  const second = await $.tool.call({ tool: 'Write', file_path: '/repo/x.txt', content: 'hi' })
  expect(second.deny).toBeUndefined()
})

test('deny-write leaves reads alone', async ($, on) => {
  engine(on)
  await start($)
  await spike($, 'probe deny-write')

  const read = await $.tool.call({ tool: 'Read', file_path: '/repo/x.txt' })
  expect(read.deny).toBeUndefined()
})

test('deny-complete denies a completion and checks the task stayed open', async ($, on) => {
  engine(on, { '7': 'in_progress' })
  await start($)
  await spike($, 'probe deny-complete')

  const done = await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect(done.deny).toContain('denied marking task #7 completed')

  const status = await spike($, 'status')
  expect(status.text).toContain('✓ deny-complete')
})

test('taskcompleted-block vetoes one TaskCompleted event', async ($, on) => {
  engine(on)
  on('classic.TaskCompleted', () => ({}))
  await start($)
  await spike($, 'probe taskcompleted-block')

  const vetoed = await $.classic.TaskCompleted({ task_id: '3', task_subject: 'spike backstop' })
  expect(vetoed.block).toContain('vetoed completing task #3')

  const again = await $.classic.TaskCompleted({ task_id: '4', task_subject: 'next' })
  expect(again.block).toBeUndefined()
})

test('the journal is written under .taskmaster/spike', async ($, on) => {
  const writes = engine(on)
  await start($)
  await spike($, 'report')

  // Relative paths reach the engine resolved against the working directory.
  // Paths are anchored to $.session.root(), not the shell's working directory.
  expect(writes).toContain('/repo/.taskmaster/spike/FINDINGS.md')
  expect(writes).toContain('/repo/.taskmaster/spike/findings.json')
})

test('the Gate A verdict reads the blocking checks', () => {
  const at = 0
  expect(gateVerdict({})).toContain('Undecided')
  expect(
    gateVerdict({
      'stop-block': { status: 'pass', evidence: '', updatedAt: at },
      'deny-write': { status: 'pass', evidence: '', updatedAt: at },
      'deny-complete': { status: 'pass', evidence: '', updatedAt: at },
    }),
  ).toContain('GO')
  expect(gateVerdict({ 'stop-block': { status: 'fail', evidence: '', updatedAt: at } })).toContain('NO-GO')
})

// ------------------------------------------------- subagent-stop-block

const SPAWNED = 'agent-spawned-1'

// An Agent-tool spawn as core answers it: the started subagent's id.
function spawner(on: On): void {
  on('agent.spawn', () => ({ model: 'haiku', agentId: SPAWNED }))
  on('classic.SubagentStop', () => ({}))
  on('turn.complete', () => ({ text: '' }))
}

async function spawn($: Engine): Promise<void> {
  await $.agent.spawn({
    tool_use_id: 'toolu_spawn_1',
    prompt: 'Summarise the plan in one line.',
    description: 'summarise',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  })
}

function subagentStop($: Engine, agentId: string, agentType: string, isActive = false) {
  return $.classic.SubagentStop({
    stop_hook_active: isActive,
    agent_id: agentId,
    agent_type: agentType,
    agent_transcript_path: '',
    last_assistant_message: '',
  })
}

function subagentAnswer($: Engine, answer: string) {
  return $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 'turn-sub-1', agentId: SPAWNED, reason: 'answer' })
}

test("subagent-stop-block leaves the engine's helper agents alone", async ($, on) => {
  engine(on)
  spawner(on)
  await start($)
  await spike($, 'probe subagent-stop-block')

  // A helper (title, summarizer): empty agent_type, never spawned.
  const helper = await subagentStop($, 'helper-1', '')
  expect(helper.block).toBeUndefined()

  const status = await spike($, 'status')
  expect(status.text).toContain('… subagent-stop-block')
})

test("subagent-stop-block blocks a spawned subagent once and passes on its answer's marker", async ($, on) => {
  engine(on)
  spawner(on)
  await start($)
  await spike($, 'probe subagent-stop-block')
  await spawn($)

  const first = await subagentStop($, SPAWNED, 'general-purpose')
  expect(first.block).toContain('SPIKE-SUB-CONTINUED')

  // Its next stop comes before its turn.complete, and isn't blocked again.
  const second = await subagentStop($, SPAWNED, 'general-purpose', true)
  expect(second.block).toBeUndefined()

  await subagentAnswer($, 'The plan holds Claude to a skill workflow. SPIKE-SUB-CONTINUED')
  const status = await spike($, 'status')
  expect(status.text).toContain('✓ subagent-stop-block')
  expect(status.text).toContain('stop_hook_active on its next stop: true')
})

test('subagent-stop-block fails when the subagent ends without the marker', async ($, on) => {
  engine(on)
  spawner(on)
  await start($)
  await spike($, 'probe subagent-stop-block')
  await spawn($)

  await subagentStop($, SPAWNED, 'general-purpose')
  await subagentStop($, SPAWNED, 'general-purpose', true)
  await subagentAnswer($, 'The plan holds Claude to a skill workflow.')

  const status = await spike($, 'status')
  expect(status.text).toContain('✗ subagent-stop-block')
})

// ---------------------------------------------------- compaction-events

test('compaction-events passes when session.compact wraps PreCompact and PostCompact', async ($, on) => {
  engine(on)
  on('classic.PreCompact', () => ({}))
  on('classic.PostCompact', () => ({}))
  // As observed on 2.1.317: session.compact starts first, and the classic
  // events fire inside it, before its next() returns.
  const transcript = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
  on('session.compact', async () => {
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null })
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'summary' })
    return { messages: transcript }
  })
  await start($)

  await $.session.compact({ trigger: 'manual', messages: transcript })

  const status = await spike($, 'status')
  expect(status.text).toContain('✓ compaction-events')
  expect(status.text).toContain('session.compact → PreCompact → PostCompact → session.compact.done')
})

// ---------------------------------------------------- check-every-mode

test('check-every-mode reads the per-mode tool.check counts', () => {
  expect(modeVerdict({}).status).toBe('info')
  expect(modeVerdict({ auto: { calls: 9, checked: 9 } }).status).toBe('info')
  expect(modeVerdict({ bypassPermissions: { calls: 3, checked: 3 } }).status).toBe('info')

  const pass = modeVerdict({ auto: { calls: 9, checked: 9 }, bypassPermissions: { calls: 5, checked: 5 } })
  expect(pass.status).toBe('pass')
  expect(pass.evidence).toContain('auto 9/9, bypassPermissions 5/5')

  const fail = modeVerdict({ bypassPermissions: { calls: 6, checked: 4 } })
  expect(fail.status).toBe('fail')
  expect(fail.evidence).toContain('Skipped in: bypassPermissions')

  // A miss in another mode is reported, but bypass decides the check.
  const other = modeVerdict({ default: { calls: 4, checked: 3 }, bypassPermissions: { calls: 5, checked: 5 } })
  expect(other.status).toBe('pass')
  expect(other.evidence).toContain('Skipped in: default')
})

test("check-every-mode counts each main-loop call under its turn's permission mode", async ($, on) => {
  engine(on)
  on('classic.UserPromptSubmit', () => ({}))
  await start($)

  await $.classic.UserPromptSubmit({ prompt: 'read it', permission_mode: 'bypassPermissions' })
  for (let i = 0; i < 5; i++) {
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  }
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done', permission_mode: 'bypassPermissions' })

  const status = await spike($, 'status')
  expect(status.text).toContain('✓ check-every-mode')
  expect(status.text).toContain('bypassPermissions 5/5')
})
