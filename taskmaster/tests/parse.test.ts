import { expect, test } from 'claude-code/testing'

import { parseSkill } from '../hooks/parse'

// P1.2: the deterministic parse (plan F1.2). The fixtures use the text form
// skill.prompt gives on 2.1.317 (checked live in P1.1): a "Base directory"
// line, a blank line, then the body. No YAML block: frontmatter comes apart.

const HEADER = 'Base directory for this skill: /repo/.claude/skills/x'
const skill = (body: string): string => `${HEADER}\n\n${body}`
// The body starts on line 3 of the text.
const BODY_LINE = 3

const titles = (body: string, frontmatter = {}): string[] => parseSkill(skill(body), frontmatter).steps.map(step => step.title)

// ------------------------------------------------------------ the fixtures the task names

const NUMBERED = `# Release

Ship a release of the package.

1. Run the tests.

   \`\`\`bash
   npm ci && npm test
   \`\`\`

2. Bump the version in \`package.json\`.
3. **Tag** the release and push it.

   You MUST push the tag, or CI won't publish.

## Notes

1. This list is reference material, not more steps.
`

test('a numbered workflow gives one step per top-level item, across paragraphs and code inside items', () => {
  const parsed = parseSkill(skill(NUMBERED), {})

  expect(parsed.steps).toEqual([
    { id: 'S1', title: 'Run the tests.', kind: 'numbered', line: BODY_LINE + 4 },
    { id: 'S2', title: 'Bump the version in package.json.', kind: 'numbered', line: BODY_LINE + 10 },
    { id: 'S3', title: 'Tag the release and push it.', kind: 'numbered', line: BODY_LINE + 11 },
  ])
})

test('a command in an indented code block inside a step is a verify candidate for that step', () => {
  expect(parseSkill(skill(NUMBERED), {}).verifyCandidates).toEqual([{ command: 'npm test', line: BODY_LINE + 7, step: 'S1' }])
})

test('a MUST inside a step is a rule', () => {
  expect(parseSkill(skill(NUMBERED), {}).rules).toEqual([
    { kind: 'MUST', text: "You MUST push the tag, or CI won't publish.", line: BODY_LINE + 13 },
  ])
})

const CHECKLIST = `Before you merge:

- [ ] Run \`make lint\`
- [x] Update the changelog
* [ ] Ask for a review
  - [ ] a nested item, not a step
`

test('a checklist skill gives one step per top-level checklist item, ticked or not', () => {
  expect(titles(CHECKLIST)).toEqual(['Run make lint', 'Update the changelog', 'Ask for a review'])
  expect(parseSkill(skill(CHECKLIST), {}).steps.every(step => step.kind === 'checklist')).toBe(true)
})

const REFERENCE = `# Style guide

Prefer short sentences. Use the active voice.

- Headings are sentence case.
- Lists use a hyphen.

\`\`\`bash
1. not a step: this is code
\`\`\`
`

test('a reference skill yields no steps', () => {
  const parsed = parseSkill(skill(REFERENCE), {})
  expect(parsed.steps).toEqual([])
  expect(parsed.rules).toEqual([])
  expect(parsed.verifyCandidates).toEqual([])
})

// ------------------------------------------------------------ headings

test('"Step N" headings are steps, and win over a numbered list', () => {
  const body = `## Step 1: Plan the change

1. a list inside the first step

## Step 2 - Make it

### step 3
`
  const parsed = parseSkill(skill(body), {})
  expect(parsed.steps.map(step => [step.title, step.kind])).toEqual([
    ['Plan the change', 'heading'],
    ['Make it', 'heading'],
    ['Step 3', 'heading'],
  ])
})

test('numbered headings are steps too', () => {
  expect(titles('## 1. Setup\n\ntext\n\n## 2) Deploy\n')).toEqual(['Setup', 'Deploy'])
})

test('a command under a heading step belongs to that step, until the next heading at its level', () => {
  const body = `## 1. Build

\`\`\`sh
cargo build
\`\`\`

### Details

\`\`\`sh
cargo clippy
\`\`\`

## 2. Ship

\`\`\`
go test ./...
\`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates.map(c => [c.command, c.step])).toEqual([
    ['cargo build', 'S1'],
    ['cargo clippy', 'S1'],
    ['go test ./...', 'S2'],
  ])
})

// ------------------------------------------------------------ lists

test('only the first top-level ordered list gives steps, with lazy numbering and nested items ignored', () => {
  const body = `1. First
1. Second
   1. nested, not a step
1. Third

A paragraph ends the list.

1. A later list
`
  expect(titles(body)).toEqual(['First', 'Second', 'Third'])
})

test('a code block at column 0 between items keeps the list going', () => {
  const body = `1. Run the tests:
\`\`\`bash
pytest
\`\`\`
2. Commit.
`
  expect(titles(body)).toEqual(['Run the tests:', 'Commit.'])
  expect(parseSkill(skill(body), {}).verifyCandidates).toEqual([{ command: 'pytest', line: BODY_LINE + 2, step: 'S1' }])
})

test('a command after the list has ended belongs to no step', () => {
  const body = `1. Write the code.

Then check it:

\`\`\`bash
npm run lint
\`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates).toEqual([{ command: 'npm run lint', line: BODY_LINE + 5 }])
})

test('step titles lose emphasis and code marks, and are capped at 120 characters', () => {
  const long = 'x'.repeat(200)
  expect(titles(`1. **Bold** _it_ \`code\`\n2. ${long}\n`)).toEqual(['Bold it code', 'x'.repeat(120)])
})

// ------------------------------------------------------------ code and rules

test('nothing inside a code block is a step or a rule, whatever its fence', () => {
  const body = `~~~
1. code
You MUST not see this.
~~~

    \`\`\`\`text
    - [ ] code too
    \`\`\`\`
`
  const parsed = parseSkill(skill(body), {})
  expect(parsed.steps).toEqual([])
  expect(parsed.rules).toEqual([])
})

test('a rule is MUST, NEVER or ALWAYS in capitals as a whole word, the first one naming it', () => {
  const body = `NEVER skip the tests, and ALWAYS say so.
You must lowercase this.
MUSTARD is not a rule.
ALWAYS check.`
  expect(parseSkill(skill(body), {}).rules.map(rule => [rule.kind, rule.line])).toEqual([
    ['NEVER', BODY_LINE],
    ['ALWAYS', BODY_LINE + 3],
  ])
})

// ------------------------------------------------------------ verify candidates

test('verify candidates are test, lint, build and typecheck commands, found per segment', () => {
  const body = `\`\`\`console
$ npm install
$ CI=1 npm test
$ npm ci && pnpm run build || yarn lint; echo PASS
$ python -m pytest -q
$ ./gradlew check
$ npx tsc --noEmit
$ npm test
\`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates.map(c => c.command)).toEqual([
    'npm test',
    'pnpm run build',
    'yarn lint',
    'python -m pytest -q',
    './gradlew check',
    'npx tsc --noEmit',
  ])
})

test('a command continued with a backslash is read whole', () => {
  const body = `\`\`\`bash
cargo test \\
  --all-features
\`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates).toEqual([{ command: 'cargo test --all-features', line: BODY_LINE + 1 }])
})

test('only shell code blocks are read for commands', () => {
  const body = `\`\`\`python
pytest
\`\`\`

\`\`\`zsh
make check
\`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates.map(c => c.command)).toEqual(['make check'])
})

// ------------------------------------------------------------ the text's own frame

test('the "Base directory" line and an ARGUMENTS block are not part of the skill', () => {
  const text = `${HEADER}\n\n1. Write the note.\n\n\nARGUMENTS: 2. MUST not be a step`
  const parsed = parseSkill(text, {})
  expect(parsed.steps.map(step => step.title)).toEqual(['Write the note.'])
  expect(parsed.rules).toEqual([])
})

test('a text with no header, such as a command, is read from its first line', () => {
  expect(parseSkill('1. First\n2. Second\n', {}).steps.map(step => [step.title, step.line])).toEqual([
    ['First', 1],
    ['Second', 2],
  ])
})

test('a YAML block at the top of the text is skipped', () => {
  expect(parseSkill('---\nname: x\n1. not a step\n---\n1. A step\n', {}).steps.map(step => step.title)).toEqual(['A step'])
})

// ------------------------------------------------------------ frontmatter

test('name, description and the three frontmatter keys are read', () => {
  const parsed = parseSkill(skill(''), {
    name: ' release ',
    description: 'Ship it.',
    'allowed-tools': 'Read, Grep Bash(git commit:*), Read',
    context: 'fork',
    'disable-model-invocation': true,
  })
  expect(parsed.name).toBe('release')
  expect(parsed.description).toBe('Ship it.')
  expect(parsed.allowedTools).toEqual(['Read', 'Grep', 'Bash(git commit:*)'])
  expect(parsed.forked).toBe(true)
  expect(parsed.modelInvocable).toBe(false)
})

test('allowed-tools may be a list, and keys of the wrong type are ignored', () => {
  const parsed = parseSkill(skill(''), { name: 42, 'allowed-tools': ['Read', 7, ' Edit '], context: 'inline', 'disable-model-invocation': 'yes' })
  expect(parsed.name).toBeUndefined()
  expect(parsed.allowedTools).toEqual(['Read', 'Edit'])
  expect(parsed.forked).toBe(false)
  expect(parsed.modelInvocable).toBe(true)
})

test('a numbered list wins over a checklist', () => {
  expect(titles('- [ ] a checklist item\n\n1. A numbered step\n')).toEqual(['A numbered step'])
})

test('a "Step N" heading may use an em dash or en dash before its title', () => {
  expect(titles('## Step 1 — Is payroll covered?\n\n## Step 2 – Stage the run\n')).toEqual(['Is payroll covered?', 'Stage the run'])
})

test('the same command under two steps is a candidate for each step', () => {
  const body = `1. Write a failing test.

   \`\`\`bash
   npm test
   \`\`\`

2. Implement it.
3. Run the tests again.

   \`\`\`bash
   npm test
   \`\`\`
`
  expect(parseSkill(skill(body), {}).verifyCandidates.map(c => [c.command, c.step])).toEqual([
    ['npm test', 'S1'],
    ['npm test', 'S3'],
  ])
})

const commandsIn = (body: string): string[] => parseSkill(skill(body), {}).verifyCandidates.map(c => c.command)
const shell = (...lines: string[]): string => `\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n`

// ------------------------------------------------------------ PR #9's review

test('CRLF line endings read the same as LF, with the same line numbers', () => {
  for (const body of [NUMBERED, CHECKLIST, '## Step 1: Plan\n\nYou MUST plan.\n\n## Step 2: Do\n']) {
    const text = `${skill(body)}\n\n\nARGUMENTS: You MUST not leak`
    const parsed = parseSkill(text.replace(/\n/g, '\r\n'), {})
    expect(parsed.steps.length).toBeGreaterThan(0)
    expect(parsed).toEqual(parseSkill(text, {}))
  }
})

test('a command under a nested step belongs to the innermost step, and to the outer one again once that ends', () => {
  const body = `## Step 1: Implement

### Step 2: Verify

${shell('npm test')}
### Details

${shell('npm run lint')}`
  expect(parseSkill(skill(body), {}).verifyCandidates.map(c => [c.command, c.step])).toEqual([
    ['npm test', 'S2'],
    ['npm run lint', 'S1'],
  ])
})