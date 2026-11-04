import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { contentHash, sameSkill, SkillTracker } from '../hooks/skills'
import type { SkillCapture } from '../types'
import { engine, start, stateValue, until } from './engine'
import type { World } from './engine'

// P1.1: capture each skill as it loads, and work out which loop it belongs to.
// The orders these tests raise events in were seen live on 2.1.317:
// - a Skill tool call: skill.prompt fires while the call is open (spike journals),
// - a typed /name: skill.prompt fires inside prompt.submit, before the turn starts
//   (a probe mod's headless /notes run),
// - a preloaded skill: skill.prompt fires after agent.spawn has answered with the
//   new agent's id, before that agent's first tool call (spike journals).

const NOTES_TEXT = '1. Write the note.'
const NOTES_HASH_HEX = /^[0-9a-f]{64}$/

/** The skills the mod has recorded in `$.state`, as its latest write left them. */
function captures(world: World): SkillCapture[] {
  return (stateValue(world, 'taskmaster/skills') ?? []) as SkillCapture[]
}

/** The engine expanding a skill: `skill.prompt` as it fires for the notes skill. */
function expand($: Engine, skill = 'notes') {
  return $.skill.prompt({
    skill,
    text: NOTES_TEXT,
    frontmatter: { description: 'Write a note.' },
    source: 'projectSettings',
    path: '/repo/.claude/skills/notes/SKILL.md',
  })
}

function typed($: Engine, name: string) {
  return $.prompt.submit({ text: `/${name}`, command: { name, args: '' }, wait: false, origin: { kind: 'composer' } })
}

function spawn($: Engine) {
  return $.agent.spawn({
    tool_use_id: 'toolu_spawn',
    prompt: 'Summarise the plan.',
    description: 'summarise',
    subagentType: 'notes-writer',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
  })
}

const SENTINEL = 'settled-sentinel'

/**
 * Every capture from the events raised so far. Saves can land after the hook
 * answers, but they land in the order the skills loaded. So one more skill, seen
 * as the newest capture, shows that all those before it have landed. Waiting for
 * a count wouldn't: a test expecting one capture couldn't see a second still to come.
 */
async function settled($: Engine, world: World): Promise<SkillCapture[]> {
  await expand($, SENTINEL)
  await until(world, () => captures(world).at(-1)?.skill === SENTINEL)
  return captures(world).filter(capture => capture.skill !== SENTINEL)
}

const only = async ($: Engine, world: World): Promise<SkillCapture> => {
  const all = await settled($, world)
  expect(all).toHaveLength(1)
  return all[0] as SkillCapture
}

// ------------------------------------------------------- the four paths

test('a skill the Skill tool loads on the main loop belongs to the main loop', async ($, on) => {
  const world = engine(on, { during: { toolCall: e => (e.tool === 'Skill' ? expand($) : Promise.resolve()) } })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'notes' })

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'main' })
  expect(capture.via).toBe('skill-tool')
})

test('a skill the Skill tool loads in a subagent belongs to that subagent', async ($, on) => {
  const world = engine(on, { during: { toolCall: e => (e.tool === 'Skill' ? expand($) : Promise.resolve()) } })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'notes', agentId: 'agent-1' })

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'agent', agentId: 'agent-1' })
  expect(capture.via).toBe('skill-tool')
})

test('a skill typed as /name belongs to the main loop', async ($, on) => {
  const world = engine(on, { during: { promptSubmit: () => expand($) } })
  await start($)
  await typed($, 'notes')

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'main' })
  expect(capture.via).toBe('typed')
})

test('a skill preloaded into a spawned agent belongs to that agent', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await expand($)

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'agent', agentId: 'agent-2' })
  expect(capture.via).toBe('agent-preload')
})

// ----------------------------------------------- when not to attribute

test('a skill that loads with nothing open is left unattributed', async ($, on) => {
  const world = engine(on)
  await start($)
  await expand($)

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'unknown' })
  expect(capture.via).toBe('unattributed')
})

test('an agent stops being a preload target at its first tool call', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.txt', agentId: 'agent-2' })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('an agent stops being a preload target when its turn ends', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-a2', agentId: 'agent-2', reason: 'answer' })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('with two agents starting at once, a preloaded skill is left unattributed', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2', 'agent-3'] })
  await start($)
  await spawn($)
  await spawn($)
  await expand($)

  expect((await only($, world)).loop).toEqual({ kind: 'unknown' })
})

test('a refused spawn starts no agent', async ($, on) => {
  const world = engine(on, { spawnAgentIds: [null] })
  await start($)
  const refused = await spawn($)
  await expand($)

  expect(refused.deny).toBe('engine refused the spawn')
  expect((await only($, world)).via).toBe('unattributed')
})

test('a typed command attributes only while its prompt is being submitted', async ($, on) => {
  const world = engine(on)
  await start($)
  await typed($, 'notes')
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('a Skill call for one skill does not claim another', async ($, on) => {
  const world = engine(on, { during: { toolCall: e => (e.tool === 'Skill' ? expand($, 'deploy') : Promise.resolve()) } })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'notes' })

  const capture = await only($, world)
  expect(capture.skill).toBe('deploy')
  expect(capture.via).toBe('unattributed')
})

test('a plugin-qualified name matches the bare one, either way round', async ($, on) => {
  const world = engine(on, {
    during: {
      toolCall: e => (e.tool === 'Skill' ? expand($, 'notes') : Promise.resolve()),
      promptSubmit: () => expand($, 'acme:notes'),
    },
  })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'acme:notes' })
  await typed($, 'notes')

  const all = await settled($, world)
  expect(all.map(capture => capture.via)).toEqual(['skill-tool', 'typed'])
})

test('sameSkill matches a name, or a plugin-qualified name against the bare one', () => {
  expect(sameSkill('notes', 'notes')).toBe(true)
  expect(sameSkill('acme:notes', 'notes')).toBe(true)
  expect(sameSkill('notes', 'acme:notes')).toBe(true)
  expect(sameSkill('acme:notes', 'other:notes')).toBe(false)
  expect(sameSkill('notes', 'notesy')).toBe(false)
  expect(sameSkill('', 'notes')).toBe(false)
})

// ----------------------------------------------------------- the capture

test('a capture keeps the skill as it loaded, with a content hash and the time', async ($, on) => {
  const world = engine(on)
  await start($)
  await $.skill.prompt({
    skill: 'notes',
    text: NOTES_TEXT,
    frontmatter: { description: 'Write a note.', taskmaster: { mode: 'enforce' } },
    frontmatterProblem: 'a key was left out',
    source: 'plugin',
    pluginName: 'acme',
    path: '/home/me/.claude/plugins/acme/skills/notes/SKILL.md',
  })

  const capture = await only($, world)
  expect(capture.skill).toBe('notes')
  expect(capture.text).toBe(NOTES_TEXT)
  expect(capture.frontmatter).toEqual({ description: 'Write a note.', taskmaster: { mode: 'enforce' } })
  expect(capture.frontmatterProblem).toBe('a key was left out')
  expect(capture.source).toBe('plugin')
  expect(capture.pluginName).toBe('acme')
  expect(capture.path).toBe('/home/me/.claude/plugins/acme/skills/notes/SKILL.md')
  expect(capture.hash).toBe(await contentHash(NOTES_TEXT))
  expect(capture.hash).toMatch(NOTES_HASH_HEX)
  expect(capture.at).toBe(1_000)
})

test('contentHash is the SHA-256 of the text, as hex', async () => {
  expect(await contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('only the last 20 skills are kept, newest last', async ($, on) => {
  const world = engine(on)
  await start($)
  for (let n = 1; n <= 21; n += 1) await expand($, `skill-${n}`)

  // Named here: one more skill, as `settled` adds, would push out a capture.
  await until(world, () => captures(world).at(-1)?.skill === 'skill-21')
  const all = captures(world)
  expect(all).toHaveLength(20)
  expect(all[0]?.skill).toBe('skill-2')
  expect(all[19]?.skill).toBe('skill-21')
})

// ------------------------------------------------------ passing through

test('the skill, the Skill call, the typed prompt and the spawn all pass through with the engine\'s answers', async ($, on) => {
  const world = engine(on, {
    spawnAgentIds: ['agent-2'],
    during: { toolCall: e => (e.tool === 'Skill' ? expand($) : Promise.resolve()), promptSubmit: () => expand($) },
  })
  await start($)

  const skill = await expand($)
  expect(skill.text).toBe('engine skill text')
  const call = await $.tool.call({ tool: 'Skill', skill: 'notes' })
  expect(call.result).toEqual({ text: 'engine result' })
  const prompt = await typed($, 'notes')
  expect(prompt.text).toBe('engine: /notes')
  const spawned = await spawn($)
  expect(spawned.agentId).toBe('agent-2')
})

test('a skill that can\'t be recorded still passes through', async ($, on) => {
  engine(on, { failClock: true })
  await start($)

  const skill = await expand($)
  expect(skill.text).toBe('engine skill text')
})

test('two open Skill calls for one skill, in different loops, leave it unattributed', () => {
  const tracker = new SkillTracker()
  tracker.skillCallOpened('toolu_1', 'notes', 'agent-1')
  tracker.skillCallOpened('toolu_2', 'notes', undefined)

  expect(tracker.attribute('notes')).toEqual({ loop: { kind: 'unknown' }, via: 'unattributed' })

  tracker.skillCallClosed('toolu_2')
  expect(tracker.attribute('notes')).toEqual({ loop: { kind: 'agent', agentId: 'agent-1' }, via: 'skill-tool' })
})

test('a Skill call no longer claims the skill once it has answered', async ($, on) => {
  const world = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'notes' })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})
