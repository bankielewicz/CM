import { expect, test } from 'claude-code/testing'

import { bodyKey, fileBody, validateExtraction } from '../hooks/extract'
import { promptBody } from '../hooks/parse'

// P1.4: the key a skill's extraction is cached under. The strings are skill.prompt's own, seen live on 2.1.322: `path`
// is the skill's SKILL.md, which a mod can read, and a typed command's arguments follow the body as "\n\nARGUMENTS: ".

const DIR = '/repo/.claude/skills/notes'
const BODY = '1. Write the note.\n2. Run `npm test`.\n'
const FILE = `---\nname: notes\ndescription: Write a note.\n---\n${BODY}`
const PROMPT = `Base directory for this skill: ${DIR}\n\n${BODY}`

test("a skill file's body is what follows its frontmatter block", () => {
  expect(fileBody(FILE)).toBe(BODY)
  expect(fileBody(BODY)).toBe(BODY)
  expect(fileBody(`---\r\nname: notes\r\n---\r\n${BODY}`)).toBe(BODY)
  // Only a block that opens the file, and is closed, is frontmatter.
  expect(fileBody(`${BODY}\n---\nnot: frontmatter\n---\n`)).toBe(`${BODY}\n---\nnot: frontmatter\n---\n`)
  expect(fileBody('---\nname: notes\nnever closed\n')).toBe('---\nname: notes\nnever closed\n')
  expect(fileBody('---\nname: notes\n---')).toBe('')
  expect(fileBody('---\n---\nBody.\n')).toBe('Body.\n')
  // A rule line inside the body isn't the block's end.
  expect(fileBody(`---\nname: notes\n---\n${BODY}\n---\nMore.\n`)).toBe(`${BODY}\n---\nMore.\n`)
  expect(fileBody('')).toBe('')
})

test("a prompt's body leaves out the header and a typed command's arguments", () => {
  expect(promptBody(PROMPT)).toBe(BODY)
  expect(promptBody(`${PROMPT}\n\nARGUMENTS: some typed words`)).toBe(BODY)
  expect(promptBody(BODY)).toBe(BODY)
})

test('the key is the same from the file and from the prompt, whatever the folder and the typed words', async () => {
  const key = await bodyKey(fileBody(FILE))
  expect(key).toMatch(/^[0-9a-f]{64}$/)
  expect(await bodyKey(promptBody(PROMPT))).toBe(key)
  expect(await bodyKey(promptBody(`${PROMPT}\n\nARGUMENTS: some typed words`))).toBe(key)
  expect(await bodyKey(promptBody(`Base directory for this skill: /elsewhere/notes\n\n${BODY}`))).toBe(key)
})

test('the key ignores line endings and blank lines around the body, and nothing inside it', async () => {
  const key = await bodyKey(BODY)
  expect(await bodyKey(BODY.replace(/\n/g, '\r\n'))).toBe(key)
  expect(await bodyKey(`\n\n${BODY}\n\n`)).toBe(key)
  expect(await bodyKey(BODY.trimEnd())).toBe(key)
  expect(await bodyKey(BODY.replace('Write', 'Read'))).not.toBe(key)
  expect(await bodyKey(BODY.replace('\n2.', '\n\n2.'))).not.toBe(key)
  expect(await bodyKey(`  ${BODY}`)).not.toBe(key)
})

// Why the file comes first: with $ARGUMENTS in the body the typed words are substituted in, and can't be stripped.
test("a body that takes $ARGUMENTS has a stable key only from its file", async () => {
  const body = 'Write a note about: $ARGUMENTS\n'
  const typed = (words: string) => promptBody(`Base directory for this skill: ${DIR}\n\n${body.replace('$ARGUMENTS', words)}`)
  expect(await bodyKey(typed('cats'))).not.toBe(await bodyKey(typed('dogs')))
  expect(await bodyKey(fileBody(`---\nname: notes\n---\n${body}`))).toBe(await bodyKey(body))
})

// Seen live on 2.1.322: a file with no newline at its end gets one blank line before ARGUMENTS, which the frame can't tell
// from the skill's own text. So the prompt's key moves with the typed words there, and only the file's holds.
test("a file with no final newline keeps its typed words in the prompt's body, so only the file's key holds", async () => {
  const bare = BODY.trimEnd()
  const prompt = `Base directory for this skill: ${DIR}\n\n${bare}`
  expect(promptBody(`${prompt}\n\nARGUMENTS: some typed words`)).toBe(`${bare}\n\nARGUMENTS: some typed words`)
  expect(await bodyKey(promptBody(prompt))).toBe(await bodyKey(fileBody(`---\nname: notes\n---\n${bare}`)))
})

// ------------------------------------------------------------ validateExtraction
// F1.3: the model's reply is JSON, checked as strictly as a declared contract and used whole or not at all. Its steps
// and confirm_before are a declared block's, so both kinds of contract read alike. The level is never the model's to set.

const REPLY = {
  kind: 'workflow',
  confidence: 0.9,
  steps: [
    { id: 'S1', title: 'Write the note' },
    { id: 'S2', title: ' Run the tests ', mandatory: false, verify: { bash: 'npm test' } },
  ],
  confirm_before: ['S2'],
}

const problemsOf = (value: unknown) => validateExtraction(JSON.stringify(value)).problems.join('; ')

test("a valid reply becomes an extraction, with a declared contract's defaults filled in", () => {
  expect(validateExtraction(JSON.stringify(REPLY))).toEqual({
    extraction: {
      kind: 'workflow',
      confidence: 0.9,
      steps: [
        { id: 'S1', title: 'Write the note', mandatory: true },
        { id: 'S2', title: 'Run the tests', mandatory: false, verify: { bash: 'npm test', exit: 0 } },
      ],
      confirmBefore: ['S2'],
    },
    problems: [],
  })
  expect(validateExtraction(JSON.stringify({ ...REPLY, confidence: 0 })).extraction?.confidence).toBe(0)
  expect(validateExtraction(JSON.stringify({ ...REPLY, confidence: 1 })).extraction?.confidence).toBe(1)
})

test('a reference or persona skill needs no steps, and a workflow needs at least one', () => {
  for (const kind of ['reference', 'persona']) {
    expect(validateExtraction(JSON.stringify({ kind, confidence: 0.8 }))).toEqual({ extraction: { kind, confidence: 0.8, steps: [], confirmBefore: [] }, problems: [] })
    expect(validateExtraction(JSON.stringify({ kind, confidence: 0.8, steps: [] })).extraction?.steps).toEqual([])
  }
  expect(problemsOf({ kind: 'workflow', confidence: 0.8 })).toBe('steps must be a list')
  expect(problemsOf({ kind: 'workflow', confidence: 0.8, steps: [] })).toBe('a workflow needs at least one step')
})

test('a reply in one code fence is read, and a reply with anything else around it is not JSON', () => {
  const json = JSON.stringify(REPLY, null, 2)
  expect(validateExtraction('```json\n' + json + '\n```').extraction?.kind).toBe('workflow')
  expect(validateExtraction('\n```\n' + json + '\n```\n').extraction?.kind).toBe('workflow')
  for (const reply of ['Here it is:\n```json\n' + json + '\n```', json + '\nDone.', '```json\n' + json + '\n```\nDone.', '', 'workflow']) {
    const { extraction, problems } = validateExtraction(reply)
    expect(extraction).toBeUndefined()
    expect(problems).toEqual([expect.stringMatching(/^the reply is not JSON: /)])
  }
})

test('an invalid reply is set aside whole, with every reason', () => {
  for (const value of [null, [], 'workflow', 3]) expect(problemsOf(value)).toBe('the reply must be an object of keys')
  expect(problemsOf({ ...REPLY, kind: 'guide' })).toBe('kind must be one of workflow, reference, persona')
  expect(problemsOf({ confidence: 0.9, steps: REPLY.steps })).toBe('kind must be one of workflow, reference, persona')
  for (const confidence of [undefined, '0.9', -0.1, 1.1, null]) expect(problemsOf({ ...REPLY, confidence })).toBe('confidence must be a number from 0 to 1')
  // The model doesn't set the level, a version or where the contract came from.
  for (const key of ['mode', 'version', 'origin', 'suggested_by', 'notes']) expect(problemsOf({ ...REPLY, [key]: 'enforce' })).toBe(`unknown key "${key}"`)
  // A declared block's own checks apply to the steps.
  expect(problemsOf({ ...REPLY, steps: [{ id: 'S 1', title: 'Write the note' }], confirm_before: [] })).toBe('step 1 needs an id of letters, digits, - or _')
  expect(problemsOf({ ...REPLY, confirm_before: ['S9'] })).toBe('confirm_before names "S9", which is no step')
  expect(problemsOf({ ...REPLY, steps: 'none' })).toMatch(/^steps must be a list/)
  // Every reason, and nothing half-used.
  const both = validateExtraction(JSON.stringify({ ...REPLY, kind: 'guide', confidence: 2 }))
  expect(both.extraction).toBeUndefined()
  expect(both.problems).toEqual(['kind must be one of workflow, reference, persona', 'confidence must be a number from 0 to 1'])
})
