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
    expect(commandsIn(shell(open, 'EOFX', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
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

// ------------------------------------------------------------ Codex's comments after PR #9 merged

test('a line wrapped in triple backticks is inline code, so what follows it still counts', () => {
  const parsed = parseSkill(skill('```npm test```\n\n## Step 1: Implement\n\nYou MUST add a test.\n'), {})
  expect(parsed.steps.map(step => step.title)).toEqual(['Implement'])
  expect(parsed.rules.map(rule => rule.text)).toEqual(['You MUST add a test.'])
  expect(parsed.verifyCandidates).toEqual([])
  expect(titles('````x````\n1. Step\n')).toEqual(['Step'])
})

test("a backtick fence's opening line can't hold another backtick, while a tilde fence's can", () => {
  expect(titles('``` a`b\n\n1. Step\n')).toEqual(['Step'])
  expect(titles('~~~ a`b\n1. code\n~~~\n\n1. Real\n')).toEqual(['Real'])
})

test('a line that only looks like a fence, inside a code block, leaves an open heredoc alone', () => {
  expect(commandsIn(shell('cat <<EOF', '```x```', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn('~~~bash\ncat <<EOF\n```\nnpm test\nEOF\nmake lint\n~~~\n')).toEqual(['make lint'])
})

test('a fence line is never read as a command, opening or closing', () => {
  expect(commandsIn('``` ; npm test\nls\n```\n')).toEqual([])
  expect(commandsIn(shell('cargo test \\'))).toEqual([])
})

test('a heredoc delimiter is the whole word, with its quotes removed', () => {
  const spellings: [string, string][] = [
    ["<<'EOF-JSON'", 'EOF-JSON'],
    ['<<"END OF"', 'END OF'],
    ["<<'123'", '123'],
    ['<<EOF-JSON', 'EOF-JSON'],
    ['<<123', '123'],
    ['<<\\EOF', 'EOF'],
    ['<<E"O"F', 'EOF'],
    ["<<a'b c'd", 'ab cd'],
    ["<< 'A B'", 'A B'],
    ['<<\t EOF', 'EOF'],
    ['<<-EOF', 'EOF'],
    ['<<- EOF', 'EOF'],
    ["<<-'A-B'", 'A-B'],
  ]
  for (const [open, word] of spellings) {
    expect(commandsIn(shell(`cat ${open}`, 'npm test', word, 'make lint'))).toEqual(['make lint'])
  }
})

test('an unquoted heredoc delimiter stops at whitespace or a shell metacharacter', () => {
  for (const stop of [' ', ';', '&', '|', '<', '>', '(', ')']) {
    expect(commandsIn(shell(`cat <<EOF${stop}x`, 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
  }
})

test("a quoted delimiter's quotes don't change how the rest of its line reads", () => {
  expect(commandsIn(shell("cat <<'a;b' && npm run build", 'npm test', 'a;b', 'go vet'))).toEqual(['npm run build', 'go vet'])
})

test('a part of a longer delimiter does not end its heredoc', () => {
  expect(commandsIn(shell("cat <<'EOF-JSON'", 'EOF', 'npm test', 'EOF-JSON', 'make lint'))).toEqual(['make lint'])
})

test('a terminator must match the whole line, and only <<- allows leading tabs', () => {
  for (const line of ['  EOF', '\tEOF', 'EOF ', 'EOFX', 'xEOF']) {
    expect(commandsIn(shell('cat <<EOF', line, 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
  }
  expect(commandsIn(shell('cat <<-EOF', 'npm test', '\t\tEOF', 'make lint'))).toEqual(['make lint'])
  for (const line of ['  EOF', '\t EOF', 'EOF ']) {
    expect(commandsIn(shell('cat <<-EOF', line, 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
  }
})

test('each heredoc on a line keeps its own terminator rule', () => {
  expect(commandsIn(shell('cat <<-A <<B', '\tA', 'npm test', '\tB', 'make lint', 'B', 'go vet'))).toEqual(['go vet'])
})

test("a terminator is matched after the code block's own indent comes off, and no more than that", () => {
  const block = (...lines: string[]): string => `1. Write it.\n\n   \`\`\`bash\n${lines.join('\n')}\n   \`\`\`\n`
  expect(commandsIn(block('   cat <<-EOF', '   npm test', '   \tEOF', '   make lint'))).toEqual(['make lint'])
  expect(commandsIn(block('   cat <<EOF', '     EOF', '   npm test', '   EOF', '   make lint'))).toEqual(['make lint'])
  expect(commandsIn(block('   cat <<EOF', '   npm test', 'EOF', '   make lint'))).toEqual(['make lint'])
  expect(commandsIn(block('   cat <<EOF', '   npm test', '  EOF', '   make lint'))).toEqual(['make lint'])
})

test('with nothing to read as a delimiter, or an unclosed quote, no heredoc opens', () => {
  for (const line of ['cat <<(x', "cat <<'EOF", 'cat <<"EOF', 'cat <<EOF"']) {
    expect(commandsIn(shell(line, 'x', 'npm test'))).toEqual(['npm test'])
  }
})

test('<< inside arithmetic opens no heredoc, with or without the $', () => {
  for (const line of ['((x = 1 << 2))', 'echo $(( (1+2) << 3 ))', 'echo $(( (1)+(2) << 3 ))', 'echo $((a<<b))', 'grep x <<<EOF']) {
    expect(commandsIn(shell(line, 'npm test'))).toEqual(['npm test'])
  }
})

test('arithmetic ends where its parentheses do, so the rest of the line reads as usual', () => {
  expect(commandsIn(shell('x=$((1<<2)); npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('((a || b)) && npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo $((1<<2)) <<EOF', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
})

test('a single parenthesis is not arithmetic, so a heredoc inside one still opens', () => {
  expect(commandsIn(shell('x=$(cat <<EOF', 'npm test', 'EOF', ')', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('(cat <<EOF', 'npm test', 'EOF', ')', 'make lint'))).toEqual(['make lint'])
})

test('only an odd number of trailing backslashes continues a line', () => {
  expect(commandsIn(shell("printf '%s\\n' foo\\\\", 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('cargo test \\', '--all'))).toEqual(['cargo test --all'])
  expect(commandsIn(shell('cargo test \\\\\\', '--all'))).toEqual(['cargo test \\\\ --all'])
})

const rulesIn = (body: string): string[] => parseSkill(skill(body), {}).rules.map(rule => rule.kind)

test("a paragraph after a blank line, at or left of a list's own indent, ends the list", () => {
  expect(titles('  - Overview\n\n  A paragraph outside the list.\n\n  1. Setup\n  2. Verify')).toEqual(['Setup', 'Verify'])
  expect(titles('  - Overview\n\nA paragraph outside the list.\n\n  1. Setup\n')).toEqual(['Setup'])
  expect(rulesIn('  - Overview\n\n  A paragraph.\n\n    You MUST x\n')).toEqual([])
  expect(titles('1. a\n\n   para\n\nnot lazy\n2. b\n')).toEqual(['a'])
})

test('a paragraph deeper than its list stays in it', () => {
  expect(titles('  - Overview\n\n    more of it\n\n  1. nested under it\n')).toEqual([])
  expect(rulesIn('- a\n\n  more of it\n\n    You MUST x\n')).toEqual(['MUST'])
})

test('an outdented item moves the list to its indent', () => {
  expect(rulesIn('  - a\n- b\n\n  deeper than b\n\n    You MUST x\n')).toEqual(['MUST'])
})

test('a line straight after an item is a lazy continuation, and belongs to the item', () => {
  expect(rulesIn('- a\nlazy\n\n    You MUST x\n')).toEqual(['MUST'])
  expect(titles('1. a\nlazy\n2. b\n')).toEqual(['a', 'b'])
  expect(titles('  1. a\n  lazy\n  2. b\n')).toEqual(['a', 'b'])
  expect(titles('- [ ] a\nlazy\n- [ ] b\n')).toEqual(['a', 'b'])
})

test("a line straight after an item's own paragraph is lazy too", () => {
  expect(titles('1. a\n\n   para\nlazy\n2. b\n')).toEqual(['a', 'b'])
})

test('a heading or thematic break is never lazy, while a deeper one stays in the list', () => {
  expect(rulesIn('- a\n## Next\n\n    You MUST x\n')).toEqual([])
  expect(titles('1. a\n## Next\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n---\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n___\n2. b\n')).toEqual(['a'])
  expect(rulesIn('- a\n  ## Sub\n\n    You MUST x\n')).toEqual(['MUST'])
})

test('a line straight after a code block is not lazy', () => {
  expect(titles('1. Run:\n```bash\npytest\n```\nThen this.\n2. b\n')).toEqual(['Run:'])
  expect(rulesIn('- a\n```\nx\n```\nThen this.\n\n    You MUST x\n')).toEqual([])
})

test('code spans stay literal in a title, while emphasis around them goes', () => {
  const body = `1. Edit \`__init__.py\`
2. Run \`__tests__\`
3. Use \`*a*\` here
4. **Run \`npm test\`**
5. \`\`a\`b\`\` and \`_c_\`
6. a \` stray *b*
`
  expect(titles(body)).toEqual(['Edit __init__.py', 'Run __tests__', 'Use *a* here', 'Run npm test', 'a`b and _c_', 'a ` stray b'])
})

test('a code span closes only on a run of its own length, whole', () => {
  expect(titles('1. ```a`` x\n')).toEqual(['```a`` x'])
  expect(titles('1. `a``b`\n')).toEqual(['a``b'])
})

test('the title cap counts the code span, not what stood in for it', () => {
  expect(titles(`1. ${'a'.repeat(115)} \`${'b'.repeat(20)}\`\n`)).toEqual([`${'a'.repeat(115)} bbbb`])
})

test("text that looks like what stands in for a code span is left alone", () => {
  expect(titles('1. \u00009\u0000 x\n')).toEqual(['\u00009\u0000 x'])
})

// ------------------------------------------------------------ PR #16's review

test('arithmetic stays open across lines, so a shift on a later line opens no heredoc', () => {
  expect(commandsIn(shell('echo $((', '  1 << 2', '))', 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('((', '  1 << 2', '))', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('echo $((', '  1 << 2', ')) && npm test'))).toEqual(['npm test'])
})

test("a code block's end closes arithmetic left open in it", () => {
  expect(commandsIn(`${shell('((')}${shell('cat <<EOF', 'npm test', 'EOF', 'make lint')}`)).toEqual(['make lint'])
})

test('closed arithmetic leaves a heredoc on a later line to open as usual', () => {
  expect(commandsIn(shell('x=$((1<<2))', 'cat <<EOF', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
})

test('a line that starts inside arithmetic is still read for commands', () => {
  const [command] = commandsIn(shell('((cd a);', 'npm test)'))
  expect(command?.startsWith('npm test')).toBe(true)
})

test('a spaced thematic break opens no list', () => {
  expect(titles('* * *\nIntro text.\n\n  1. Setup\n  2. Verify\n')).toEqual(['Setup', 'Verify'])
  expect(titles('- - -\nIntro text.\n\n  1. Setup\n  2. Verify\n')).toEqual(['Setup', 'Verify'])
  expect(rulesIn('* * *\nIntro text.\n\n    MUST four\n')).toEqual([])
})

test('a spaced thematic break ends a list at its indent, and a deeper one stays in it', () => {
  expect(titles('1. a\n- - -\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n* * *\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n   - - -\n2. b\n')).toEqual(['a', 'b'])
})

test('a blockquote is never lazy', () => {
  expect(titles('1. First\n> Separate quote\n2. Different list\n')).toEqual(['First'])
  expect(rulesIn('- a\n> quote\n\n    You MUST not see code.\n')).toEqual([])
})

test('an HTML block start of each kind that can interrupt a paragraph is never lazy', () => {
  for (const start of ['<pre>', '<PRE>', '<script>', '<style x>', '<textarea\tx>', '<pre', '<!-- c -->', '<?x?>', '<!DOCTYPE x>', '<![CDATA[x]]>', '<div>', '</div>', '<div/>', '<DIV class="x">', '<div\tx>', '<details']) {
    expect(rulesIn(`- a\n${start}\n\n    You MUST not see code.\n`)).toEqual([])
  }
})

test('any other tag stays lazy, as does text that only looks like a block tag', () => {
  for (const line of ['<kbd>x</kbd> lazy', '<divx>', '<div.x>', '<prefix>', '<pre.x>', '</pre>', '<1>', '<', '<!1']) {
    expect(titles(`1. a\n${line}\n2. b\n`)).toEqual(['a', 'b'])
  }
})

test('a blockquote deeper than its list stays in the list', () => {
  expect(rulesIn('- a\n  > deeper\n\n    You MUST x\n')).toEqual(['MUST'])
})

test('a long run of backslashes inside a shell line takes linear time', () => {
  const started = Date.now()
  expect(commandsIn(shell(`echo ${'\\'.repeat(200000)}x`, 'npm test'))).toEqual(['npm test'])
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a long trailing run of backslashes still continues the line only when odd', () => {
  expect(commandsIn(shell(`echo ${'\\'.repeat(200000)}`, 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell(`echo ${'\\'.repeat(200001)}`, 'npm test'))).toEqual([])
})

test('a literal NUL in a title cannot be mistaken for what stands in for a code span', () => {
  expect(titles('1. \u00000\u0000 and `x`\n')).toEqual(['\u00000\u0000 and x'])
  expect(titles('1. `a\u0000b` c\n')).toEqual(['a\u0000b c'])
})

test("a line four past an item's content, after a blank line, is an indented code block", () => {
  expect(rulesIn('- a\nlazy\n\n      MUST six\n')).toEqual([])
  expect(rulesIn('- a\n\n      MUST six\n')).toEqual([])
  expect(rulesIn('1. a\n\n       MUST seven\n')).toEqual([])
})

test("a line short of that is the item's own paragraph", () => {
  expect(rulesIn('- a\n\n     MUST five\n')).toEqual(['MUST'])
  expect(rulesIn('1. a\n\n      MUST six\n')).toEqual(['MUST'])
})

test("an item's content starts after up to four spaces, or one space past the marker when there are more", () => {
  expect(rulesIn('-    a\n\n        MUST eight\n')).toEqual(['MUST'])
  expect(rulesIn('-     a\n\n      MUST six\n')).toEqual([])
})

test('a spaced thematic break inside a list does not move what counts as content', () => {
  expect(rulesIn('- a\n  - - -\n\n      MUST six\n')).toEqual([])
})

test("a nested item's own paragraph keeps its rule, at any depth", () => {
  expect(rulesIn('- a\n  - b\n\n    MUST four\n')).toEqual(['MUST'])
  expect(rulesIn('- a\n\n    - b\n\n      MUST six\n')).toEqual(['MUST'])
})

test('an item too deep to open a list opens none', () => {
  expect(rulesIn('text\n    - not an item\n\n    You MUST not see code.\n')).toEqual([])
})

test('a list indented under a bullet stays nested, not a list of its own', () => {
  expect(titles('- a\n\n    1. nested\n')).toEqual([])
})

test('an item inside an HTML block is not an item, and the block runs to its blank line', () => {
  expect(titles('<div>\n1. a\n2. b\n')).toEqual([])
  expect(titles('<div>\n- [ ] a\n')).toEqual([])
  expect(rulesIn('<div>\n1. a\nnpm test\n\n      MUST six\n')).toEqual([])
})

test('each other kind of HTML block runs to its own closer', () => {
  for (const [open, close] of [['<!-- c', '-->'], ['<?x', '?>'], ['<!X y', '>'], ['<![CDATA[', ']]>'], ['<pre>', '</pre>']]) {
    expect(titles(`${open}\n1. a\n${close}\n1. b\n`)).toEqual(['b'])
  }
})

test('an HTML block closed on its own line leaves the next line alone', () => {
  for (const line of ['<!-- c -->', '<?x?>', '<!X y>', '<![CDATA[x]]>', '<pre>x</pre>']) {
    expect(titles(`${line}\n1. a\n`)).toEqual(['a'])
  }
})

test('a blank line ends any HTML block, so a list after one is read', () => {
  expect(titles('<div>\n\n1. a\n')).toEqual(['a'])
  expect(titles('<!-- c\n\n1. a\n')).toEqual(['a'])
})

test('a tag that cannot start a block opens no HTML block', () => {
  expect(titles('<span>\n1. a\n')).toEqual(['a'])
})

test('a rule inside an HTML block still counts', () => {
  expect(rulesIn('<details>\nYou MUST x\n</details>\n')).toEqual(['MUST'])
})

test('a block tag deeper than an open list stays in the list', () => {
  expect(titles('1. a\n   <div>\n2. b\n')).toEqual(['a', 'b'])
})

test("tabs count to the next multiple of four, in an item's content and in the lines under it", () => {
  expect(rulesIn('-\tWork\n\n      You MUST add tests.\n')).toEqual(['MUST'])
  expect(rulesIn('  -\tWork\n\n      You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('1.\tWork\n\n       You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('- Work\n\n  \tYou MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('-\tWork\n\n        You MUST x\n')).toEqual([])
  expect(rulesIn('  -\tWork\n\n        You MUST x\n')).toEqual([])
  expect(rulesIn('1.\tWork\n\n        You MUST x\n')).toEqual([])
  expect(rulesIn('- Work\n\n\t\tYou MUST x\n')).toEqual([])
  expect(rulesIn('-\t\tWork\n\n      You MUST x\n')).toEqual([])
})

test('a tab before a nested marker counts to the next multiple of four', () => {
  expect(rulesIn('- a\n\t- b\n\n         You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('- a\n\t- b\n\n          You MUST x\n')).toEqual([])
  expect(rulesIn('- a\n\t-  b\n\n          You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('- a\n\t-  b\n\n           You MUST x\n')).toEqual([])
})

test('a heredoc delimiter keeps a substitution whole, as bash reads it literally', () => {
  expect(commandsIn(shell('cat <<$(echo EOF)', 'npm test', '$(echo EOF)', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$(x)y', 'npm test', '$(x)y', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<`echo E`', 'npm test', '`echo E`', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$(a (b) c)', 'npm test', '$(a (b) c)', 'make lint'))).toEqual(['make lint'])
})

test('a substitution left unclosed in a delimiter opens no heredoc', () => {
  expect(commandsIn(shell('cat <<$(echo', 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('cat <<`echo', 'npm test'))).toEqual(['npm test'])
})

test('a parenthesis that is not a substitution still ends the delimiter', () => {
  expect(commandsIn(shell('x=$(cat <<EOF)', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$X)', 'npm test', '$X', 'make lint'))).toEqual(['make lint'])
})

test('a line of many unclosed substitutions after << takes linear time', () => {
  const started = Date.now()
  for (const opening of ['$(', '${']) {
    expect(commandsIn(shell(`cat <<${opening} `.repeat(20000), 'npm test'))).toEqual(['npm test'])
  }
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a quote in a delimiter closes at the next one of its kind, and brackets at their match', () => {
  expect(commandsIn(shell("cat <<'a\"b'", 'npm test', 'a"b', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<${a{b}c}', 'npm test', '${a{b}c}', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$(a}b)', 'npm test', '$(a}b)', 'make lint'))).toEqual(['make lint'])
})

test("a heredoc delimiter's own metacharacters are not read as shell syntax, while what follows it still is", () => {
  expect(commandsIn(shell('cat <<$(x; npm test)', 'body', '$(x; npm test)', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$(x && npm test)', 'body', '$(x && npm test)', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<$(x) && npm test', 'body', '$(x)', 'make lint'))).toEqual(['npm test', 'make lint'])
})


test('an empty quoted delimiter opens a heredoc that ends at the first empty line, as bash reads it', () => {
  expect(commandsIn(shell("cat <<''", 'npm test', '', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<""', 'npm test', '', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell("cat <<''", 'npm test', 'EOF'))).toEqual([])
})


test('a backslash inside a double-quoted delimiter escapes the next character, and inside single quotes is literal', () => {
  expect(commandsIn(shell('cat <<"a\\"b"', 'make test', 'a"b', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<"a\\\\b"', 'make test', 'a\\b', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<"a\\$b"', 'make test', 'a$b', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<"a\\xb"', 'make test', 'a\\xb', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell("cat <<'a\\b'", 'make test', 'a\\b', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell("cat <<'a\\'", 'make test', 'a\\', 'make lint'))).toEqual(['make lint'])
  expect(commandsIn(shell('cat <<`a\\`b`', 'make test', '`a\\`b`', 'make lint'))).toEqual(['make lint'])
})


test('parentheses that do not close together are subshells, not arithmetic, so the commands in and after them are read', () => {
  expect(commandsIn(shell('((true); npm test; )'))).toEqual(['npm test'])
  expect(commandsIn(shell('((cd a); npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('((cd a) && npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('$((cd a); npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('(((1)); npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('((1)) ; make lint'))).toEqual(['make lint'])
})


test("a subshell's parentheses are not part of its commands, while a substitution's are", () => {
  expect(commandsIn(shell('(cd a; npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('(npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('( npm test ) && make lint'))).toEqual(['npm test', 'make lint'])
  expect(commandsIn(shell('(cd a', 'npm test)'))).toEqual(['npm test'])
  expect(commandsIn(shell('case x in x) npm test;; esac'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo $(npm test)'))).toEqual([])
  expect(commandsIn(shell('npm test $(cat x) && make lint'))).toEqual(['npm test $(cat x)', 'make lint'])
  expect(commandsIn(shell('diff <(npm test) <(make lint)'))).toEqual([])
  expect(commandsIn(shell('npm test -- --grep "(a)"'))).toEqual(['npm test -- --grep "(a)"'])
})


test('a parenthesis where no command may start is a character like any other, as in a diagram in an untagged block', () => {
  expect(commandsIn('```\n├─ Runs formatters (ruff format, biome, shfmt)\n```\n')).toEqual([])
  expect(commandsIn(shell('echo (npm test)'))).toEqual([])
  expect(commandsIn(shell('if (npm test); then echo ok; fi'))).toEqual(['npm test'])
  expect(commandsIn(shell('while ! (make lint); do sleep 1; done'))).toEqual(['make lint'])
  expect(commandsIn(shell('true && (go vet)'))).toEqual(['go vet'])
})


test('a line is lazy only after paragraph text, not after a heading, thematic break, HTML line, setext underline or empty quote in an item', () => {
  for (const block of ['  ### Header', '  ---', '  <!-- c -->', '  <div>\n  </div>', '  Head\n  ===', '  > # q', '  >']) {
    expect(rulesIn(`- a\n\n${block}\nnot lazy\n\n    You MUST not see code.\n`)).toEqual([])
  }
  expect(titles('1. a\n\n   ### Header\ntext\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n\n   ---\ntext\n2. b\n')).toEqual(['a'])
  expect(titles('1. a\n\n   Head\n   ===\ntext\n2. b\n')).toEqual(['a'])
})


test("a line after a blockquote's paragraph, or after a tag that is not a block, is lazy, as that paragraph is still open", () => {
  expect(rulesIn('- a\n\n  > q\nlazy\n\n    You MUST x\n')).toEqual(['MUST'])
  expect(titles('1. a\n\n   > q\nlazy\n2. b\n')).toEqual(['a', 'b'])
  expect(rulesIn('- a\n\n  <span>x</span>\nlazy\n\n    You MUST x\n')).toEqual(['MUST'])
})

test('an indented line straight after a heading, thematic break, setext underline, closed HTML block or empty quote is code, as no paragraph is open', () => {
  expect(rulesIn('# H\n    You MUST not see code.\n')).toEqual([])
  expect(rulesIn('---\n    You MUST not see code.\n')).toEqual([])
  expect(rulesIn('Head\n===\n    You MUST not see code.\n')).toEqual([])
  expect(rulesIn('<!-- c -->\n    You MUST not see code.\n')).toEqual([])
  expect(rulesIn('>\n    You MUST not see code.\n')).toEqual([])
  expect(titles('# H\n    1. not a step\n')).toEqual([])
})

test("an indented line straight after a blockquote's paragraph, a list item or an open HTML block continues it, so its rule counts", () => {
  expect(rulesIn('> q\n    You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('- a\n    You MUST x\n')).toEqual(['MUST'])
  expect(rulesIn('<div>\n    You MUST x\n')).toEqual(['MUST'])
})

test('a code fence inside a blockquote is code: its commands are read with the quote markers off, and its lines are not text', () => {
  expect(commandsIn('> ```bash\n> npm test\n> ```\n')).toEqual(['npm test'])
  expect(rulesIn('> ```\n> You MUST not see code.\n> ```\n')).toEqual([])
  expect(titles('> ```\n> 1. not a step\n> ```\n')).toEqual([])
  expect(commandsIn('> ```bash\n> cat <<EOF\n> npm test\n> EOF\n> make lint\n> ```\n')).toEqual(['make lint'])
  expect(commandsIn('> > ```bash\n> > npm test\n> > ```\n')).toEqual(['npm test'])
  expect(commandsIn('>```bash\n>npm test\n>```\n')).toEqual(['npm test'])
  expect(commandsIn('> ```bash\n> > npm test\n> ```\n')).toEqual([])
})

test("a line without the quote's markers ends the quote, and the fence inside it", () => {
  expect(rulesIn('> ```\n> code\nYou MUST see this.\n')).toEqual(['MUST'])
  expect(commandsIn('> ```bash\n> npm test\n\n```bash\nmake lint\n```\n')).toEqual(['npm test', 'make lint'])
})

test('a setext underline closes only a paragraph at its own level; under an item or quote line at another level, === is lazy text', () => {
  expect(rulesIn('- a\n===\n      MUST six\n')).toEqual(['MUST'])
  expect(rulesIn('> q\n===\n\tMUST x\n')).toEqual(['MUST'])
  expect(rulesIn('  > q\n  ===\n      MUST six\n')).toEqual(['MUST'])
  expect(titles('  1. n\n===\nlazy\n  1. n\n')).toEqual(['n', 'n'])
  expect(titles('1. a\n===\nlazy\n2. b\n')).toEqual(['a', 'b'])
  expect(rulesIn('- a\n  ===\n      MUST six\n')).toEqual([])
  expect(titles('1. a\n   ===\ntext\n2. b\n')).toEqual(['a'])
  expect(rulesIn('Head\n===\n    MUST x\n')).toEqual([])
})

test('a backslash ending a comment continues nothing, because the comment ends at its newline', () => {
  expect(commandsIn(shell('# note \\', 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo \\', '# note \\', 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo "a # b" \\', '&& npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('make lint \\', '# comment', 'npm test'))).toEqual(['make lint', 'npm test'])
  expect(commandsIn(shell('cat <<EOF \\', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
})

test('<< inside $[…] is a shift, as in $((…)), while a bare [ is the test command', () => {
  expect(commandsIn(shell('echo $[1<<2]', 'npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('x=$[1<<2]; npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo $[ (1<<2) ] && npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('[ -f x ] && npm test'))).toEqual(['npm test'])
  expect(commandsIn(shell('echo ${a[1]} <<EOF', 'npm test', 'EOF', 'make lint'))).toEqual(['make lint'])
})
