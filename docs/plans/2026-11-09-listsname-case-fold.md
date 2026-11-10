# Plan: fold more letters in `listsName`

Status: approved by the owner on 2026-11-09 for writing. Not started. Nothing here has been run in the mod engine.

Every non-ASCII character in this document is written as an escape: a backslash, the letter `u` and four hex
digits. This file holds no non-ASCII byte. In the code and tests below, type each escape as shown, six ASCII
characters, not the letter it stands for. An editing tool may turn an escape into the character itself as it
writes; section 3's escape command puts that right, on new lines only, and must be run where sections 5 and 6
say. Never convert a whole file by other means: `taskmaster/tests/contract.test.ts` already holds one line with a
literal character, and no existing line may change.

This document is the input to three subagents (`tdd-test-writer`, `tdd-implementer`, `tdd-verifier`), which are
specified in `docs/plans/2026-11-09-tdd-subagents-spec.md`. The main conversation (the orchestrator) runs them in
the order of section 9. A person or a single session can also follow it, in the same order.

## 1. The problem

`listsName(entries, child)` in `taskmaster/hooks/contract.ts` says whether a folder's listing holds a name. After
an override file's read fails, the walk in `taskmaster/hooks/register.tsx` calls the file missing only when the
nearest existing folder on its path doesn't list the next name. So:

- a false negative (a name the disk treats as the same, judged different) silently drops an existing override;
- a false positive (a different name judged the same) only adds one debug line. The owner accepted that cost on
  2026-11-09.

Today the key is `name.normalize('NFC').toLowerCase()`. Codex's adversarial review of PR #22 (2026-11-09) found
`listsName([{ name: '\u03C2' }], '\u03A3')` false, though a case-insensitive disk may hold them as one name.

## 2. Decisions already made (don't reopen)

All by the owner, 2026-11-09:

- Scope is this finding only. Issue #23's items are not part of it.
- It lands in a new PR off `main`, after PR #22 merges. PR #22 is not changed.
- Dotted capital I (`\u0130`) matches `i`: "Yes, fold it".
- Three subagents: "Three". Refactor is a step of the implementer, the verifier decides the numbered acceptance
  criteria of section 12: "i like your recommendations".
- A first failed verification gets one automatic second run of the implementer: "One automatic retry". Section 9
  has the rule.
- The agents may make local commits on the fix branch: "Yes, local commits". Push, PR creation and merge each
  need the owner's separate go-ahead and are never done by an agent.

Accepted limits, to be stated in the PR body:

- Full-case merges (`\u00DF` = `SS`, `\uFB01` = `fi`) go beyond NTFS's one-to-one table. They come from
  `toUpperCase` itself.
- `\u0130` = `i` is a hedge, not a measured disk behaviour.
- Both can only cause a false positive.
- No native reproduction exists: no test ran on a real case-insensitive disk.

For this change:

Refactor: none

The reason: section 6 gives the code word for word, and section 8's mutants replace exact lines of it. So the
implementer makes one commit, and the green commit and the final commit are the same commit.

### 2.1 Where this document holds what the agents require

SPEC-020 requires twelve things of an input document. Each agent checks for them before it starts.

| # | Required | Where |
|---|---|---|
| 1 | The test-writer and the implementer may commit locally | Section 2: they may |
| 2 | Commit messages | Red: section 5.4. Green: section 7. Refactor: none needed |
| 3 | The refactor line | `Refactor: none`, above |
| 4 | The tests, their places, and the red result | Sections 5.1, 5.2 and 5.4 |
| 5 | The code change and the document edits | Sections 6 and 7 |
| 6 | The verification commands, their results, and who runs each | Section 10 |
| 7 | The paths allowed to change | Section 11 |
| 8 | Acceptance criteria | Section 12 |
| 9 | The folder for the verifier's disposable worktrees | Section 3: `/tmp/listsname-verify`, nothing to prepare |
| 10 | The test command and its folder | Section 10: `claude plugin test taskmaster`, in `WORKTREE` |
| 11 | The baseline commands and their results | Section 4 |
| 12 | The files of the green commit | Sections 7 and 11 |

## 3. Preconditions and names

| Name | Value |
|---|---|
| Repository | `/home/bryan/Projects/CM` (GitHub `bankielewicz/CM`) |
| Branch | `claude/listsname-case-fold` |
| Worktree (`WORKTREE`) | `/home/bryan/Projects/CM/.claude/worktrees/listsname-case-fold` |
| Base commit (`BASE`) | the branch's commit after the orchestrator's documents commit (step 5 below) |
| Disposable folder | `/tmp/listsname-verify`: where the verifier makes its disposable worktrees, one at a time. It must not exist before the run; `/tmp` does. Nothing prepares one: the test command needs no installed dependency |
| Red commit (`RED`) | the test-writer's commit |
| Final commit (`FINAL`) | the implementer's commit |
| Green commit | the same commit as `FINAL`, because of `Refactor: none`; this document writes `FINAL` for both |

In every command in this document, replace `WORKTREE`, `BASE`, `RED` and `FINAL` by their values, written out in
full, before running it. An agent takes the values from its task message.

The orchestrator, before any agent runs:

1. Runs `gh pr view 22 --repo bankielewicz/CM --json state --jq .state`. If the output isn't `MERGED`, stop and
   tell the owner.
2. Runs `git -C /home/bryan/Projects/CM fetch origin`.
3. Runs `git -C /home/bryan/Projects/CM worktree add --no-track -b claude/listsname-case-fold /home/bryan/Projects/CM/.claude/worktrees/listsname-case-fold origin/main`.
4. Runs `grep -c "export function listsName" WORKTREE/taskmaster/hooks/contract.ts`. If the output isn't `1`,
   stop and tell the owner.
5. Copies this document and `docs/plans/2026-11-09-tdd-subagents-spec.md` into `WORKTREE/docs/plans/`, and
   commits the two files alone with the message `Docs: plan the listsName case fold and its TDD subagents`.
6. Runs `git -C WORKTREE rev-parse HEAD` and records the output as `BASE`. The test-writer stops unless the
   branch is exactly at `BASE`, so nothing is committed between this step and its run.
7. Runs `ls /tmp/listsname-verify`. If the folder exists, stop and tell the owner.
8. If `/home/bryan/Projects/CM/taskmaster/.claude-plugin/types/tsconfig.json` exists, copies the folder
   `/home/bryan/Projects/CM/taskmaster/.claude-plugin/types` to `WORKTREE/taskmaster/.claude-plugin/types`. Git
   ignores that folder, so the status must still be empty by the agents' "A clean worktree" rule. If the file
   doesn't exist, skips this step.

Every command below that has no `-C` option and no absolute path runs in `WORKTREE`: start it with
`cd WORKTREE && `, because a shell's folder doesn't carry from one command to the next. Chain nothing else to it.

### 3.1 The escape command

It takes a mode, `BASE` and a file. In mode `fix` it rewrites every non-ASCII character as an escape, only on
lines that the file didn't hold at `BASE`. In mode `check` it writes nothing. In both it prints one line,
`escaped: E; non-ASCII lines now: N; at BASE: B`. The required result is always `N` equal to `B`.

```sh
cd WORKTREE && node -e "const fs=require('fs'),cp=require('child_process');const [mode,base,file]=process.argv.slice(1);const bad=/[^\x00-\x7F]/;const was=cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'}).split('\n');const old=new Set(was);let e=0;const out=fs.readFileSync(file,'utf8').split('\n').map(l=>old.has(l)||mode!=='fix'?l:l.replace(/[^\x00-\x7F]/g,c=>{e++;return String.fromCharCode(92)+'u'+c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')}));if(mode==='fix')fs.writeFileSync(file,out.join('\n'));console.log('escaped: '+e+'; non-ASCII lines now: '+out.filter(l=>bad.test(l)).length+'; at BASE: '+was.filter(l=>bad.test(l)).length)" MODE BASE FILE
```

Replace `MODE` by `fix` or `check`, and `FILE` by the path relative to `WORKTREE`.

## 4. Baseline (test-writer, first)

Run each and record the output in the reply:

1. `claude plugin test taskmaster`. Record the number of tests passed as `T0`. Every test must pass; if not, stop.
2. `npm ci`, then `npm test`. Record the number of tests passed as `G0`. Every test must pass; if not, stop.

`T0` and `G0` are the counts passed at `BASE`. No count is written in this document on purpose. Only the
test-writer uses `T0` (section 5.4, point 4). The later agents never see the test-writer's reply, so they take
their counts from their own run at `RED`, as section 10 says.

## 5. Red: the tests (test-writer)

Change one file only: `taskmaster/tests/contract.test.ts`. Add three tests. Change or delete no existing line.

### 5.1 Two unit tests

Insert this block directly after the closing `})` of the existing test named
`a folder's listing holds the next name in any case or Unicode form`, with one blank line before it:

```ts
// Codex's adversarial review of #22 (2026-11-09). A case-insensitive disk may fold letters that `toLowerCase` alone
// keeps apart: final sigma, sharp s, long s, dotless and dotted i, the micro sign. Each pair is checked both ways round.
const bothWays = (a: string, b: string) => [listsName([{ name: a }], b), listsName([{ name: b }], a)]

test("a folder's listing holds a name whose letters a case-insensitive disk may fold", () => {
  expect(bothWays('\u03C2', '\u03A3')).toEqual([true, true])
  expect(bothWays('\u03C2', '\u03C3')).toEqual([true, true])
  expect(bothWays('\u03BF\u03B4\u03BF\u03C3', '\u039F\u0394\u039F\u03A3')).toEqual([true, true])
  expect(bothWays('stra\u00DFe', 'STRASSE')).toEqual([true, true])
  expect(bothWays('\u1E9E', 'SS')).toEqual([true, true])
  expect(bothWays('\u017F', 's')).toEqual([true, true])
  expect(bothWays('\u0131', 'I')).toEqual([true, true])
  expect(bothWays('\u00B5', '\u03BC')).toEqual([true, true])
  expect(bothWays('\u0130', 'i')).toEqual([true, true])
  expect(bothWays('I\u0307', 'i')).toEqual([true, true])
  expect(bothWays('D\u0130Z\u0130N', 'dizin')).toEqual([true, true])
  expect(bothWays('i\u0307\u0301', '\u00ED')).toEqual([true, true])
})

test("a folder's listing keeps the matches it had, and still tells apart names no disk folds", () => {
  expect(bothWays('\u1E9E', '\u00DF')).toEqual([true, true])
  expect(bothWays('\u0130', 'i\u0307')).toEqual([true, true])
  expect(bothWays('\u03B1\u0345\u0301', '\u1FB4')).toEqual([true, true])
  expect(bothWays('q\u0307', 'q')).toEqual([false, false])
  expect(bothWays('\u0227', 'a')).toEqual([false, false])
  expect(bothWays('\u00E9', 'e')).toEqual([false, false])
  expect(bothWays('\uFF41', 'a')).toEqual([false, false])
  expect(bothWays('\u03C3', '\u03C4')).toEqual([false, false])
})
```

### 5.2 One hook-level test

Insert this block directly after the closing `})` of the existing test named
`an override folder listed in another Unicode form is set aside too`, with one blank line before it:

```ts
// Codex's adversarial review of #22 (2026-11-09): the same walk, with a folder the disk lists with a final sigma where
// the settings give a capital one.
test('an override folder listed with another form of sigma is set aside too', { options: { overrideDir: 'cfg/\u03A3' } }, async ($, on) => {
  const world = await session($, on, { unreadableFiles: ['/repo/cfg/\u03C2/notes.json'] })
  await load($, {})

  await expectSetAside(world, ['/repo/cfg/\u03A3/notes.json'])
})
```

### 5.3 The pairs, with what was measured

Measured on Node 24.21.0 on 2026-11-09 with the two key functions, not in the mod engine. "Today" is the key at
`BASE`; "Fixed" is the key in section 6. Rows 1 to 12 are the first test, rows 13 to 20 the second.

| Row | Pair | Today | Fixed | Mutants of section 8 that this row fails |
|---|---|---|---|---|
| 1 | `\u03C2` / `\u03A3` | false | true | M1, M5 |
| 2 | `\u03C2` / `\u03C3` | false | true | M1, M5 |
| 3 | `\u03BF\u03B4\u03BF\u03C3` / `\u039F\u0394\u039F\u03A3` | false | true | M1, M5 |
| 4 | `stra\u00DFe` / `STRASSE` | false | true | M1, M5 |
| 5 | `\u1E9E` / `SS` | false | true | M1, M4, M5 |
| 6 | `\u017F` / `s` | false | true | M1, M5 |
| 7 | `\u0131` / `I` | false | true | M1, M5 |
| 8 | `\u00B5` / `\u03BC` | false | true | M1, M5 |
| 9 | `\u0130` / `i` | false | true | M1, M6, M7, M10 |
| 10 | `I\u0307` / `i` | false | true | M1, M6, M7, M10 |
| 11 | `D\u0130Z\u0130N` / `dizin` | false | true | M1, M6, M7, M8, M10 |
| 12 | `i\u0307\u0301` / `\u00ED` | false | true | M1, M3, M6, M7 |
| 13 | `\u1E9E` / `\u00DF` | true | true | M4 |
| 14 | `\u0130` / `i\u0307` | true | true | M10 |
| 15 | `\u03B1\u0345\u0301` / `\u1FB4` | true | true | M2 |
| 16 | `q\u0307` / `q` | false | false | M9, M12 |
| 17 | `\u0227` / `a` | false | false | M12 |
| 18 | `\u00E9` / `e` | false | false | M12 |
| 19 | `\uFF41` / `a` | false | false | M11, M12 |
| 20 | `\u03C3` / `\u03C4` | false | false | M12 |

### 5.4 The red run

First run section 3.1's escape command with `fix`, `BASE` and `taskmaster/tests/contract.test.ts`. Its line must
show the two line counts equal; if not, stop and report.

Then run `claude plugin test taskmaster`. The required result, all four points:

1. `a folder's listing holds a name whose letters a case-insensitive disk may fold` fails.
2. `an override folder listed with another form of sigma is set aside too` fails.
3. `a folder's listing keeps the matches it had, and still tells apart names no disk folds` passes.
4. Exactly two tests fail, and `T0 + 1` pass.

If any point doesn't hold, stop, change nothing more, and report the output. Don't alter a pair to make it fail
or pass.

Then commit that one file with the message `Test: listsName must fold final sigma, sharp s and dotted i (red)`.
Report the commit as `HEAD:` in the reply; the orchestrator records it as `RED`. The commit holds failing tests on
purpose; it is never pushed on its own.

## 6. Green: the code (implementer)

Change one function in `taskmaster/hooks/contract.ts`. Replace the whole of the existing docstring and function,
from the line `/**` directly above ` * Whether a folder's listing holds` to the function's closing `}`, with:

```ts
/**
 * Whether a folder's listing holds `child`, a name that may be the same on its disk (#21): in any case (owner,
 * 2026-11-09), as a case-insensitive disk opens `Notes.json` for `notes.json`, and in any Unicode form (the cold review
 * of #22), as macOS lists in NFD a name the settings give in NFC. Case is folded both ways (Codex's review of #22,
 * 2026-11-09), so letters that `toLowerCase` alone keeps apart match too: final sigma and sigma, sharp s and `SS`, long
 * s and `s`, and dotless or dotted i and `i`. That folds more than some disks do, which costs only a debug line.
 */
export function listsName(entries: readonly { name: string }[], child: string): boolean {
  const key = (name: string): string =>
    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC')
  return entries.some(entry => key(entry.name) === key(child))
}
```

Why each part is there (each is pinned by a mutant in section 8):

- the leading `normalize('NFC')` and first `toLowerCase()` are today's key, so no current match is lost;
- lower, upper, lower: upper then lower alone keeps `\u1E9E` and `\u00DF` apart;
- `replace(/i\u0307/g, 'i')` removes a combining dot only directly after `i`, so `\u0130`, `i\u0307`, `i`, `I`
  and `\u0131` share a key and `q\u0307` stays different from `q`;
- the trailing `normalize('NFC')` recomposes what the removal left;
- NFC, not NFKC, so the fullwidth `\uFF41` stays different from `a`.

After the edit, run section 3.1's escape command with `fix`, `BASE` and `taskmaster/hooks/contract.ts`. Its line
must show the two line counts equal; if not, stop and report.

Change nothing else in `taskmaster/hooks/`. In particular `taskmaster/hooks/register.tsx`, the walk and every
message stay as they are (#21: "No new message").

Don't edit any file under `taskmaster/tests/`. If a test from section 5 can't pass without a test change, stop and
report.

## 7. Green: the documents (implementer)

Three edits, each anchored by text. The fenced blocks in this section are indented three spaces because they sit
in a list; remove those three spaces from every line you copy out of them.

1. `CHANGELOG.md`, under `## Unreleased`, `### Fixed`: add this line directly after the line that starts
   `- Fixed declared contracts (P1.3): an override file under a folder that couldn't be searched`:

   ```text
   - Fixed declared contracts (P1.3): an override whose folder or file name differs from the listed one only by a letter a case-insensitive disk may fold (final sigma, sharp s and `SS`, long s, dotless or dotted i) was still taken for a missing file. It's now set aside with its reason.
   ```

2. `CLAUDE.md`, in the bullet that starts `` - `hooks/contract.ts` is the declared contract (P1.3) ``: replace the
   text

   ```text
   in any case or Unicode form (`listsName`)
   ```

   with

   ```text
   in any case or Unicode form, with final sigma, sharp s, long s and dotless or dotted i folded (`listsName`)
   ```

   If the first text doesn't occur exactly once in the file, stop and report.

3. `docs/phase-1-tasks.md`: add this line directly after the line that starts
   `      - **Not done, because #21 fixes the message`. The new line starts with exactly four spaces, then `- `.
   Run `claude plugin test taskmaster` once after section 6 and before this edit, and replace `T1` with the
   number it reports as passed:

   ```text
       - **Codex's adversarial review of #22 at `fef2068` (2026-11-09), fixed in a follow-up PR:** `listsName` compared with `toLowerCase` alone, so a folder listed with a final sigma for a capital one, a sharp s for `SS`, or a dotted or dotless i was taken for missing and its override dropped. The key now folds case both ways and drops the dot after an `i`. Dotted I as `i`, and sharp s as `SS`, fold more than NTFS does (owner, 2026-11-09: accepted, a false positive costs a debug line). **Tests:** 3 new, T1 in all; red first on the two that hold the finding. No native repro: nothing ran on a case-insensitive disk.
   ```

`docs/taskmaster-plan.md`, `README.md` and every other file: no change.

Then run section 10's commands 1 to 5, and commit the four changed files (`taskmaster/hooks/contract.ts`,
`CHANGELOG.md`, `CLAUDE.md`, `docs/phase-1-tasks.md`) with the message
`Fold final sigma, sharp s and dotted i when matching an override's listed name`. Report the commit as `HEAD:` in
the reply, and as `GREEN:` too; the orchestrator records it as `FINAL`, and gives it to the verifier as both the
green commit and the final commit.

## 8. Mutants (verifier)

Each mutant must make `claude plugin test taskmaster` report at least one failed test.

Where they run: the verifier's disposable worktree at `FINAL`, in the disposable folder `/tmp/listsname-verify`,
a fresh one for each mutant, made, checked with `git diff` and removed as the verifier's own instructions say.
Never in `WORKTREE`: `scripts/find-mods.mjs` counts an untracked folder with a mod manifest under the working
tree as a mod.

To apply a mutant, run the replacement command below, alone, in the disposable worktree:

1. The replacement. This one command takes three lines on standard input: the file's path, the whole line to
   replace, and the whole new line, each exactly as this section gives it, leading spaces included. It prints
   `replaced line N`, or `NOT ONCE: N` with exit 1 when the line to replace isn't in the file exactly once. After
   `NOT ONCE` nothing was replaced, so the verifier's `git diff` is empty and the mutant is not applied.

   ```sh
   cd /tmp/listsname-verify && node -e "const fs=require('fs');const esc=s=>s.replace(/[^\x00-\x7F]/g,c=>String.fromCharCode(92)+'u'+c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0'));const [file,from,to]=fs.readFileSync(0,'utf8').split('\n');const lines=fs.readFileSync(file,'utf8').split('\n');const at=lines.reduce((a,l,i)=>esc(l)===esc(from)?[...a,i]:a,[]);if(at.length!==1){console.log('NOT ONCE: '+at.length);process.exit(1)}lines[at[0]]=to;fs.writeFileSync(file,lines.join('\n'));console.log('replaced line '+(at[0]+1))" <<'EOF'
   <the file's path, relative to the disposable folder>
   <the line to replace>
   <the new line>
   EOF
   ```

   The fence above is indented three spaces; remove them, so that `EOF` starts its line.
2. Then the test command, `cd /tmp/listsname-verify && claude plugin test taskmaster`. Record the names of the
   tests that failed.

The replacement command and section 3.1's escape command were extracted from this file and run on a scratch
repository on 2026-11-09, where both behaved as described. Neither has run on this repository.

M1 to M11 replace this one line of `taskmaster/hooks/contract.ts` (the "key line"):

```ts
    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC')
```

| Mutant | What it is | The key line becomes |
|---|---|---|
| M1 | today's key | `    name.normalize('NFC').toLowerCase()` |
| M2 | no leading normalize | `    name.toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC')` |
| M3 | no trailing normalize | `    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/g, 'i')` |
| M4 | no first toLowerCase | `    name.normalize('NFC').toUpperCase().toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC')` |
| M5 | no toUpperCase | `    name.normalize('NFC').toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC')` |
| M6 | no last toLowerCase | `    name.normalize('NFC').toLowerCase().toUpperCase().replace(/i\u0307/g, 'i').normalize('NFC')` |
| M7 | no replace | `    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')` |
| M8 | replace once, not everywhere | `    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/, 'i').normalize('NFC')` |
| M9 | every combining dot removed | `    name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().replace(/\u0307/g, '').normalize('NFC')` |
| M10 | dot removed before casing | `    name.normalize('NFC').replace(/i\u0307/g, 'i').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')` |
| M11 | NFKC for NFC | `    name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase().replace(/i\u0307/g, 'i').normalize('NFKC')` |

M12 replaces, in `taskmaster/hooks/contract.ts`, the line

```ts
  return entries.some(entry => key(entry.name) === key(child))
```

with

```ts
  return true
```

M13 replaces, in `taskmaster/hooks/register.tsx`, the line

```ts
                  missing = !listsName(await $.fs.list(dir), child)
```

with

```ts
                  missing = !(await $.fs.list(dir)).some(entry => entry.name === child)
```

Expected, from the Node measurement (section 5.3's last column): M1 to M11 each fail one of the two new unit
tests; M12 fails the second new unit test and the existing unit test; M13 fails the new hook-level test and the
existing `an override folder listed in another Unicode form is set aside too`. The requirement is only that each
fails at least one test; a different failing test than expected is reported, not treated as a failure.

## 9. Order of work (orchestrator)

1. Section 3.
2. `tdd-test-writer`: sections 4 and 5. Input: the input document, `WORKTREE`, `BASE`.
3. `tdd-implementer`: sections 6 and 7. Input: the input document, `WORKTREE`, `BASE`, `RED`.
4. `tdd-verifier`: the acceptance criteria of section 12, in their order. Input: the input document, `WORKTREE`,
   `BASE`, `RED`, and `FINAL` twice, as the green commit and as the final commit.
5. Report to the owner with the three replies unedited. Ask for the go-ahead to push and open the PR.

"The input document" is always the copy committed in section 3 step 5,
`WORKTREE/docs/plans/2026-11-09-listsname-case-fold.md`, written out in full.

The agents are `tdd-test-writer`, `tdd-implementer` and `tdd-verifier`, installed as project agents in
`.claude/agents/` from the copies in `/home/bryan/Projects/CM/tdd-agents/` (owner, 2026-11-09). Their text is
DevForgeAI's SPEC-020 version 3 build (commit `df39a82`, in review there, not approved or released). If they are
later installed from the DevForgeAI plugin instead, their names gain the prefix `devforgeai:`. The orchestrator
follows that spec's BEH-11 and BEH-12, read before the run from
`/home/bryan/Projects/DevForgeAI/.claude/worktrees/spec-020-tdd-agents/docs/specs/spec/SPEC-020.md`. In short:

- Start each agent new, in the foreground, with only the task-message lines its description names. Pass no
  agent's reply to another, and never continue a finished agent.
- `RED` is the test-writer's `HEAD:` line; `FINAL` is the implementer's `HEAD:` line, which must equal its
  `GREEN:` line.
- After each agent and before the next, decide yourself whether the status is empty, by the two commands of
  the agents' "A clean worktree" section (sandbox placeholders, which are character devices, don't count), run
  `git -C WORKTREE diff --name-only <previous commit> HEAD`, and compare the paths with section 11.
- The change is done only when the verifier's `VERDICT` is `PASS` and the status is clean at `FINAL`.

Each agent starts in the background, whatever the prompt asks: wait for its completion notice before the checks
and the next agent. The session must be started in `/home/bryan/Projects/CM`, never inside `WORKTREE`: the
repository's Stop hook (`scripts/coverage-stop-hook.mjs`) measures the folder the session started in, and
`WORKTREE` holds failing tests between the red and the green commit, which would block the end of every turn
there.

When something fails, the orchestrator follows SPEC-020's BEH-12 and its error table. For this change that means:

- A stop by any agent, a single-line reply, or a verdict of `INCOMPLETE`, goes to the owner with the replies so
  far.
- A first `FAIL` gets one automatic second run of the implementer only when all of these hold: the verifier's
  `start`, `red` and `end` lines are `REPRODUCED`; no line is `NOT RUN` for a reason this document doesn't allow;
  and every `NOT REPRODUCED` line concerns the implementer's work (a `command` line, the `red to green` paths
  line, or criterion 3 or 4 of section 12). Then, each command run alone: the failed commit is kept as the branch
  `claude/listsname-case-fold-attempt-1`; `/tmp/listsname-verify` is removed with
  `git -C WORKTREE worktree remove --force /tmp/listsname-verify` if `git -C WORKTREE worktree list` shows it;
  `git -C WORKTREE reset --hard RED`; a new implementer with `Previous failure:` and the verifier's
  `NOT REPRODUCED` lines with the output they cite; then a new verifier.
- Anything else goes to the owner with every reply: a failed `start`, `red` or `end` line, a failed
  `base to red` paths line, criterion 1's test-file checks, criterion 2, or a second `FAIL`.
- The backup branch is never pushed; deleting it is the owner's.

## 10. Verification commands

The test command is command 1, `claude plugin test taskmaster`, run in `WORKTREE` (or, for an earlier commit or
a mutant, in the verifier's disposable worktree).

All five are run by both the implementer and the verifier, in `WORKTREE`, in this order. The implementer runs 1
to 5 before committing. The verifier runs 1 to 5 at `FINAL`, and the test command at `RED` in a disposable
worktree, as its own instructions say (expecting section 5.4's points 1 to 3, and exactly two failed tests).

| # | Command | Required at `FINAL` |
|---|---|---|
| 1 | `claude plugin test taskmaster` | no failed test; the number passed equals passed plus failed of the same command at `RED` |
| 2 | `npm run coverage` | exit 0; `taskmaster` at 95% or more for lines and for functions |
| 3 | `npm test` | no failed test |
| 4 | `claude plugin validate taskmaster` | no error; the advice about the icon and the plugin directory is expected |
| 5 | `npx -y -p typescript@5.6 tsc -p taskmaster` | exit 0 and no output |

The run at `RED` is, for the implementer, the first test run it makes before changing anything; for the verifier,
its red check in a disposable worktree. At `RED` the required result is section 5.4's points 1 to 3, and exactly
two failed tests.

Two results may be `NOT RUN`, and this document allows exactly these two reasons and no other:

- Command 5 needs `taskmaster/.claude-plugin/types/tsconfig.json`, which the engine writes when an interactive
  session loads the mod. If that file is absent, command 5 is `NOT RUN` with the reason
  `engine-written types absent`, and its required result counts as holding. Don't create the file and don't claim
  a typecheck.
- The check in a real terminal (`claude --plugin-dir ./taskmaster`) is the owner's. Every agent reports it as
  `NOT RUN` with the reason `the owner's`.

Commands 1 to 4 have no allowed reason not to run.

## 11. Allowed changes (verifier)

The paths allowed to change:

- **Base to red:** `git -C WORKTREE diff --name-only BASE RED` must print exactly
  `taskmaster/tests/contract.test.ts`.
- **Red to green:** `git -C WORKTREE diff --name-only RED FINAL` must print exactly `CHANGELOG.md`, `CLAUDE.md`,
  `docs/phase-1-tasks.md` and `taskmaster/hooks/contract.ts`, and so no path under `taskmaster/tests/`. These
  four are the files of the green commit.
- **Green to final:** none. With `Refactor: none` they are the same commit.

So `git -C WORKTREE diff --name-only BASE FINAL` prints those five paths and no others.

No changed path may be one of the gate's protected files: `coverage-exempt.json`, `package.json`,
`package-lock.json`, `npm-shrinkwrap.json`, `.npmrc`, `.claude/settings.json`, `.claude/settings.local.json`, or
anything under `scripts/` or `.github/workflows/`.

`git -C WORKTREE diff --numstat BASE FINAL -- taskmaster/tests/contract.test.ts` must print one line whose second
number, the deleted lines, is `0`. In `git -C WORKTREE diff BASE FINAL -- taskmaster/tests/contract.test.ts`, the
added lines must be section 5's three tests, the `bothWays` helper, their comments and the blank lines between
them, with an escape and the character it stands for counted as the same.

Section 3.1's escape command with `check` and `BASE`, run once for `taskmaster/tests/contract.test.ts` and once
for `taskmaster/hooks/contract.ts`, must each print `escaped: 0` and two equal line counts.

The first failed check here ends the verifier's work: it reports and stops. The clean status at the end is the
verifier's own `end` check, by its "A clean worktree" rule, and is not repeated here.

## 12. Acceptance criteria

The verifier decides these four, in this order, each by the commands of the section it names and by nothing else.
The values required are in those sections and are not repeated here.

1. **Changed paths.** Every check of section 11 gives the result that section
   requires. A failure of this criterion ends the verifier's work.
2. **Red is reproduced.** At `RED`, by the test command in a disposable worktree: section 5.4's points 1, 2 and
   3 hold, and exactly two tests fail.
3. **Final passes.** At `FINAL`, commands 1 to 5 of section 10 each give the result its table requires. Command 5
   may be `NOT RUN` only for the reason section 10 gives.
4. **Mutants.** Each of M1 to M13 of section 8, run as that section says, makes at least one test fail.
Not acceptance criteria, because no agent can decide them: the check in a real terminal, and whether a real
case-insensitive disk folds these letters. Both are stated as limits in section 2 and go in the PR body. That
13 mutants each failed a test goes in the PR body too, from the verifier's reply.

## 13. Never, for every agent

- Never push, open or edit a PR, or merge.
- Never edit a protected file (section 11), and never look for another way to write one.
- Never weaken, delete or rewrite a test to make it pass, and never hard-code what a test expects.
- Never write a test that prints coverage counters. The gate reads its counters from what tests print.
- Never lower the 95% bar, exclude a file from it, or add an entry to `coverage-exempt.json`.
- Never report a command as run that wasn't, or a result that wasn't seen in that command's output.
