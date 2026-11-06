import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { contentHash, sameSkill, SaveQueue, SKILLS_SHAPE, SkillTracker } from '../hooks/skills'
import type { SkillCapture } from '../types'
import { engine, start, stateValue, step, until } from './engine'
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

function spawn($: Engine, extra: { isTeammate?: true; workflow?: { runId: string; agentIndex: number }; resume?: { agentId: string } } = {}) {
  return $.agent.spawn({
    tool_use_id: 'toolu_spawn',
    prompt: 'Summarise the plan.',
    description: 'summarise',
    subagentType: 'notes-writer',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-test',
    background: false,
    fork: false,
    ...extra,
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
  expect('text' in capture).toBe(false)
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

// ---------------------------------------------------------------- saving

// Run first on the code that awaited update() in the hook: a look at what the
// kit does, not a red. The kit answers beneath $.state, so what the real engine
// does comes from a live probe (plan §9).
test('two skills that load at once are both recorded', async ($, on) => {
  const world = engine(on)
  await start($)
  await Promise.all([expand($, 'one'), expand($, 'two')])

  const all = await settled($, world)
  expect(all.map(capture => capture.skill).sort()).toEqual(['one', 'two'])
})

test('a hung $.state holds up no skill', { timeoutMs: 3_000 }, async ($, on) => {
  engine(on, { hangStateWrites: true })
  await start($)

  const skill = await expand($)
  expect(skill.text).toBe('engine skill text')
})

test('captures land in the order the skills loaded, even when the first write is slow', async ($, on) => {
  const world = engine(on, { holdFirstStateWrite: true })
  await start($)
  // Every write, so a late first write can't hide by overwriting a newer list.
  const writes: string[][] = []
  world.onChange.push(function watch() {
    writes.push(captures(world).map(capture => capture.skill))
    world.onChange.push(watch)
  })
  await expand($, 'one')
  await until(world, () => world.stateHeld)
  await expand($, 'two')
  // Time for a second save to reach its write, if anything lets it run this early.
  for (let turn = 0; turn < 5; turn += 1) await contentHash('let other work run')
  expect(writes.filter(list => list.length > 0)).toEqual([])
  world.releaseState()

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['one', 'two'])
  expect(writes.filter(list => list.length > 0).slice(0, 2)).toEqual([['one'], ['one', 'two']])
})

test('captures are written with their shape', async ($, on) => {
  const world = engine(on)
  await start($)
  await settled($, world)

  const written = world.state.get('taskmaster/skills') as { shape?: string; value?: unknown }
  expect(written.shape).toBe(SKILLS_SHAPE)
  expect(Array.isArray(written.value)).toBe(true)
})

test('what a reload kept is added to, not replaced', async ($, on) => {
  const kept = { skill: 'kept', hash: 'abc', loop: { kind: 'main' }, via: 'typed', at: 1 }
  const world = engine(on, { seedState: { 'taskmaster/skills': { shape: SKILLS_SHAPE, value: [kept] } } })
  await start($)
  await expand($, 'new')

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['kept', 'new'])
})

test('a save that fails does not stop the next', async () => {
  const queue = new SaveQueue()
  const ran: string[] = []
  queue.add(async () => {
    ran.push('one')
    throw new Error('save failed')
  })
  queue.add(async () => {
    ran.push('two')
  })
  await queue.idle()

  expect(ran).toEqual(['one', 'two'])
})

test('saves run one at a time, and idle settles once they have finished', async () => {
  const queue = new SaveQueue()
  const ran: string[] = []
  let finishFirst: () => void = () => {}
  const firstHeld = new Promise<void>(resolve => {
    finishFirst = resolve
  })
  queue.add(async () => {
    ran.push('one started')
    await firstHeld
    ran.push('one finished')
  })
  queue.add(async () => {
    ran.push('two')
  })
  const idle = queue.idle()
  await Promise.resolve()
  await Promise.resolve()
  expect(ran).toEqual(['one started'])

  finishFirst()
  await idle
  expect(ran).toEqual(['one started', 'one finished', 'two'])
})

test('a capture that fails leaves one debug line and shows nothing', async ($, on) => {
  const world = engine(on, { failClock: true })
  await start($)
  await expand($)
  await until(world, () => world.logs.length > 0)

  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]?.to).toBe('debug')
  expect(world.logs[0]?.text).toContain('notes')
  expect(world.logs[0]?.text).toContain('clock.now')
  expect(world.logs[0]?.text).not.toContain(NOTES_TEXT)
  expect(world.shown).toEqual([])
})

// ------------------------------------------------- what the capture keeps

const SECRET = 'secret-value'

test('a typed command\'s arguments never reach $.state', async ($, on) => {
  const world = engine(on)
  await start($)
  await $.skill.prompt({
    skill: 'notes',
    text: `Base directory for this skill: /repo/.claude/skills/notes\n\n${NOTES_TEXT}\n\n\nARGUMENTS: ${SECRET}`,
    frontmatter: {},
    source: 'projectSettings',
  })
  await settled($, world)

  expect(JSON.stringify(world.state.get('taskmaster/skills'))).not.toContain(SECRET)
})

test('arguments a skill\'s body took in through $ARGUMENTS never reach $.state', async ($, on) => {
  const world = engine(on)
  await start($)
  await $.skill.prompt({
    skill: 'withargs',
    text: `Base directory for this skill: /repo/.claude/skills/withargs\n\nReport these words back: ${SECRET}`,
    frontmatter: {},
    source: 'projectSettings',
  })
  await settled($, world)

  expect(JSON.stringify(world.state.get('taskmaster/skills'))).not.toContain(SECRET)
})

test('what an earlier version kept, with its text, is read as absent', async ($, on) => {
  const old = { skill: 'old', text: SECRET, hash: 'abc', loop: { kind: 'main' }, via: 'typed', at: 1 }
  const world = engine(on, { seedState: { 'taskmaster/skills': { shape: 'skills-1', value: [old] } } })
  await start($)
  await expand($, 'new')

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['new'])
  expect(JSON.stringify(world.state.get('taskmaster/skills'))).not.toContain(SECRET)
})

// ------------------------------------------------- when the conversation ends

const CLEAR = { reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } } as const

test('a /clear starts the captures over: only the skill loaded after it is held', async ($, on) => {
  const world = engine(on)
  await start($)
  await expand($, 'before')
  await $.session.end(CLEAR)
  await expand($, 'after')

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['after'])
})

test("a session.end while a skill's override file is read keeps that skill out of the list it starts", async ($, on) => {
  const world = engine(on, { holdFirstRead: true })
  await start($)
  const loading = expand($, 'before')
  await until(world, () => world.readHeld)
  await $.session.end(CLEAR)
  world.releaseRead()
  await loading
  await expand($, 'after')

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['after'])
})

test('two skills loading at once land in the order they loaded, while the first one\'s override file is still being read', async ($, on) => {
  const world = engine(on, { holdFirstRead: true })
  await start($)
  const first = expand($, 'first')
  await until(world, () => world.readHeld)
  await expand($, 'second')
  world.releaseRead()
  await first

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['first', 'second'])
})

test('a held override read holds up no skill: the file is read after the hook answers', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { holdFirstRead: true })
  await start($)

  const skill = await expand($)
  expect(skill.text).toBe('engine skill text')
  expect(world.readHeld).toBe(true)
})

test('every session.end starts the captures over, whatever its reason', async ($, on) => {
  const world = engine(on)
  await start($)
  for (const reason of ['resume', 'prompt_input_exit', 'logout', 'other'] as const) {
    await expand($, 'before')
    await $.session.end({ ...CLEAR, reason })
    await expand($, reason)
    const all = await settled($, world)
    expect(all.map(capture => capture.skill)).toEqual([reason])
    await $.session.end(CLEAR)
  }
})

test('a list the empty write left behind is not read back: the held list is what starts over', async ($, on) => {
  const kept = { skill: 'kept', hash: 'abc', loop: { kind: 'main' }, via: 'typed', at: 1 }
  // $.state survives the /clear, and the reset's own write doesn't land.
  const world = engine(on, { seedState: { 'taskmaster/skills': { shape: SKILLS_SHAPE, value: [kept] } }, loseFirstStateWrite: true })
  await start($)
  await $.session.end(CLEAR)
  await expand($, 'after')

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['after'])
})

test('session.end empties what $.state holds, in its shape', async ($, on) => {
  const world = engine(on)
  await start($)
  await settled($, world)
  expect(captures(world)).not.toEqual([])
  await $.session.end(CLEAR)
  await until(world, () => captures(world).length === 0)

  expect(world.state.get('taskmaster/skills')).toEqual({ shape: SKILLS_SHAPE, value: [] })
})

test('saves queued before a /clear land first, and skills loaded after it queue behind the reset', async ($, on) => {
  const world = engine(on, { holdFirstStateWrite: true })
  await start($)
  const writes: string[][] = []
  world.onChange.push(function watch() {
    writes.push(captures(world).map(capture => capture.skill))
    world.onChange.push(watch)
  })
  await expand($, 'before')
  await until(world, () => world.stateHeld)
  await $.session.end(CLEAR)
  await expand($, 'after')
  world.releaseState()

  const all = await settled($, world)
  expect(all.map(capture => capture.skill)).toEqual(['after'])
  expect(writes.filter((list, index) => index === 0 || JSON.stringify(list) !== JSON.stringify(writes[index - 1])).slice(0, 4)).toEqual([[], ['before'], [], ['after']])
})

test('session.end waits on no save, and passes through with the engine\'s answer', { timeoutMs: 3_000 }, async ($, on) => {
  const world = engine(on, { hangStateWrites: true })
  await start($)

  const end = await $.session.end(CLEAR)
  expect(end).toEqual({ sessionId: 'engine-session' })
  expect(world.reached).toContain('session.end')
})

// ------------------------------------------ when two loops could claim a skill

const NOBODY = { loop: { kind: 'unknown' }, via: 'unattributed' }

test('another loop\'s open Skill call and a typed command for one skill leave it unattributed', async ($, on) => {
  const world = engine(on, {
    during: {
      toolCall: e => (e.tool === 'Skill' ? typed($, 'notes') : Promise.resolve()),
      promptSubmit: () => expand($),
    },
  })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'notes', agentId: 'agent-1' })

  expect((await only($, world)).via).toBe('unattributed')
})

test('an open Skill call and an agent that could be preloading the skill leave it unattributed', async ($, on) => {
  const world = engine(on, {
    spawnAgentIds: ['agent-2'],
    during: { toolCall: e => (e.tool === 'Skill' ? expand($) : Promise.resolve()) },
  })
  await start($)
  await spawn($)
  await $.tool.call({ tool: 'Skill', skill: 'notes' })

  expect((await only($, world)).loop).toEqual({ kind: 'unknown' })
})

test('a typed command and a starting agent leave a skill unattributed', () => {
  const tracker = new SkillTracker()
  tracker.typedOpened('notes')
  tracker.spawned('agent-2')

  expect(tracker.attribute('notes')).toEqual(NOBODY)
})

test('a Skill call and a typed command on one loop agree, and the Skill call names the path', () => {
  const tracker = new SkillTracker()
  tracker.typedOpened('notes')
  tracker.skillCallOpened('toolu_1', 'notes', undefined)

  expect(tracker.attribute('notes')).toEqual({ loop: { kind: 'main' }, via: 'skill-tool' })
})

test('an agent\'s own Skill call and its own start agree', () => {
  const tracker = new SkillTracker()
  tracker.spawned('agent-1')
  tracker.skillCallOpened('toolu_1', 'notes', 'agent-1')

  expect(tracker.attribute('notes')).toEqual({ loop: { kind: 'agent', agentId: 'agent-1' }, via: 'skill-tool' })
})

// ----------------------------------------------- when the preload window ends

// Seen live on 2.1.318, in this order: the agent's turn.start, agent.spawn's
// answer, the preloaded skill.prompt (10-52 ms), its first turn.step (20-51 ms),
// its first tool call (2.8-9.5 s). The engine waits for skill.prompt's hooks before
// that first request.

test('an agent stops being a preload target at its first model request', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await step($, 'agent-2')
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('another loop\'s model request does not end an agent\'s preload window', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await step($)
  await step($, 'agent-3')
  await expand($)

  expect((await only($, world)).via).toBe('agent-preload')
})

test('an agent\'s turn.start does not end its preload window, because it fires before the preload', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await $.turn.start({ text: 'Summarise the plan.', turnId: 'turn-a2', agentId: 'agent-2' })
  await expand($)

  expect((await only($, world)).via).toBe('agent-preload')
})

test('an agent that stops ends its preload window', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await $.classic.SubagentStop({
    stop_hook_active: false,
    agent_id: 'agent-2',
    agent_transcript_path: '/repo/agent-2.jsonl',
    agent_type: 'notes-writer',
  })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('an agent that acted before its spawn answered opens no preload window', async ($, on) => {
  const world = engine(on, {
    spawnAgentIds: ['agent-2'],
    during: { agentSpawn: () => $.tool.call({ tool: 'Read', file_path: '/repo/a.txt', agentId: 'agent-2' }) },
  })
  await start($)
  await spawn($)
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('a teammate opens no preload window: one in its own pane fires nothing here', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($, { isTeammate: true })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('a workflow agent opens no preload window: a remote one has no local loop', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 } })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('a resumed run opens no preload window: preloads come before an agent\'s first turn', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($, { resume: { agentId: 'agent-2' } })
  await expand($)

  expect((await only($, world)).via).toBe('unattributed')
})

test('a prompt ends the window of an agent that never acted, so it can\'t block the next skill', async ($, on) => {
  const world = engine(on, {
    spawnAgentIds: ['agent-2'],
    during: { toolCall: e => (e.tool === 'Skill' ? expand($) : Promise.resolve()) },
  })
  await start($)
  await spawn($)
  await $.prompt.submit({ text: 'next, please', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Skill', skill: 'notes' })

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'main' })
  expect(capture.via).toBe('skill-tool')
})

test('a typed command while an agent is starting stays unattributed, and the prompt then ends the window', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'], during: { promptSubmit: () => expand($) } })
  await start($)
  await spawn($)
  await typed($, 'notes')
  await expand($, 'after')

  const all = await settled($, world)
  expect(all.map(capture => capture.via)).toEqual(['unattributed', 'unattributed'])
})

test('a prompt forgets which agents have acted, so the list stays small', () => {
  const tracker = new SkillTracker()
  tracker.acted('agent-2')
  tracker.promptEnded()
  tracker.spawned('agent-2')

  expect(tracker.attribute('notes')).toEqual({ loop: { kind: 'agent', agentId: 'agent-2' }, via: 'agent-preload' })
})

// No event names the skills an agent preloads (agent.spawn, $.agent.list and
// agent.offer don't carry them), so this can't be told from a real preload.
test('known limit: a skill nothing else claims, while one agent starts, goes to that agent', async ($, on) => {
  const world = engine(on, { spawnAgentIds: ['agent-2'] })
  await start($)
  await spawn($)
  await expand($, 'not-one-it-preloads')

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'agent', agentId: 'agent-2' })
  expect(capture.via).toBe('agent-preload')
})

// Seen live on 2.1.318: the capture said main/skill-tool, while the skill's tool
// calls all carried another agent's id, with no agent.spawn to name it.
test('a forked skill stays unattributed: it runs in a loop of its own that nothing open names', async ($, on) => {
  const forked = () => $.skill.prompt({ skill: 'forked', text: NOTES_TEXT, frontmatter: { context: 'fork' }, source: 'projectSettings' })
  const world = engine(on, { during: { toolCall: e => (e.tool === 'Skill' ? forked() : Promise.resolve()) } })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'forked' })

  const capture = await only($, world)
  expect(capture.loop).toEqual({ kind: 'unknown' })
  expect(capture.via).toBe('unattributed')
})

// Issue #12: the engine hands frontmatter past its bounds as `{}`, so a forked skill's `context: fork` can be lost, and
// an open Skill call would then claim it for the caller's loop. Any problem the engine flags leaves the skill unattributed.
test('a skill whose frontmatter the engine flagged stays unattributed, whole or in part, as it may have been forked', async ($, on) => {
  const cases: { frontmatter: Record<string, string>; frontmatterProblem: string }[] = [
    { frontmatter: {}, frontmatterProblem: 'the frontmatter was past its bounds' },
    { frontmatter: { description: 'Write a note.' }, frontmatterProblem: 'a key was left out' },
  ]
  let current = cases[0] as (typeof cases)[number]
  const flagged = () => $.skill.prompt({ skill: 'flagged', text: NOTES_TEXT, ...current, source: 'projectSettings' })
  const world = engine(on, { during: { toolCall: e => (e.tool === 'Skill' ? flagged() : Promise.resolve()) } })
  await start($)
  for (const each of cases) {
    current = each
    await $.tool.call({ tool: 'Skill', skill: 'flagged' })

    const capture = await only($, world)
    expect(capture.loop).toEqual({ kind: 'unknown' })
    expect(capture.via).toBe('unattributed')
    await $.session.end(CLEAR)
  }
})
