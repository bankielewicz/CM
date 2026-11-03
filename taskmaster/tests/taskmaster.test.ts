import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CHOICES, DEFAULTS, parseConfig } from '../hooks/config'
import { WATCHED } from '../hooks/selfcheck'
import type { Config, WatchedEvent } from '../types'
import { BUILD, engine, SELF_CHECK_KEY, selfCheck, start, untilSaved, untilSeen } from './engine'

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
  experiment: 'off',
  experimentWeights: '1/1/1',
  experimentBlind: true,
  rca: 'manual',
  rcaModel: 'haiku',
  rcaDailyCap: 5,
  circuitBreakerThreshold: 3,
  overrideDir: '.taskmaster/overrides',
}

const EVERY_EVENT: WatchedEvent[] = [
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
]

/** Raises every watched event after session.start, and returns what each call answered. */
async function raiseEveryEvent($: Engine) {
  const prompt = await $.prompt.submit({ text: 'run the notes skill', wait: false, origin: { kind: 'composer' } })
  const turn = await $.turn.start({ text: 'run the notes skill', turnId: 'turn-1' })
  const skill = await $.skill.prompt({ skill: 'notes', text: '1. Write the note.', frontmatter: {}, source: 'projectSettings' })
  const tool = await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt' })
  const spawn = await $.agent.spawn({
    tool_use_id: 'toolu_spawn_1',
    prompt: 'Summarise the plan.',
    description: 'summarise',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  })
  const completed = await $.classic.TaskCompleted({ task_id: '1', task_subject: 'Write the note' })
  const compact = await $.session.compact({ trigger: 'manual', messages: [] })
  await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null })
  await $.classic.SessionStart({ source: 'compact' })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'summary' })
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  const done = await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  const end = await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  return { prompt, turn, skill, tool, spawn, completed, compact, stop, done, end }
}

// ------------------------------------------------------------ self-check

test('session.start saves a self-check record for this build', async ($, on) => {
  const world = engine(on)
  await start($)

  const record = await untilSeen(world, 'session.start')
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

  const record = await untilSeen(world, 'classic.SessionStart', 'classic.Stop', 'session.start', 'tool.call', 'tool.check')
  expect(record.seen).toEqual(['classic.SessionStart', 'classic.Stop', 'session.start', 'tool.call', 'tool.check'])
  expect(record.seen).not.toContain('classic.PreCompact')
})

test('every watched event is recorded once it fires', async ($, on) => {
  const world = engine(on)
  await start($)
  await raiseEveryEvent($)

  const record = await untilSeen(world, ...EVERY_EVENT)
  expect(record.seen).toEqual(EVERY_EVENT)
})

test('the self-check watches exactly the events the mod depends on', () => {
  expect([...WATCHED]).toEqual(EVERY_EVENT)
})

test('a new event is saved once, and a repeat saves nothing', async ($, on) => {
  const world = engine(on)
  await start($)
  await untilSeen(world, 'session.start')
  const afterStart = world.writes.length

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'one' })
  await untilSeen(world, 'classic.Stop')
  expect(world.writes.length).toBe(afterStart + 1)

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'two' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  await untilSeen(world, 'turn.complete')
  expect(world.writes.length).toBe(afterStart + 2)
  expect(world.writes.every(key => key === SELF_CHECK_KEY)).toBe(true)
})

test('events an earlier session saw on the same build are kept', async ($, on) => {
  const world = engine(on, {
    seed: { [SELF_CHECK_KEY]: { schema: 1, build: BUILD, seen: ['session.compact'], config: F12, updatedAt: 1 } },
  })
  await start($)

  expect((await untilSeen(world, 'session.start')).seen).toEqual(['session.compact', 'session.start'])
})

test('events another session saves meanwhile are kept, not overwritten', async ($, on) => {
  const world = engine(on)
  await start($)
  const first = await untilSeen(world, 'session.start')
  // A second session on this machine saves what it saw.
  world.saved.set(SELF_CHECK_KEY, { ...first, seen: ['session.start', 'turn.start'] })

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })

  expect((await untilSeen(world, 'classic.Stop')).seen).toEqual(['classic.Stop', 'session.start', 'turn.start'])
})

test('a save held up by a slow store loses no later event', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { holdFirstWrite: true })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })
  world.release()

  await untilSaved(world, () => world.writes.length >= 2)
  expect(selfCheck(world)?.seen).toEqual(['classic.Stop', 'session.start'])
})

test('a stored record this version cannot read is replaced, not merged', async ($, on) => {
  const world = engine(on, { seed: { [SELF_CHECK_KEY]: { schema: 0, build: BUILD, seen: ['tool.call'] } } })
  await start($)

  expect((await untilSeen(world, 'session.start')).seen).toEqual(['session.start'])
})

test('stored names that are not watched events are dropped', async ($, on) => {
  const world = engine(on, {
    seed: { [SELF_CHECK_KEY]: { schema: 1, build: BUILD, seen: ['turn.step', 42, 'tool.call'], config: F12, updatedAt: 1 } },
  })
  await start($)

  expect((await untilSeen(world, 'session.start')).seen).toEqual(['session.start', 'tool.call'])
})

test('a failed read leaves the stored history alone, and a later save keeps it', async ($, on) => {
  const world = engine(on, {
    failGets: 1,
    seed: { [SELF_CHECK_KEY]: { schema: 1, build: BUILD, seen: ['session.compact'], config: F12, updatedAt: 1 } },
  })
  // Checked at every write: no save may drop what the earlier session saw.
  const kept: boolean[] = []
  world.onWrite.push(function watch() {
    kept.push(selfCheck(world)?.seen.includes('session.compact') ?? false)
    world.onWrite.push(watch)
  })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })

  const record = await untilSeen(world, 'classic.Stop')
  expect(record.seen).toEqual(['classic.Stop', 'session.compact', 'session.start'])
  expect(kept.length > 0 && kept.every(Boolean)).toBe(true)
})

test('a failed write costs nothing: the next new event saves everything seen', async ($, on) => {
  const world = engine(on, { failSets: 1 })
  await start($)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' })

  expect((await untilSeen(world, 'classic.Stop')).seen).toEqual(['classic.Stop', 'session.start'])
})

test('a failing version lookup still runs the self-check, under the build "unknown"', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { versionFails: true })
  await start($)

  const record = await untilSaved(world, saved => saved.seen.includes('session.start'), 'self-check/unknown')
  expect(record.build).toBe('unknown')
})

test('a save in flight when session.start fires again saves next under the new build', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { holdFirstWrite: true, failVersions: 1 })
  await start($)
  await start($)
  world.release()

  await untilSaved(world, () => world.writes.length >= 2)
  expect(world.writes).toEqual(['self-check/unknown', SELF_CHECK_KEY])
})

test('events stored under one build are not written to another build\'s record', async ($, on) => {
  const world = engine(on, {
    failVersions: 1,
    seed: { 'self-check/unknown': { schema: 1, build: 'unknown', seen: ['session.compact'], config: F12, updatedAt: 1 } },
  })
  await start($)
  await untilSaved(world, record => record.seen.includes('session.start'), 'self-check/unknown')
  await start($)

  expect((await untilSeen(world, 'session.start')).seen).toEqual(['session.start'])
})

// ------------------------------------------------------- observe only

test('every watched event passes through unchanged, with the engine\'s own answer', async ($, on) => {
  const world = engine(on)
  await start($)
  const answers = await raiseEveryEvent($)

  expect([...new Set(world.reached)].sort()).toEqual(EVERY_EVENT)
  expect(answers.prompt.text).toBe('engine: run the notes skill')
  expect(answers.turn.turnId).toBe('engine-turn')
  expect(answers.skill.text).toBe('engine skill text')
  expect(answers.tool.result).toEqual({ text: 'engine result' })
  expect(answers.tool.deny).toBeUndefined()
  expect(answers.spawn.agentId).toBe('engine-agent')
  expect(answers.compact.skip).toBe('engine skip')
  expect(answers.stop.block).toBeUndefined()
  expect(answers.done.text).toBe('engine summary')
  expect(answers.end.sessionId).toBe('engine-session')
})

test('a hung store holds up no event', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { hangWrites: true })
  await start($)
  const answers = await raiseEveryEvent($)

  expect(answers.tool.result).toEqual({ text: 'engine result' })
  expect(answers.end.sessionId).toBe('engine-session')
  expect(world.writes).toEqual([])
})

test('a hung version lookup holds up no event', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { hangVersion: true })
  await start($)
  const answers = await raiseEveryEvent($)

  expect(answers.tool.result).toEqual({ text: 'engine result' })
  expect(answers.end.sessionId).toBe('engine-session')
  expect(world.writes).toEqual([])
})

test('a failing session.start still starts the self-check', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { failStart: true })
  let failed = false
  await start($).catch(() => { failed = true })
  await untilSeen(world, 'session.start')
  expect(failed).toBe(true)
})

test('the scaffold shows nothing: no status line or toast', async ($, on) => {
  const world = engine(on)
  await $.classic.SessionStart({ source: 'startup' })
  await start($)
  await raiseEveryEvent($)
  await untilSeen(world, ...EVERY_EVENT)

  expect(world.shown).toEqual([])
})

// ---------------------------------------------------------------- config

test('the config defaults match F12', async ($, on) => {
  const world = engine(on)
  await start($)

  expect((await untilSeen(world, 'session.start')).config).toEqual(F12)
  expect(DEFAULTS).toEqual(F12)
})

test('options from settings reach the config', { options: { strictness: 'strict', maxStopBlocks: 3, exemptSkills: ['notes'] } }, async ($, on) => {
  const world = engine(on)
  await start($)

  const config = (await untilSeen(world, 'session.start')).config
  expect(config.strictness).toBe('strict')
  expect(config.maxStopBlocks).toBe(3)
  expect(config.exemptSkills).toEqual(['notes'])
  expect(config.checkpointGit).toBe('commit')
})

test(
  'an out-of-range number is clamped, and the mod still loads',
  { options: { maxStopBlocks: 99, contextCheckpointPercent: 0, ratingSample: 1_000 } },
  async ($, on) => {
    const world = engine(on)
    await start($)

    const config = (await untilSeen(world, 'session.start')).config
    expect(config.maxStopBlocks).toBe(5)
    expect(config.contextCheckpointPercent).toBe(10)
    expect(config.ratingSample).toBe(100)
  },
)

// Each choice parseConfig accepts must be one plugin.json offers: the engine
// unsets a stored value outside a field's options, so a missing one would
// arrive here as the default.
for (const [key, values] of Object.entries(CHOICES)) {
  for (const value of values ?? []) {
    test(`plugin.json offers ${key}: ${value}`, { options: { [key]: value } }, async ($, on) => {
      const world = engine(on)
      await start($)

      expect((await untilSeen(world, 'session.start')).config[key as keyof Config]).toBe(value)
    })
  }
}

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

test('parseConfig keeps folders inside the project, and refuses any other', () => {
  for (const outside of ['/', '/etc/taskmaster', '..', '../elsewhere', 'state/../../x', '.', './', '~/taskmaster', 'C:\\taskmaster']) {
    expect(parseConfig({ checkpointDir: outside }).checkpointDir).toBe('.taskmaster')
  }
  expect(parseConfig({ checkpointDir: './state/' }).checkpointDir).toBe('state')
  expect(parseConfig({ metricsDir: '.tm//metrics/' }).metricsDir).toBe('.tm/metrics')
  expect(parseConfig({ overrideDir: '../overrides' }).overrideDir).toBe('.taskmaster/overrides')
})

test('parseConfig refuses a folder inside .git, in any case', () => {
  for (const key of ['checkpointDir', 'metricsDir', 'overrideDir'] as const) {
    for (const path of ['.git', '.git/checkpoints', 'state/.git', './.git/', '.GIT', 'state\\.git\\x']) {
      expect(parseConfig({ [key]: path })[key]).toBe(DEFAULTS[key])
    }
    expect(parseConfig({ [key]: '.github/state' })[key]).toBe('.github/state')
  }
})

test('parseConfig keeps experiment weights only as three numbers that are not all zero', () => {
  for (const bad of ['0/0/0', '1/2', '1/-1/1', 'a/b/c', '1/1/1/1']) {
    expect(parseConfig({ experimentWeights: bad }).experimentWeights).toBe('1/1/1')
  }
  expect(parseConfig({ experimentWeights: ' 2/1/0 ' }).experimentWeights).toBe('2/1/0')
  expect(parseConfig({ experimentWeights: '0.5/0.5/1' }).experimentWeights).toBe('0.5/0.5/1')
})

test('parseConfig keeps a list of skill names, and drops anything else in it', () => {
  expect(parseConfig({ exemptSkills: ['notes', ' deploy '] }).exemptSkills).toEqual(['notes', 'deploy'])
  expect(parseConfig({ exemptSkills: ['notes', '', '  '] }).exemptSkills).toEqual(['notes'])
})

test('parseConfig never hands out the defaults\' own list', () => {
  expect(parseConfig({}).exemptSkills).not.toBe(DEFAULTS.exemptSkills)
})

test('parseConfig ignores keys it does not know', () => {
  const config = parseConfig({ audit: 'blocking', sentimentClassifier: true, strictness: 'observe' })

  expect(Object.keys(config).sort()).toEqual(Object.keys(F12).sort())
  expect(config.strictness).toBe('observe')
})
