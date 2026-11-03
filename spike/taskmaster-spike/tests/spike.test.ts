import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gateVerdict } from '../hooks/checks'

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
