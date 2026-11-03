import { expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../types'
import { BUILD, engine, SELF_CHECK_KEY, selfCheck, start } from './engine'

// Plan F12's Phase 1 keys and defaults, written out here on their own so a
// change to either plugin.json or DEFAULTS that drifts from the plan fails.
const F12: Config = {
  strictness: 'enforce',
  maxStopBlocks: 2,
  exemptSkills: [],
  checkpointDir: '.taskmaster',
  checkpointGit: 'commit',
  checkpointPush: 'off',
  checkpointEveryWrites: 10,
  contextCheckpointPercent: 70,
  resumePolicy: 'offer',
  metrics: true,
  metricsDir: '.taskmaster/metrics',
  ratingSample: 3,
  sentimentClassifier: false,
  experiment: 'off',
  experimentWeights: '1/1/1',
  experimentBlind: true,
  rca: 'manual',
  rcaModel: 'haiku',
  rcaDailyCap: 5,
  circuitBreakerThreshold: 3,
  overrideDir: '.taskmaster/overrides',
}

// ------------------------------------------------------------ self-check

test('session.start saves a self-check record for this build', async ($, on) => {
  const world = engine(on)
  await start($)

  const record = selfCheck(world)
  expect(record.schema).toBe(1)
  expect(record.build).toBe(BUILD)
  expect(record.seen).toEqual(['session.start'])
  expect(record.updatedAt).toBe(1_000)
})

test('the self-check records the events it saw, including ones from before session.start', async ($, on) => {
  const world = engine(on)
  // Fires before session.start, so the mod has to buffer it.
  await $.classic.SessionStart({ source: 'startup' })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })

  const seen = selfCheck(world).seen
  expect(seen).toEqual(['classic.SessionStart', 'classic.Stop', 'session.start', 'tool.call', 'tool.check'])
  expect(seen).not.toContain('classic.PreCompact')
})

test('every watched event is recorded once it fires', async ($, on) => {
  const world = engine(on)
  await start($)
  await $.prompt.submit({ text: 'run the notes skill', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'run the notes skill', turnId: 'turn-1' })
  await $.skill.prompt({ skill: 'notes', text: '1. Write the note.', frontmatter: {}, source: 'projectSettings' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  await $.agent.spawn({
    tool_use_id: 'toolu_spawn_1',
    prompt: 'Summarise the plan.',
    description: 'summarise',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  })
  await $.classic.TaskCompleted({ task_id: '1', task_subject: 'Write the note' })
  await $.session.compact({ trigger: 'manual', messages: [] })
  await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null })
  await $.classic.SessionStart({ source: 'compact' })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'summary' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })

  expect(selfCheck(world).seen).toEqual([
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
  ])
})

test('a new event is saved once, and a repeat saves nothing', async ($, on) => {
  const world = engine(on)
  await start($)
  const afterStart = world.writes.length

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'one' })
  expect(world.writes.length).toBe(afterStart + 1)

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'two' })
  expect(world.writes.length).toBe(afterStart + 1)
  expect(world.writes.every(key => key === SELF_CHECK_KEY)).toBe(true)
})

test('events an earlier session saw on the same build are kept', async ($, on) => {
  const world = engine(on, {
    seed: {
      [SELF_CHECK_KEY]: { schema: 1, build: BUILD, seen: ['session.compact'], config: F12, updatedAt: 1 },
    },
  })
  await start($)

  expect(selfCheck(world).seen).toEqual(['session.compact', 'session.start'])
})

test('a stored record this version cannot read is replaced, not merged', async ($, on) => {
  const world = engine(on, { seed: { [SELF_CHECK_KEY]: { schema: 0, build: BUILD, seen: ['tool.call'] } } })
  await start($)

  expect(selfCheck(world).seen).toEqual(['session.start'])
})

test('stored names that are not watched events are dropped', async ($, on) => {
  const world = engine(on, {
    seed: { [SELF_CHECK_KEY]: { schema: 1, build: BUILD, seen: ['turn.step', 42, 'tool.call'], config: F12, updatedAt: 1 } },
  })
  await start($)

  expect(selfCheck(world).seen).toEqual(['session.start', 'tool.call'])
})

test('a failing store costs only the self-check: every event still passes through', async ($, on) => {
  engine(on, { storeFails: true })
  await start($)

  const read = await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  expect(read.deny).toBeUndefined()
  const stopped = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  expect(stopped.block).toBeUndefined()
})

// ------------------------------------------------------- observe only

test('the scaffold only observes: tool calls and stops pass through unchanged', async ($, on) => {
  engine(on)
  await start($)

  const wrote = await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'hi' })
  expect(wrote.deny).toBeUndefined()
  expect(wrote.result).toEqual({ text: 'engine result' })

  const stopped = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  expect(stopped.block).toBeUndefined()
})

test('the scaffold shows nothing: no status line or toast', async ($, on) => {
  const world = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })

  expect(world.shown).toEqual([])
})

// ---------------------------------------------------------------- config

test('the config defaults match F12', async ($, on) => {
  const world = engine(on)
  await start($)

  expect(selfCheck(world).config).toEqual(F12)
  expect(DEFAULTS).toEqual(F12)
})

test('options from settings reach the config', { options: { strictness: 'strict', maxStopBlocks: 3, exemptSkills: ['notes'] } }, async ($, on) => {
  const world = engine(on)
  await start($)

  const config = selfCheck(world).config
  expect(config.strictness).toBe('strict')
  expect(config.maxStopBlocks).toBe(3)
  expect(config.exemptSkills).toEqual(['notes'])
  expect(config.checkpointGit).toBe('commit')
})

test('parseConfig falls back to the default for a wrong type or a value outside its choices', () => {
  const config = parseConfig({ strictness: 'loose', maxStopBlocks: 'two', metrics: 'yes', exemptSkills: 'notes' })

  expect(config).toEqual(F12)
})

test('parseConfig clamps numbers into their range, rounds them, and trims text', () => {
  const config = parseConfig({
    maxStopBlocks: 99,
    contextCheckpointPercent: 0,
    ratingSample: 2.6,
    checkpointEveryWrites: Number.NaN,
    rcaDailyCap: Number.POSITIVE_INFINITY,
    checkpointDir: '  .tm  ',
    rcaModel: '   ',
  })

  expect(config.maxStopBlocks).toBe(5)
  expect(config.contextCheckpointPercent).toBe(10)
  expect(config.ratingSample).toBe(3)
  expect(config.checkpointEveryWrites).toBe(10)
  expect(config.rcaDailyCap).toBe(5)
  expect(config.checkpointDir).toBe('.tm')
  expect(config.rcaModel).toBe('haiku')
})

test('parseConfig keeps a list of skill names, and drops anything else in it', () => {
  expect(parseConfig({ exemptSkills: ['notes', ' deploy '] }).exemptSkills).toEqual(['notes', 'deploy'])
  expect(parseConfig({ exemptSkills: ['notes', '', '  '] }).exemptSkills).toEqual(['notes'])
})

test('parseConfig ignores keys it does not know', () => {
  const config = parseConfig({ audit: 'blocking', strictness: 'observe' })

  expect(Object.keys(config).sort()).toEqual(Object.keys(F12).sort())
  expect(config.strictness).toBe('observe')
})
