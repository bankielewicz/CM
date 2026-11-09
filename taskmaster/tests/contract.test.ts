import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { fromFrontmatter, fromOverride, overrideFile, overrideLookups, pickTier, resolveDeclared, validateDeclared } from '../hooks/contract'
import type { DeclaredContract, SkillCapture } from '../types'
import { engine, start, stateValue, until } from './engine'
import type { EngineOptions, World } from './engine'

// P1.3: the declared contract tiers (plan F1.7, F1.9). Override files are
// JSON (owner decision, 2026-11-04), holding the same object as the
// `taskmaster:` frontmatter block.

type Frontmatter = Parameters<Engine['skill']['prompt']>[0]['frontmatter']

const BLOCK: Frontmatter = {
  mode: 'enforce',
  steps: [
    { id: 'tests', title: 'Run the test suite', verify: { bash: 'npm test' } },
    { id: 'deploy', title: 'Deploy', mandatory: false, when: 'only on release branches' },
  ],
  confirm_before: ['deploy'],
}

const CONTRACT: DeclaredContract = {
  version: 1,
  mode: 'enforce',
  steps: [
    { id: 'tests', title: 'Run the test suite', mandatory: true, verify: { bash: 'npm test', exit: 0 } },
    { id: 'deploy', title: 'Deploy', mandatory: false, when: 'only on release branches' },
  ],
  confirmBefore: ['deploy'],
}

// ------------------------------------------------------------ validateDeclared

test('a valid block becomes a contract, with the defaults filled in', () => {
  expect(validateDeclared(BLOCK)).toEqual({ contract: CONTRACT, problems: [] })
})

test('a minimal block defaults to version 1, enforce, mandatory steps and exit 0', () => {
  const { contract } = validateDeclared({ steps: [{ id: 's1', title: 'One', verify: { bash: 'make test' } }] })
  expect(contract).toEqual({
    version: 1,
    mode: 'enforce',
    steps: [{ id: 's1', title: 'One', mandatory: true, verify: { bash: 'make test', exit: 0 } }],
    confirmBefore: [],
  })
})

test('the provenance keys are kept', () => {
  const { contract } = validateDeclared({ version: 1, origin: 'suggested', suggested_by: 'taskmaster@0.1.0', steps: [] })
  expect(contract?.origin).toBe('suggested')
  expect(contract?.suggestedBy).toBe('taskmaster@0.1.0')
})

test('edits and tool verify specs are kept as written', () => {
  const { contract } = validateDeclared({
    steps: [
      { id: 'a', title: 'A', verify: { edits: 'src/**' } },
      { id: 'b', title: 'B', verify: { tool: 'Write' } },
      { id: 'c', title: 'C', verify: { bash: 'npm test', exit: 1 } },
    ],
  })
  expect(contract?.steps.map(step => step.verify)).toEqual([{ edits: 'src/**' }, { tool: 'Write' }, { bash: 'npm test', exit: 1 }])
})

test('an exit is any status a process can return, 0 to 255', () => {
  for (const exit of [0, 255]) expect(validateDeclared({ steps: [{ id: 'a', title: 'A', verify: { bash: 'x', exit } }] }).contract?.steps[0]?.verify).toEqual({ bash: 'x', exit })
})

test('only a higher version number is called newer; a version written as text, or lower, is told to be 1', () => {
  for (const version of ['1', 0, 1.5, null]) {
    const { contract, problems } = validateDeclared({ version, steps: [] })
    expect(contract).toBeUndefined()
    expect(problems).toEqual(['version must be the number 1'])
  }
  expect(validateDeclared({ version: 2, steps: [] }).problems[0]).toMatch(/version 2 is written for a newer taskmaster/)
})

test('confirm_before names each step once, and a step set aside for its own problem is not reported again as missing', () => {
  const twice = validateDeclared({ steps: [{ id: 'a', title: 'A' }], confirm_before: ['a', 'a'] })
  expect(twice.contract).toBeUndefined()
  expect(twice.problems).toEqual(['confirm_before names "a" more than once'])
  expect(validateDeclared({ steps: [{ id: 'a', title: ' ' }], confirm_before: ['a'] }).problems).toEqual(['step 1 needs a title'])
  for (const notAStep of ['a', null]) {
    expect(validateDeclared({ steps: [notAStep, { id: 'b', title: 'B' }], confirm_before: ['a'] }).problems).toEqual(['step 1 must be an object', 'confirm_before names "a", which is no step'])
  }
})

test('mode: off needs no steps, while any other mode still needs a list, which may be empty', () => {
  expect(validateDeclared({ mode: 'off' })).toEqual({ contract: { version: 1, mode: 'off', steps: [], confirmBefore: [] }, problems: [] })
  expect(validateDeclared({ mode: 'off', steps: [{ id: 'a', title: 'A' }] }).contract?.steps).toEqual([{ id: 'a', title: 'A', mandatory: true }])
  expect(validateDeclared({ mode: 'off', steps: 'one' }).problems).toEqual(['steps must be a list'])
  expect(validateDeclared({}).problems).toEqual(['steps must be a list'])
  expect(validateDeclared({ mode: 'advisory' }).problems).toEqual(['steps must be a list'])
  expect(validateDeclared({ steps: [] }).contract?.steps).toEqual([])
})

// Each of these is invalid, and an invalid contract is never half-used.
const INVALID: [string, unknown, RegExp][] = [
  ['not an object', ['steps'], /object/],
  ['an unknown key', { steps: [], strict: true }, /unknown key "strict"/],
  ['a newer version', { version: 2, steps: [] }, /newer/],
  ['a bad mode', { mode: 'loud', steps: [] }, /mode/],
  ['a blank mode, as YAML reads `mode:` with nothing after it', { mode: null, steps: [] }, /mode/],
  ['steps that aren\'t a list', { steps: 'one' }, /steps/],
  ['a step that isn\'t an object', { steps: ['one'] }, /step 1/],
  ['a step with an unknown key', { steps: [{ id: 'a', title: 'A', owner: 'me' }] }, /unknown key "owner"/],
  ['a step with no id', { steps: [{ title: 'A' }] }, /id/],
  ['a badly formed id', { steps: [{ id: 'run tests', title: 'A' }] }, /id/],
  ['a repeated id', { steps: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }, /repeated/],
  ['a step with no title', { steps: [{ id: 'a', title: '  ' }] }, /title/],
  ['mandatory that isn\'t a boolean', { steps: [{ id: 'a', title: 'A', mandatory: 'yes' }] }, /mandatory/],
  ['when that isn\'t text', { steps: [{ id: 'a', title: 'A', when: 3 }] }, /when/],
  ['verify with two kinds', { steps: [{ id: 'a', title: 'A', verify: { bash: 'x', tool: 'y' } }] }, /verify/],
  ['verify with no kind', { steps: [{ id: 'a', title: 'A', verify: {} }] }, /verify/],
  ['verify with an unknown key', { steps: [{ id: 'a', title: 'A', verify: { edits: 'x', exit: 0 } }] }, /verify/],
  ['a non-integer exit', { steps: [{ id: 'a', title: 'A', verify: { bash: 'x', exit: 'zero' } }] }, /exit/],
  ['a negative exit', { steps: [{ id: 'a', title: 'A', verify: { bash: 'x', exit: -5 } }] }, /exit/],
  ['an exit past 255', { steps: [{ id: 'a', title: 'A', verify: { bash: 'x', exit: 256 } }] }, /exit/],
  ['an exit too large for a process', { steps: [{ id: 'a', title: 'A', verify: { bash: 'x', exit: 1e21 } }] }, /exit/],
  ['an empty command', { steps: [{ id: 'a', title: 'A', verify: { bash: ' ' } }] }, /verify/],
  ['confirm_before naming no step', { steps: [{ id: 'a', title: 'A' }], confirm_before: ['b'] }, /confirm_before/],
  ['confirm_before that isn\'t a list', { steps: [], confirm_before: 'a' }, /confirm_before/],
  ['a bad origin', { origin: 'mine', steps: [] }, /origin/],
  ['a suggested_by that isn\'t text', { suggested_by: 1, steps: [] }, /suggested_by/],
]
for (const [name, value, reason] of INVALID) {
  test(`a block with ${name} is invalid, with a reason`, () => {
    const result = validateDeclared(value)
    expect(result.contract).toBeUndefined()
    expect(result.problems.some(problem => reason.test(problem))).toBe(true)
  })
}

// ------------------------------------------------------------ the tiers

test('the frontmatter tier is the taskmaster: block, when there is one', () => {
  expect(fromFrontmatter({ name: 'x', taskmaster: BLOCK })).toEqual({ contract: CONTRACT, problems: [] })
  expect(fromFrontmatter({ name: 'x' })).toEqual({ problems: [] })
})

test('an invalid block is set aside, with its reason', () => {
  const tier = fromFrontmatter({ taskmaster: { mode: 'loud', steps: [] } })
  expect(tier.contract).toBeUndefined()
  expect(tier.problems).toHaveLength(1)
  expect(tier.problems[0]?.where).toBe('frontmatter')
})

test('with frontmatterProblem set, the frontmatter tier is not used, even with a valid block', () => {
  const dropped = fromFrontmatter({}, 'the frontmatter is not valid YAML')
  expect(dropped.contract).toBeUndefined()
  expect(dropped.problems[0]?.message).toMatch(/not valid YAML/)

  const partial = fromFrontmatter({ taskmaster: BLOCK }, 'a key was left out')
  expect(partial.contract).toBeUndefined()
  expect(partial.problems[0]?.message).toMatch(/a key was left out/)
})

test('an override file saved with a byte-order mark reads the same, as Windows editors often write one', () => {
  expect(fromOverride(`\uFEFF${JSON.stringify(BLOCK)}`)).toEqual({ contract: CONTRACT, problems: [] })
})

test('the override tier reads JSON holding the block itself', () => {
  expect(fromOverride(JSON.stringify(BLOCK))).toEqual({ contract: CONTRACT, problems: [] })
  expect(fromOverride(undefined)).toEqual({ problems: [] })
})

test('an override that isn\'t JSON, or holds an invalid block, is set aside with its reason', () => {
  const broken = fromOverride('mode: enforce')
  expect(broken.contract).toBeUndefined()
  expect(broken.problems[0]).toEqual({ where: 'override', message: expect.stringMatching(/JSON/) })

  const wrapped = fromOverride(JSON.stringify({ taskmaster: BLOCK }))
  expect(wrapped.contract).toBeUndefined()
  expect(wrapped.problems[0]?.message).toMatch(/unknown key "taskmaster"/)
})

test('frontmatter beats an override', () => {
  const resolution = resolveDeclared(fromFrontmatter({ taskmaster: BLOCK }), fromOverride(JSON.stringify({ mode: 'advisory', steps: [] })))
  expect(resolution.source).toBe('frontmatter')
  expect(resolution.contract).toEqual(CONTRACT)
})

test('an invalid block falls back to the override, and keeps the reason', () => {
  const resolution = resolveDeclared(fromFrontmatter({ taskmaster: { steps: 'one' } }), fromOverride(JSON.stringify(BLOCK)))
  expect(resolution.source).toBe('override')
  expect(resolution.contract).toEqual(CONTRACT)
  expect(resolution.problems.map(problem => problem.where)).toEqual(['frontmatter'])
})

test('with neither, there is no declared contract', () => {
  expect(resolveDeclared(fromFrontmatter({}), fromOverride(undefined))).toEqual({ source: 'none', problems: [] })
  expect(resolveDeclared(fromFrontmatter({}))).toEqual({ source: 'none', problems: [] })
})

test('mode: off is still a declared contract', () => {
  const resolution = resolveDeclared(fromFrontmatter({ taskmaster: { mode: 'off', steps: [] } }))
  expect(resolution.source).toBe('frontmatter')
  expect(resolution.contract?.mode).toBe('off')
})

test('the order is frontmatter, then override, then the model, then the parse', () => {
  const declared = (source: 'frontmatter' | 'override' | 'none') => ({ source, problems: [] })
  expect(pickTier({ declared: declared('frontmatter'), llm: true, heuristic: true })).toBe('frontmatter')
  expect(pickTier({ declared: declared('override'), llm: true, heuristic: true })).toBe('override')
  expect(pickTier({ declared: declared('none'), llm: true, heuristic: true })).toBe('llm')
  expect(pickTier({ declared: declared('none'), llm: false, heuristic: true })).toBe('heuristic')
  expect(pickTier({ declared: declared('none'), llm: false, heuristic: false })).toBe('none')
})

// The owner chose plugin-as-folder on 2026-11-06 and approved changing this test's assertions, which named acme_notes.json.
test("an override file is named after the skill, a plugin's name as its folder, and only from parts that can't collide or leave the folder", () => {
  expect(overrideFile('notes')).toBe('notes.json')
  expect(overrideFile('acme:notes')).toBe('acme/notes.json')
  expect(overrideFile('../../etc/passwd')).toBeUndefined()
  expect(overrideFile('a b')).toBeUndefined()
  // Names that shared a file under the old rule now have one each, or none.
  expect(overrideFile('a_b')).toBe('a_b.json')
  expect(overrideFile('a:b')).toBe('a/b.json')
  expect(overrideFile('a:b:c')).toBe('a/b/c.json')
  for (const name of ['é', 'ü', '.hidden', '-x', 'acme:', ':notes', 'acme:..', '']) expect(overrideFile(name)).toBeUndefined()
})

// #21: after a failed read, these say whether the file is missing: the nearest folder that exists, and the name it should list.
test('an override file is looked for from its own folder up to the root, each folder with the next name toward the file', () => {
  expect(overrideLookups('/repo', '.taskmaster/overrides', 'acme/notes.json')).toEqual([
    { dir: '/repo/.taskmaster/overrides/acme', child: 'notes.json' },
    { dir: '/repo/.taskmaster/overrides', child: 'acme' },
    { dir: '/repo/.taskmaster', child: 'overrides' },
    { dir: '/repo', child: '.taskmaster' },
  ])
  expect(overrideLookups('/repo', '.taskmaster/overrides', 'notes.json')).toEqual([
    { dir: '/repo/.taskmaster/overrides', child: 'notes.json' },
    { dir: '/repo/.taskmaster', child: 'overrides' },
    { dir: '/repo', child: '.taskmaster' },
  ])
  expect(overrideLookups('/home/me/project', 'state', 'notes.json').at(-1)).toEqual({ dir: '/home/me/project', child: 'state' })
  // A session rooted at the file system's root, which the read trims to ''.
  expect(overrideLookups('', 'state', 'notes.json')).toEqual([
    { dir: '/state', child: 'notes.json' },
    { dir: '/', child: 'state' },
  ])
})

// ------------------------------------------------------------ in a session

const OVERRIDE_PATH = '/repo/.taskmaster/overrides/notes.json'

/** The capture of the one skill a test loads, once it has landed: saves run after the hook answers. */
async function captured(world: World): Promise<SkillCapture | undefined> {
  const list = () => stateValue(world, 'taskmaster/skills') as SkillCapture[] | undefined
  await until(world, () => (list()?.length ?? 0) > 0)
  return list()?.at(-1)
}

async function load($: Engine, frontmatter: Frontmatter, frontmatterProblem?: string) {
  return $.skill.prompt({
    skill: 'notes',
    text: '1. Write the note.',
    frontmatter,
    ...(frontmatterProblem === undefined ? {} : { frontmatterProblem }),
    source: 'projectSettings',
  })
}

async function session($: Engine, on: Parameters<typeof engine>[0], options: EngineOptions = {}): Promise<World> {
  const world = engine(on, options)
  await start($)
  return world
}

test('a skill with a valid taskmaster: block uses it, and reads no override file', async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify({ steps: [] }) } })
  await load($, { taskmaster: BLOCK })

  expect((await captured(world))?.declared).toEqual({ source: 'frontmatter', contract: CONTRACT, problems: [] })
  expect(world.reads).toEqual([])
})

test('a skill with no block reads its override file from the project\'s override folder', async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify(BLOCK) } })
  await load($, {})

  expect(world.reads).toEqual([OVERRIDE_PATH])
  expect((await captured(world))?.declared).toEqual({ source: 'override', contract: CONTRACT, problems: [] })
})

test("a plugin's skill reads its override file from its plugin's folder", async ($, on) => {
  const world = await session($, on, { files: { '/repo/.taskmaster/overrides/acme/notes.json': JSON.stringify(BLOCK) } })
  await $.skill.prompt({ skill: 'acme:notes', text: '1. Write the note.', frontmatter: {}, source: 'plugin', pluginName: 'acme' })

  expect((await captured(world))?.declared).toEqual({ source: 'override', contract: CONTRACT, problems: [] })
  expect(world.reads).toEqual(['/repo/.taskmaster/overrides/acme/notes.json'])
})

test("a skill whose name can't name a file reads no override, and the debug log says why", async ($, on) => {
  const world = await session($, on)
  await $.skill.prompt({ skill: '../notes', text: '1. Write the note.', frontmatter: {}, source: 'projectSettings' })

  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('none')
  expect(declared?.problems.map(problem => problem.where)).toEqual(['override'])
  expect(declared?.problems[0]?.message).toMatch(/"\.\.\/notes" can't name an override file/)
  expect(world.reads).toEqual([])
  expect(world.logs.map(line => line.to)).toEqual(['debug'])
})

test('the override folder comes from the settings', { options: { overrideDir: 'state/overrides' } }, async ($, on) => {
  const world = await session($, on)
  await load($, {})

  expect(world.reads).toEqual(['/repo/state/overrides/notes.json'])
})

test('a missing override file means no declared contract, and logs nothing', async ($, on) => {
  const world = await session($, on)
  await load($, {})

  expect((await captured(world))?.declared).toEqual({ source: 'none', problems: [] })
  expect(world.logs).toEqual([])
})

test("an override file that is there but can't be read is set aside with its reason, in the debug log", async ($, on) => {
  const world = await session($, on, { unreadableFiles: [OVERRIDE_PATH] })
  await load($, {})

  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('none')
  expect(declared?.problems.map(problem => problem.where)).toEqual(['override'])
  expect(declared?.problems[0]?.message).toMatch(/^the override file couldn't be read: ./)
  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]?.to).toBe('debug')
})

test("a failed read whose file can't be checked is set aside too, rather than taken for a missing file", async ($, on) => {
  const world = await session($, on, { unreadableFiles: [OVERRIDE_PATH], failExists: true })
  await load($, {})

  expect((await captured(world))?.declared.problems[0]?.message).toMatch(/^the override file couldn't be read: ./)
})

// #21: a failed read is a missing file only when the nearest folder that exists lists no such name. A folder that can't
// be searched hides a file from `exists`, but that folder's own listing, or its parent's, still shows it.

/** The one override was set aside with the read's reason, in one debug line, rather than taken for a missing file. */
async function expectSetAside(world: World) {
  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('none')
  expect(declared?.problems.map(problem => problem.where)).toEqual(['override'])
  expect(declared?.problems[0]?.message).toMatch(/^the override file couldn't be read: ./)
  expect(world.logs.map(line => line.to)).toEqual(['debug'])
  expect(world.reads).toEqual([OVERRIDE_PATH])
}

test("an override under a folder that can't be searched is set aside with its reason, not taken for missing", async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify(BLOCK) }, inaccessibleDirs: ['/repo/.taskmaster/overrides'] })
  await load($, {})

  await expectSetAside(world)
})

test("an override under a folder above it that can't be searched is set aside too", async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify(BLOCK) }, inaccessibleDirs: ['/repo/.taskmaster'] })
  await load($, {})

  await expectSetAside(world)
})

test("an override its folder lists but that can't be reached is set aside, as a broken link would be", async ($, on) => {
  const world = await session($, on, { danglingLinks: [OVERRIDE_PATH] })
  await load($, {})

  await expectSetAside(world)
})

// The owner chose on 2026-11-09 to compare listed names without regard to case (Codex's review of #22): on a
// case-insensitive disk, reading `notes.json` opens `Notes.json`, so a listing that holds it in another case doesn't
// show the file is missing. On a case-sensitive disk, such a file gives a debug line where it gave none.
test('an override its folder lists in another case is set aside, as a case-insensitive disk may have opened it', async ($, on) => {
  const world = await session($, on, { unreadableFiles: ['/repo/.taskmaster/overrides/Notes.json'] })
  await load($, {})

  await expectSetAside(world)
})

test('a skill named in capitals whose file is listed in lower case is set aside the same way', async ($, on) => {
  const world = await session($, on, { unreadableFiles: [OVERRIDE_PATH] })
  await $.skill.prompt({ skill: 'Notes', text: '1. Write the note.', frontmatter: {}, source: 'projectSettings' })

  const declared = (await captured(world))?.declared
  expect(declared?.problems.map(problem => problem.where)).toEqual(['override'])
  expect(world.reads).toEqual(['/repo/.taskmaster/overrides/Notes.json'])
})

test("a plugin's override folder listed in another case is set aside too", async ($, on) => {
  const path = '/repo/.taskmaster/overrides/acme/notes.json'
  const world = await session($, on, {
    files: { '/repo/.taskmaster/overrides/Acme/notes.json': JSON.stringify(BLOCK) },
    inaccessibleDirs: ['/repo/.taskmaster/overrides/Acme'],
  })
  await $.skill.prompt({ skill: 'acme:notes', text: '1. Write the note.', frontmatter: {}, source: 'plugin', pluginName: 'acme' })

  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('none')
  expect(declared?.problems.map(problem => problem.where)).toEqual(['override'])
  expect(declared?.problems[0]?.message).toMatch(/^the override file couldn't be read: ./)
  expect(world.logs.map(line => line.to)).toEqual(['debug'])
  expect(world.reads).toEqual([path])
})

test('an override folder that holds other files but none for this skill stays silent', async ($, on) => {
  const world = await session($, on, { files: { '/repo/.taskmaster/overrides/other.json': '{}' } })
  await load($, {})

  expect((await captured(world))?.declared).toEqual({ source: 'none', problems: [] })
  expect(world.logs).toEqual([])
})

test("a plugin's override folder that isn't there stays silent, though the project folder holds a file of the skill's own name", async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify(BLOCK) } })
  await $.skill.prompt({ skill: 'acme:notes', text: '1. Write the note.', frontmatter: {}, source: 'plugin', pluginName: 'acme' })

  expect((await captured(world))?.declared).toEqual({ source: 'none', problems: [] })
  expect(world.logs).toEqual([])
  expect(world.reads).toEqual(['/repo/.taskmaster/overrides/acme/notes.json'])
})

test('a contract set aside is logged to the debug log, never the transcript', async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: '{ not json' } })
  await load($, { taskmaster: { mode: 'loud', steps: [] } })

  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('none')
  expect(declared?.problems.map(problem => problem.where)).toEqual(['frontmatter', 'override'])
  expect(world.logs).toHaveLength(2)
  expect(world.logs.every(line => line.to === 'debug' && line.text.includes('notes'))).toBe(true)
  expect(world.shown).toEqual([])
})

test('a skill whose frontmatter the engine flagged falls through to its override', async ($, on) => {
  const world = await session($, on, { files: { [OVERRIDE_PATH]: JSON.stringify(BLOCK) } })
  await load($, { taskmaster: { mode: 'advisory', steps: [] } }, 'a key was left out')

  const declared = (await captured(world))?.declared
  expect(declared?.source).toBe('override')
  expect(declared?.problems[0]?.message).toMatch(/a key was left out/)
})
