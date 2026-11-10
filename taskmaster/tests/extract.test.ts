import { expect, test } from 'claude-code/testing'

import { bodyKey, fileBody } from '../hooks/extract'
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
