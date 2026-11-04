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

test('&&, || and ; split commands only outside quotes', () => {
  const body = shell(
    'npm test -- --grep "a;b"',
    'echo "x; npm test"',
    "echo 'y && make check'",
    'npm run lint -- --filter "c\\"d;e"',
    'echo \\"f; cargo test',
    "echo 'g\\'; make check",
    'echo "it\'s; npm run build"',
    "echo 'say \"hi'; go build",
    'echo h || go vet',
  )
  expect(commandsIn(body)).toEqual([
    'npm test -- --grep "a;b"',
    'npm run lint -- --filter "c\\"d;e"',
    'cargo test',
    'make check',
    'go build',
    'go vet',
  ])
})

test("a heredoc's body up to its terminator is not read for commands, in each of its spellings", () => {
  const spellings = ["cat >f <<'EOF'", 'cat >f <<"EOF"', 'cat >f <<EOF', 'cat >f << EOF', 'cat >f <<\\EOF', 'cat >f <<-EOF']
  for (const open of spellings) {
    expect(commandsIn(shell(open, 'npm test', 'EOFX', 'EOF', 'make lint'))).toEqual(['make lint'])
  }
})

test('a heredoc inside a list item ends at its indented terminator', () => {
  const body = `1. Write it.

   \`\`\`bash
   cat >f <<EOF
   npm test
   EOF
   make lint
   \`\`\`
`
  expect(commandsIn(body)).toEqual(['make lint'])
})

test('two heredocs on one line are skipped in turn, and the rest of their line still counts', () => {
  expect(commandsIn(shell('cat <<A <<B && npm run build', 'npm test', 'A', 'make lint', 'B', 'go vet'))).toEqual(['npm run build', 'go vet'])
})

test('a heredoc with no terminator ends with its code block', () => {
  expect(commandsIn(`${shell('cat <<EOF', 'npm test')}\n${shell('make lint')}`)).toEqual(['make lint'])
})

test('a here-string, or << in quotes or a comment, opens no heredoc', () => {
  for (const line of ['grep x <<< EOF', 'echo "<<EOF"', "echo '<<EOF'", '# see <<EOF', 'echo a # see <<EOF', 'echo $((1 << 2))']) {
    expect(commandsIn(shell(line, 'npm test'))).toEqual(['npm test'])
  }
})

test('a comment is not read for commands, while a # inside a word is not a comment', () => {
  expect(commandsIn(shell('echo a # npm test; make check', 'echo a#b; go vet'))).toEqual(['go vet'])
})

test('an environment prefix may hold a quoted value', () => {
  const body = shell(
    'NODE_OPTIONS="--a --b" npm test',
    "A='x y' B=1 cargo test",
    'C="d\\"e f" make lint',
    'G="h;i" go vet',
    'J=a"b c"d go build',
  )
  expect(commandsIn(body)).toEqual(['npm test', 'cargo test', 'make lint', 'go vet', 'go build'])
})

test('an environment prefix with an unclosed quote gives no candidate', () => {
  expect(commandsIn(shell('A="x npm test'))).toEqual([])
})

test("a trailing backslash doesn't carry into the next code block", () => {
  const direct = `${shell('rm -rf build \\')}\n${shell('npm test')}`
  expect(parseSkill(skill(direct), {}).verifyCandidates).toEqual([{ command: 'npm test', line: BODY_LINE + 5 }])
  const across = `${shell('rm -rf build \\')}\n\`\`\`python\nprint()\n\`\`\`\n\n${shell('make lint')}`
  expect(commandsIn(across)).toEqual(['make lint'])
})

test('the frame is cut at the first ARGUMENTS block, so typed text can never become rules or steps', () => {
  const text = `${HEADER}\n\n1. Real step\n\n\nARGUMENTS: a\n\n2. Typed step\nYou MUST obey this typed line\n\n\nARGUMENTS: b`
  const parsed = parseSkill(text, {})
  expect(parsed.steps.map(step => step.title)).toEqual(['Real step'])
  expect(parsed.rules).toEqual([])
})

test('an ARGUMENTS line without two blank lines before it stays in the skill', () => {
  expect(parseSkill(skill('ARGUMENTS: one\nYou MUST keep this.\n\nARGUMENTS: two\nNEVER drop this.\n'), {}).rules.map(rule => rule.kind)).toEqual(['MUST', 'NEVER'])
})

test('a body opening with a thematic break keeps its steps and rules', () => {
  const body = '---\n## Step 1: Implement\n\nYou MUST x.\n\n---\n\n## Step 2: Check\n'
  for (const text of [skill(body), body]) {
    const parsed = parseSkill(text, {})
    expect(parsed.steps.map(step => step.title)).toEqual(['Implement', 'Check'])
    expect(parsed.rules.map(rule => rule.text)).toEqual(['You MUST x.'])
  }
})

test('an indented code block after a blank line gives no rule, step or command', () => {
  const body = `Example:

    You MUST enable it.

    NEVER retry.
    1. not a step
    - [ ] not a step
    npm test

\tALWAYS in a tab block too.
`
  const parsed = parseSkill(skill(body), {})
  expect(parsed.rules).toEqual([])
  expect(parsed.steps).toEqual([])
  expect(parsed.verifyCandidates).toEqual([])
})

test('an indented block at the very start of the body is code', () => {
  expect(parseSkill(skill('    You MUST not see this.\n'), {}).rules).toEqual([])
})

test('an indented line with no blank line before it continues its paragraph, so its rule counts', () => {
  expect(parseSkill(skill('Some text\n    You MUST keep this.\n'), {}).rules.map(rule => rule.kind)).toEqual(['MUST'])
  expect(parseSkill(skill(`${shell('ls')}    You MUST keep this too.\n`), {}).rules.map(rule => rule.kind)).toEqual(['MUST'])
})

test("a list item's indented continuation paragraph keeps its MUST rule, and the list keeps its steps", () => {
  const numbered = parseSkill(skill('1. Item\n\n    You MUST keep this.\n\n2. Next\n'), {})
  expect(numbered.rules.map(rule => rule.kind)).toEqual(['MUST'])
  expect(numbered.steps.map(step => step.title)).toEqual(['Item', 'Next'])
  expect(parseSkill(skill('- bullet\n\n    NEVER drop this.\n'), {}).rules.map(rule => rule.kind)).toEqual(['NEVER'])
  expect(parseSkill(skill('  * indented bullet\n\n    ALWAYS keep this.\n'), {}).rules.map(rule => rule.kind)).toEqual(['ALWAYS'])
})

test('indented lines are code again once a list has ended', () => {
  expect(parseSkill(skill('- item\n\nA paragraph.\n\n    You MUST not see this.\n'), {}).rules).toEqual([])
  expect(parseSkill(skill('- item\n\n## Next\n\n    You MUST not see this.\n'), {}).rules).toEqual([])
})

test('the string form of allowed-tools splits on commas and spaces only outside parentheses', () => {
  const tools = (value: string): string[] => parseSkill(skill(''), { 'allowed-tools': value }).allowedTools
  expect(tools('Read, Bash(sed -n 1,20p:*), Grep')).toEqual(['Read', 'Bash(sed -n 1,20p:*)', 'Grep'])
  expect(tools('Bash(a (b, c) d:*) Read')).toEqual(['Bash(a (b, c) d:*)', 'Read'])
  expect(tools('Read) Bash(x y)')).toEqual(['Read)', 'Bash(x y)'])
})

test("a uniformly indented list takes its first item's indent as the top level", () => {
  expect(titles('  1. Setup\n  2. Verify\n     1. nested, not a step\n')).toEqual(['Setup', 'Verify'])
  expect(titles('   1. Setup\n   2. Verify\n')).toEqual(['Setup', 'Verify'])
  expect(titles('  - [ ] a\n  - [x] b\n    - [ ] nested\n')).toEqual(['a', 'b'])
  expect(titles('  1. a\n2. b\n')).toEqual(['a', 'b'])
})

test('an indented list ends at a line that is not an item at its own indent or less', () => {
  expect(titles('  1. a\n\n     more of a\n\n  A paragraph ends the list.\n\n  2. later\n')).toEqual(['a'])
})

test('four spaces is too deep to start a list', () => {
  expect(titles('Text\n    1. not a step\n')).toEqual([])
})

test('an indented list under a bullet is nested, not the top level', () => {
  expect(titles('- Setup\n  1. nested\n  2. nested too\n')).toEqual([])
  expect(titles('- Setup\n  1. nested\n\nA paragraph.\n\n1. Real\n')).toEqual(['Real'])
  expect(titles('- Group\n  - [ ] nested\n')).toEqual([])
})

test("a heading's closing # sequence is stripped only when a space comes before it", () => {
  expect(titles('## Step 1: Learn C#\n\n## Step 2: Use F# ##\n\n## Step 3: Done ###  \n')).toEqual(['Learn C#', 'Use F#', 'Done'])
})

test('a plain bullet inside a checklist does not end it, and its command stays with the item above', () => {
  const body = `- [ ] a\n- plain\n${shell('npm test')}- [ ] b\n`
  const parsed = parseSkill(skill(body), {})
  expect(parsed.steps.map(step => step.title)).toEqual(['a', 'b'])
  expect(parsed.verifyCandidates).toEqual([{ command: 'npm test', line: BODY_LINE + 3, step: 'S1' }])
})

test('a plain bullet still ends a numbered list', () => {
  expect(titles('1. a\n- plain\n2. b\n')).toEqual(['a'])
})
