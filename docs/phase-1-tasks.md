# Phase 1 MVP: tasks

This is the durable task list for the Phase 1 MVP prototype (`docs/taskmaster-plan.md` §9, "Phase 1"). Gate A passed (§10.1, GO, 2026-11-03). The first open item is the next step. Skip an item marked **Waiting on the owner**, and every item that depends on it (each item names what it depends on): its remaining step is the owner's. If that leaves nothing to start, ask the owner the open question rather than working ahead. Claude's built-in task list doesn't survive `/clear` or a new session, so re-create the open items from this file. The ids are `P1.n`. The milestones (M0–M9) are in build order, and each task names what it depends on.

**How every task is done** (`CLAUDE.md`, "Developing a mod"):
1. **Red:** write the listed tests first, and see them fail for the expected reason.
2. **Green:** write the code that passes them.
3. **Coverage:** `npm run coverage` passes, with at least 95% line and function coverage.
4. **Verify:** `claude plugin validate`, then the typecheck. Then load the mod with `claude --plugin-dir ./taskmaster` and check it in a real terminal.

Report the commands with their output. `main` is protected, so each task (or a small group of tasks) lands as its own PR, and both required checks, `mod-coverage` and `gate-guard`, must pass on each one.

**Decisions taken** (defaults; change them here if the owner decides otherwise)
- **Location:** the mod lives at `taskmaster/` in the repo root. The coverage gate treats any folder with `.claude-plugin/plugin.json` and `hooks/hooks.json` as a mod. It isn't exempt: it meets the 95% bar from its first PR.
- **Scope:** Phase 1 covers the main loop only. These stay in Phase 2 (plan §9): G4, the Plan Gate, Drift, the advisory audit, model-based question detection, redirect handling, more than one enforced contract, the Pane, F8.5's auto-draft, F8.7 locking, `/taskmaster contract edit`, `resume --force` and `ref` mode.
- **Spike lessons:** these apply from the first line (plan §9 and `CLAUDE.md`, "Mod API constraints"):
  - one `Io` table of `$` closures, built at `session.start`, with earlier hooks buffering their data,
  - literal `atom` keys,
  - every `.taskmaster/` path anchored to `$.session.root()`,
  - `isReadOnly` read from the real call's `tool.check`,
  - a subagent's answer read from `turn.complete`.

**`spike: <id>` citations** each name a Gate A check. The spike is deleted, so the check's definition is in `hooks/checks.ts` and `RUNBOOK.md` at [`d46b356`](https://github.com/bankielewicz/CM/tree/d46b356/spike/taskmaster-spike), and its result is in plan §10.1.

**Owner decisions** (2026-11-03, on the proposals this list first made)
1. **Resume without the Plan Gate (P1.15).** F8.6 has the Plan Gate make a resumed run reload the skill, rebuild its tasks and read `HANDOFF.md` before any write, and Phase 1 has no Plan Gate. So `/taskmaster resume` reloads the skill and rebuilds the tasks itself, and G3 holds the stop until `HANDOFF.md` has been read.
2. **Legitimate waits (P1.10, P1.17).** Phase 1 recognises a wait from `taskmaster_await_user`, or from a trailing "?" on the last message (F5's fast pre-check). A stop that a trailing "?" lets through is listed in the summary below the answer, so a question can't hide a skipped step. The `$.model.classify` fallback arrives with Phase 2's question detection.
3. **The spike (P1.0b).** Delete it, in the two PRs and the order P1.0b gives.
4. **`sentimentClassifier` waits** (PR #6 review). It's F13.3's optional label of your next prompt after a block. No Phase 1 task builds it, and a privacy setting that does nothing would mislead, so it isn't a setting yet. It comes back with the task that builds it.
5. **Override files are JSON** (2026-11-04, for P1.3). The mod API has no YAML parser, so `.taskmaster/overrides/<skill>.json` holds the `taskmaster:` block's object (plan F1.9).
6. **A personal layer beside the project file, protected against Claude** (2026-11-04). Personal overrides go in `$.store`, keyed by repository and skill. No change made by Claude loosens a contract without the person's yes. Decision 7 settles which layer wins. **Still open:** whether an override may beat a third-party skill's own frontmatter (P1.7b).
7. **The personal layer wins, and the project file is read live** (2026-11-04). The mod takes the person's `$.store` entry first. When there is none, as in a fresh cloud container or on a teammate's machine, it reads the project file, every time: nothing copies the file into the store, so a change to the file reaches everyone without a personal entry. The file is opt-in, written by a person to share a contract (plan F1.9).
8. **A project file that matches the default branch can count as reviewed** (2026-11-04). This needs the repository to run the override guard: a CI check that holds a pull request changing an override file until the owner approves it in a GitHub environment (plan F17.1). The mod can't tell whether a repository runs it, so the trust is opt-in, `overrideTrust: default-branch`. The default, `ask`, asks about a loosening file once per file version and store (P1.7c).

## M0. Scaffold
- [x] P1.0 **Scaffold the mod** (F12, F14). **Done: merged in PR #6.** Create `taskmaster/.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/` and `tests/`, with a test `engine()` helper like the spike's. Add the Phase 1 keys of `userConfig` (F12). At `session.start`, build the `Io` table and flush buffered early events. A startup self-check logs which events fired on this build (F14).
  - **Waits for** the owner's fix to `.github/workflows/mod-coverage.yml:13`, the push filter that gives `main` a coverage baseline. PR #5, merged as `51f0959`, changed it to `branches: [main]`.
  - **The first coverage report.** Every mod so far has been exempt. So the gate has printed "No coverage report: every mod measured here is exempt.", and the "Upload coverage to GitHub" step has been skipped. P1.0 is the first PR to write `coverage/cobertura-coverage.xml`, which makes it the first live run of that upload step (`actions/upload-code-coverage`, with `fail-on-error: false`, so upload errors stay warnings) and of the ruleset's `code_coverage` rule. Report what they actually do, and record it under this task:
    - whether the upload succeeds or only warns,
    - whether the rule reports on the PR,
    - whether the rule compares against a baseline from `main`.

  **Red:** loading the mod registers `session.start`, and the self-check records the events it saw. The config defaults match F12. **Done:** coverage ≥ 95%, validate and typecheck pass, and the mod loads in a terminal with nothing visible.

  **Status (2026-11-03):**
  - The mod is built: 52 tests pass, coverage is 100% of lines (97/97) and functions (44/44), and validate and the typecheck pass.
  - A headless `claude -p --plugin-dir ./taskmaster` run loaded it and saved `self-check/2.1.317`, and no hook failed. With `maxStopBlocks: 99` and `checkpointDir: "/"` in its settings it still loaded: the original manifest refused the same settings with "hooks module did not load".
  - **Review fixes** (PR #6's review, findings 1–10 and 12–14):
    - An out-of-range setting no longer stops the mod loading: `plugin.json` declares no `min`/`max`, and `parseConfig` clamps instead.
    - Folder settings outside the project and all-zero experiment weights are refused.
    - The self-check never holds up an event. Its saves run one at a time, merge the stored record before each write, and write nothing after a failed read.
    - A failing version lookup keeps the record under `unknown`.
    - Every observer's pass-through has its own test. The failing-store and choice tests were checked by mutation: each fails when the code it guards is removed.
  - **Second review round** (`/code-review` of `6a50390`, findings 1–10):
    - **#1:** a hung version lookup holds up no event. `session.start` no longer waits on it; each save does. A hang stops saves for that module instance.
    - **#2:** the self-check starts even when `session.start`'s `next(e)` rejects, which the kit showed it can. The real engine is unproven (plan §9).
    - **#3:** a folder setting inside `.git` falls back to its default.
    - **#4, #5:** comments only. A record's `config` is the last saver's on this machine, and `plugin.json` declares no ranges.
    - **#7, #8:** a running save loop picks up a new `session.start`'s `Io` and build, and events stored under one build no longer reach another build's record. Sessions that can't read their version still share `self-check/unknown`, on purpose.
    - **Deferred:** #6, ±Infinity becomes the default, while `CHANGELOG.md` says "moved into the range". #9, this list never names `writeToolAllowlist`, `metricsWebhook`, `frontmatterNudges`, `checkpointGit: ref` or `rca: auto`.
    - **No change:** #10, `WATCHES_EVERY_EVENT` in `selfcheck.ts` was reported as dead code, but it's an intentional compile-time guard.
  - **Third review round** (`/code-review` of `e94578f`):
    - An unusable version answer keeps the record under `unknown`, not a key like `self-check/undefined`.
    - `plugin.json` and the plan no longer say metrics stay on the machine: by default they're committed with the checkpoints, so a push publishes them.
    - **`plugin.json` drift:** a kit test can't read a file, so no test compares it with `DEFAULTS`. A changed default, a removed option and an added `min` or `max` are caught anyway, and a new test that sets every key catches a retyped key. A one-off comparison found no drift in any of the 20 keys.
    - **Deferred (owner's decision):** a key removed from or added to `plugin.json` stays uncaught. The harm is small, a setting missing from `/config` or one that does nothing, and both show in the `plugin.json` diff.
    - **`session.end` at exit:** the save survived one normal exit. The hook settled, the save followed 7 ms later, and the record lists the event. A hard kill wasn't tried.
  - **Finding 11, moved to P1.16.** It noted that `WATCHED` leaves out `session.measure`, `classic.UserPromptSubmit` and `classic.SessionEnd`, and that nothing reads the record yet. P1.16's status will read the record. Each later task adds the events it depends on to `WATCHED`, for example `session.measure` with P1.13's context threshold.
  - **The first coverage report** (PR #6's first CI run, on `3c7a39d`). `taskmaster` isn't exempt, so the gate wrote `coverage/cobertura-coverage.xml` (12,543 bytes) and the upload step ran for the first time.
    - **The upload failed.** The log has `Coverage upload failed (HTTP 404): Not Found` as an error, and `Failed to send status report: HTTP Error 404`. The step and the `mod-coverage` job still passed, because `fail-on-error: false` turns upload errors into warnings. The workflow notes that uploads need Code Quality turned on, which would explain a 404; that's for the owner to check.
    - **The ruleset's `code_coverage` rule reported nothing on the PR.** Its checks list only `mod-coverage` and `gate-guard`, so the rule had no upload to read.
    - **No baseline from `main`.** Every earlier run on `main` was exempt and skipped the upload, and this one failed.

    So the bar is enforced only by the `mod-coverage` check, as before.
  - Checked in an interactive terminal (2026-11-03): loaded with `claude --debug --plugin-dir`, hot reloads and an exit worked, the debug logs show no failed hook, and the owner saw nothing from the mod.
- [ ] P1.0b **Delete the spike** (owner decision 3). **Waiting on the owner: step 2.** Two PRs, in this order:
  1. **Delete `spike/`. Done in PR #7.** A PR removes the folder and updates the paths in `CLAUDE.md` and `README.md`. The `coverage-exempt.json` entry stays for now. The gate looks up exemptions only for the mods it finds (`main()` in `scripts/mod-coverage.mjs`), so it ignores the leftover entry, and `taskmaster/` keeps it from failing with "no mods found". The Gate A record already lives in plan §10.1.
  2. **Remove the exemption entry.** A second PR deletes the `spike/taskmaster-spike` entry from `coverage-exempt.json`. That file is protected: Claude can't edit it (`.claude/settings.json`), and `gate-guard` fails the PR until the owner lifts that check in the ruleset for it. `main` takes no direct pushes, so this step is a PR too.

  Step 2 waits for PR #7 to merge. Removing the entry while `spike/` exists fails `mod-coverage`, because the spike is at 61.58% (`printMod()` in `scripts/mod-coverage.mjs`).

## M1. Contract compiler (F1)
- [x] P1.1 **Capture and attribute** (F1.1). **Done: PR #8.** On `skill.prompt`, capture the skill, frontmatter, source, plugin name, path and a content hash. Attribute it to a loop: through the `Skill` tool's `tool.call.agentId`, through `agent.spawn` for preloaded skills, or to the main loop for a typed `/name` (spike: `skill-attribution`). **Red:** one test per attribution path. *Depends on P1.0.*
  **Status (2026-11-04):**
  - `hooks/skills.ts` captures each skill into `$.state` (`taskmaster.skills`, the newest 20), with a SHA-256 of its text and its loop, saved after the hook answers, and started over at each `session.end`. Not the text itself. 55 new tests, 29 and 6 of them from the two review rounds below; coverage is 99.42% of lines (174 of 175) and 100% of functions. The uncovered line is the reset's failed-write log, listed under the second round's limits.
  - **Attribution, from orders seen live.** Each of these can claim a skill. One loop gets it, and two leave it `unattributed`:
    1. An open `Skill` call whose `skill` matches: `skill.prompt` fires inside the call.
    2. An open `prompt.submit` whose `command` matches: a typed `/name` expands inside `prompt.submit`'s `next(e)`, before the main `turn.start`.
    3. An agent whose spawn has answered and that hasn't reached its first model request: a preloaded skill expands just after `agent.spawn` resolves, and before that request. It has no name to match, so it claims any skill for those few milliseconds.

    With no claim, or a forked skill (`context: fork`), it's `unattributed`.
  - **Checked live**, with a probe mod reading `taskmaster.skills`: typed `/notes` gave `main`/`typed`, the model's `Skill` call gave `main`/`skill-tool`, and a registered agent with `notes` preloaded gave that agent's id with `agent-preload`. A `Skill` call inside a subagent is checked only in the kit; the spike saw it live once.
  - **Mutation checks:** each test fails when its safeguard is removed, 23 mutants in the review round below.
  - **Review round** (PR #8, `/code-review` of `0a4ae95` with Codex's one comment, 2026-11-04):
    - **#1, #4 (Codex's P2):** `attribute()` returned on the first window that matched. It now weighs all three.
    - **#2:** a skill can't be checked against an agent's preloads, because `agent.spawn`, `$.agent.list` and `agent.offer` don't carry the list. It's a stated limit, and a test pins it.
    - **#3:** the window ends at the agent's first `turn.step`, its `classic.SubagentStop` and each `prompt.submit`, as well as its first tool call and turn end. A teammate, a workflow agent and a resumed run open none.
    - **#5:** the save runs in a queue after the hook answers, because the engine holds a skill's load until `skill.prompt`'s hooks answer.
    - **#6: didn't reproduce.** On 2.1.318, six overlapping `update` calls all landed. The save uses a plain `$.state.set` anyway (plan §9).
    - **#7:** a failed capture writes one debug line, and shows nothing.
    - **#8:** the capture keeps no text. Stripping the `ARGUMENTS` block wouldn't be enough, because `$ARGUMENTS` puts the words in the body.
    - **#9:** the `hash` comment no longer calls it a cache key.
    - **#10:** the owner ran the terminal check before this PR merged, recorded below.
    - **Found while fixing:** a forked skill got the caller's loop, confirmed live, so it stays unattributed. And `failStateWrites` never failed a write, so `failClock` replaces it.
    - **Limits:** an agent killed before any closing event stays a claim until the next prompt; a live attempt to test a kill didn't get that far. A rejecting `$.state.set` can't be tested in the kit, which answers beneath it. The self-check shows that `turn.step` fired, not when, so event order needs a live recheck after a Claude Code update, with `docs/probes/event-order.md`.
  - **Second review round** (PR #8, `/code-review` of `453f116`, the owner's decisions D1–D4 and the architect's review, 2026-11-04):
    - **#1, fixed.** `register()` doesn't rerun on `/clear`, so the held list outlived the conversation, and the next save wrote it back. Live on 2.1.318: after `/notes`, `/clear`, `/forked`, `taskmaster.skills` held both. The `session.end` observer now queues a reset, on every reason: the held list becomes `[]`, never `undefined`, which would re-read a `$.state` that survived, and `$.state` gets an empty shaped value. P1.15's cold-start resume is unaffected, because it reloads the skill, which makes a fresh capture.
    - **#2 (D2), kept.** `$` stays in the save closure, and CLAUDE.md's rule now says what the engine's own example shows. The probe's expected results include the capture landing.
    - **#3, #4 (D3), left as they are.** Each needs an event in a window of about 50 ms, and the vote that leaves two claiming loops `unattributed` stays, as Codex's P2 asked. The report case is under the limits below, and claims expiring by age is recorded under P1.6.
    - **#5, no change.** The queued save holds `e` only while a save is slow or hung, and `at` is documented as when it was recorded. Taking `$.clock.now()` early would add an unhandled rejection under a failing clock.
    - **#6 (D4), kept.** `hash` stays, as F1.1 requires, with a guard under P1.12 and P1.18.
    - **#7, no change.** Later hooks live inside `register()`, where `saves` is in scope, so `idle()` is reachable.
    - **#8, no change.** `hasActed` is a few short strings per prompt, and deleting on stop would reopen the race it exists for.
    - **#9, no change.** The `turn.step` wrapper is deliberate (plan §9), and the self-check watches that event anyway.
    - **#10, no change.** The types require `frontmatter`, and P1.3's `fromFrontmatter` assumes it too.
    - **Corrected:** plan §9 gave `origin: 'peer'`. It's `origin: { kind: 'peer' }`, and a background agent's report still showed `peer` when rechecked live.
    - **Tests and mutation checks:** 6 new tests, and no existing test changed. All 9 mutants of the reset were caught: no reset, `captured = undefined` with an old `$.state` and a lost write, no held-list reset, no empty write, an unshaped write, `clear` only, not queued, a hook that waits on the queue, and a dropped `next`.
    - **Limits:** a report arrives as `prompt.submit`, seen as `origin: { kind: 'peer' }`, and clears every starting agent's claim like any other prompt, so a preload in those few milliseconds goes `unattributed`. The reset's failed-write log line can't be tested, because the kit can't make `$.state.set` reject, and the order of `captured = []` and that write is what keeps a failed write from undoing the reset.
    - **Checked live:** the [second check](probes/event-order.md#second-check-clear) in the probe runbook, before and after the fix, on 2.1.318.
  - **Checked in an interactive terminal (2026-11-04, on 2.1.318):** loaded with `claude --debug-file <log> --plugin-dir`, the owner ran `/notes` and an agent with `notes` preloaded and saw nothing from the mod, and the debug log shows it loaded with no failed or skipped hook. P1.2 and P1.3 get the same check before their PRs merge (owner's decision, 2026-11-04). This check predates the second review round's fix, so the owner reruns it before #8 merges.
- [x] P1.2 **Deterministic parse** (F1.2). **Done: PR #9.** Name, description, and the `allowed-tools`, `context: fork` and `disable-model-invocation` frontmatter keys. Numbered or ordered lists, "Step N" headings, `- [ ]` checklists, MUST/NEVER/ALWAYS lines, and test, lint or build commands in code fences (candidate verify commands). **Red:** fixtures for a numbered workflow, a checklist skill, and a reference skill that yields no steps. *Depends on P1.1.*
  **Status (2026-11-04):**
  - `hooks/parse.ts`'s `parseSkill(text, frontmatter)` is pure. It isn't wired to a hook yet: P1.4 builds the contract from it.
  - **Steps come from one source,** in this order: "Step N" or numbered headings (`## 1. Setup`), else the first top-level ordered list, else the first top-level checklist.
    - A list's top level is its first item's indent, up to 3 spaces. An indented item inside another list is nested in it, so it can't start a list.
    - A list runs across blank lines, deeper lines and code blocks. It ends at a line at its own indent or further out that is a marker of another kind, a line that could start a block (a heading, thematic break, blockquote, or HTML block of CommonMark's types 1 to 6), or plain text after a blank line or code block. Plain text straight after other text is a lazy continuation and belongs to the item. A plain bullet doesn't end a checklist.
    - A heading step runs until the next heading at its level or above. A command under nested steps belongs to the innermost.
  - **Rules** are uppercase whole-word `MUST`, `NEVER` or `ALWAYS` outside code. Code includes lines indented four spaces after a blank line. Inside a list that's four spaces past the latest item's content, and anything shallower is the item's own paragraph.
  - **Verify candidates** come from fenced shell code blocks, whatever the fence's indent.
    - Each `&&`, `||` or `;` segment outside quotes is matched separately, with leading `VAR=value` dropped, quoted values included, and `\` continuations joined. Comments and heredoc bodies aren't read, and a code fence ends any continuation or heredoc still open.
    - Each records the step it sits under. A command repeated under another step is kept for that step too, so "run the tests again" keeps its own verify spec.
  - **The text frame:** the "Base directory" line is skipped, and the text is cut at the first `ARGUMENTS` block with two blank lines before it, so typed text can't become rules. A body holding that exact pattern loses its tail. A trailing `\r` is dropped from each line, so line numbers don't change. No YAML block is stripped: `skill.prompt`'s text has none, and a body opening with a `---` thematic break keeps its content.
  - **Tests:** 25 new in the first round. `hooks/parse.ts` has 100% coverage of lines and functions. Eight mutants each fail their own test: step-source order (both ways), lists ending at blank lines, fences only at column 0, heading ranges, nested items, the `ARGUMENTS` block, and `VAR=` prefixes.
  - **Smoke test over 219 real skills on this machine** (bundled and plugin skills, in the real text form):
    - 206 give steps (152 from headings, 53 from a numbered list, 1 from a checklist), and 13 give none.
    - It found one bug, fixed test-first: an em dash after "Step N".
    - Some reference skills' numbered lists of principles read as steps. That's expected: P1.4's model classification (`workflow`, `reference`, `persona`) and the agreement rule decide those.
    - None of those skills has a test, lint or build command in a shell block, so verify candidates are checked in the tests only.
  - **Not yet verified live:** the `ARGUMENTS` separator was seen once, after a body ending in a newline. Whether a body without a trailing newline still gets two blank lines before `ARGUMENTS` is unchecked. This frame-stripping and P1.4's cache key both rely on it.
  - **Review round (2026-11-04, `/code-review` of `7dc1022` with Codex's 10 comments):** 10 findings, each fixed test-first in its own commit, with the fixes this status describes. Codex's comment on repeated commands was already fixed in `1842d46`.
    - **Tests:** 28 new. One was removed by the owner's decision: "a YAML block at the top of the text is skipped", because that behaviour is gone.
    - **Mutation checks:** 64 mutants of the new code, each failing at least one test. One survived the first run, a terminator matched by prefix, and its test was tightened.
    - **Old against new over 1,642 `SKILL.md` files on this machine, in the real text form:** every file parses the same, 8,538 steps and 119 rules. So this is no regression, but those files don't exercise the fixes: only the tests do.
    - **Known limits, kept because this is not a shell parser:** a quoted string spanning lines has its later lines read as commands. An unbalanced `((` leaves arithmetic open to the end of its code block, so nothing after it splits, comments aren't cut and heredocs don't open: a command can be lost, or read from a heredoc body. That's invalid shell unless it closes on a later line.
  - **Second review round (2026-11-04, Codex's 5 comments on `97a68fc`, posted just after #9 merged):** all 5 reproduced. Each is fixed test-first in its own commit, in a follow-up PR.
    - **Fixes:** a line wrapped in triple backticks is inline code, not a fence. A heredoc delimiter is the whole word, its terminator must match the whole line once the block's own indent is off, and `<<` inside arithmetic opens nothing. Only an odd run of trailing backslashes continues a line. A list keeps its own indent, with the end rule above. Code spans stay literal in titles.
    - **A regression, now fixed:** the first round's `a608e4f` cut hyphenated and quoted delimiters short, which lost real commands after the terminator.
    - **Beyond the comments:** a thematic break ends a list like a heading does. Without that, the new lazy-continuation rule would have let `---` straight after an item keep the list going, which it doesn't today.
    - **Tests:** 27 new, and no existing test changed. Of the first 25, 16 failed before any fix, and 9 were guards that passed before and after.
    - **Mutation checks:** 118 mutants, all caught: 53 carried from the first round, and 65 new, which include replacements for the first round's 11 whose code changed. Eight survived the first run. Two showed branches nothing needed, which were deleted, and six showed test gaps, which were filled.
    - **Old against new over the same 1,642 `SKILL.md` files:** 13 differ, all in step titles that now keep their code spans, such as `__table_args__`. Step counts, rules and commands don't change. So this shows no regression, not that the fixes work: only the tests do.
    - **Policy from here on (owner's decision, 2026-11-04):** a parser finding is fixed immediately only if it loses a skill's content, or turns text that isn't the skill's into steps, rules or verify candidates. The rest go in one tracking issue for P1.4's agreement rule, and each such thread is resolved with a link to it.
  - **Third review round (2026-11-04, `/code-review` of `d1da7f3`, with Codex's 2 comments on it, then Codex's 2 on `ae51320`):** the second round introduced these regressions, and two came from this round's own fixes. Each is fixed test-first in its own commit.
    - **Fixes:** arithmetic stays open across shell lines until its code block ends (Codex). A blockquote or HTML block start isn't lazy (Codex). `* * *` and `- - -` are thematic breaks, not list items. Trailing backslashes are counted in linear time, where a regex took 815 ms on a run of 50,000. A literal NUL in a title can't pass for a held code span. A line four spaces past an item's content is code: the lazy rule had made a false `MUST` reachable there, and the same fix covers the older form with no lazy line, which the known limits used to accept. A list marker inside an HTML block isn't an item, because the lazy rule made a false `MUST` reachable there too. The block runs to its closer or the next blank line, and rules inside it still count. Tabs count to the next multiple of four when measuring an item's content (Codex, on `85f2108`, which counted characters and hid a real rule). A heredoc delimiter keeps `$(…)`, `${…}` and `` `…` `` whole, because bash takes them literally (Codex, on the second round's `9663e70`, which lost the commands after one). A line's quotes and brackets are matched once, so a line of many `<<$(` stays linear.
    - **One output an author might read differently:** `1. First` / `> quote` / `2. Next` gives one step, which matches `main` and CommonMark.
    - **Why the last round's checks missed these:** its 118 mutants measured the code as written, so they can't see a case nobody wrote. Its corpus held none of these shapes. This round adds a comparison with `markdown-it` over random documents.
    - **Tests:** 34 new, and no existing test changed. 16 failed before their fix, each for the expected reason. 16 were guards that passed before and after, and 2 were added for mutants that survived.
    - **Mutation checks:** 198 mutants, all caught: 53 carried from earlier rounds and 145 new. Across the round's runs, 3 survived at first. Two showed test gaps, which were filled. The third was the ` {0,3}` in a block-start pattern, which `endsList`'s own indent check already covers, so it was dropped as equivalent.
    - **Old against new over all 9,214 `SKILL.md` files on this machine, 1 of them unreadable:** against `main`, 56 differ. Every changed title is a code span coming back. 4 of the files, copies of one `ralph/SKILL.md`, also gain steps 8 and 9, which a column-0 `7.6` line used to cut off. Rules and commands don't change. Against `d1da7f3`, nothing differs, so this round changes no real skill.
    - **Regressions left, on constructed input only:** #16 can give these and `main` can't, while no real skill's rules or commands change. They were sorted over random documents where `main` agrees with `markdown-it`. Fixing them means modelling paragraphs properly: a prototype of that lost rules, raised step differences to about 1,200 and changed where one real skill's steps come from. So they're recorded here, and P1.4 should read them as cases where the parse invents.
      - **Invents a rule (3 distinct documents):** an item that can't interrupt a paragraph opens a list, a lazy line keeps it open, and an indented line after a blank reads as the item's paragraph. `para` / `2. b` / `lazy` / blank / `      MUST six`.
      - **Invents a step (149 distinct documents), all from text that is the skill's own:** a nested item read as a step (`  1. n` / `3. c` / `text` / `   2. m`). A list running on past a column-0 code block (`1. a` / `text` / fence / fence / `2. b`). A list running on past a shallower paragraph (`2. b` / `text` / blank / `  indented` / `1. a`). An item that can't interrupt a paragraph (`* * *` / `   para` / `   2. m`).
      - **Moves a list's boundary (2 distinct documents):** each drops a step `main` gave and adds another. The tracking issue lists them, with the rest of what differs from `markdown-it` that `main` shares.
      - **Drops what `main` gave, where `markdown-it` agrees with the drop:** the fuzz scores these as fixes, but Claude reads a skill as raw text, so an author may have meant them. No real skill changes, and an agreement rule that needs both sources can only enforce less because of one. `<div>` / `1. a` / `2. b` gives no steps, so a whole workflow straight after a block tag, with no blank line, disappears. `- a` / `text` / `  1. n` gives no step, because the item is nested under the bullet. `- a` / blank / `      MUST six` and `* * *` / blank / `    MUST four` give no rule, because those lines are indented code.
      - **Differs from both (3 distinct documents):** steps drop where `main` and `markdown-it` each give something else, such as `- bullet` / `lazy text` / `   2. m` / `3. c` / `  1. n` / `3. c` / `lazy text`.
      - **Loses a command:** the unbalanced `((` limit above. Other commands lost against `main`, such as after `1 << 2` or `let x<<=2`, are what bash does too, checked by running it.
  - **Checked in an interactive terminal (2026-11-04, on 2.1.318, at `93a2244`):** loaded with `claude --debug --plugin-dir`, the owner ran a typed `/devforgeai:brainstorm`, then in a scratch project an agent with `notes` preloaded (it ran in the background), and exited each session. Nothing from the mod showed in the terminal. The debug logs show it loaded, `agent.spawn` settling before `skill.prompt`, `session.end` firing, and no failed or skipped hook. The logs don't show what was captured, and `parseSkill` isn't wired to a hook yet, so this checks the mod's loading and pass-through, not the parse.
  - **Follow-up PR (2026-11-05, off `main` after #16 merged):** the owner froze #16 at `8e509e5` on 2026-11-04, because every push restarts Codex, so its last findings came here: Codex's two comments on it, the blockquote fence from its review, and five from the cold `/code-review` of #16, three of which `main` already had. The policy goes by effect, not origin (owner, 2026-11-05), and the owner's answers of 2026-11-05 settled the rest. Each fix is test-first in its own commit.
    - **Fixes:** `readShell` reads on after a heredoc's delimiter, not from after its `<<`, so the word's own `;` isn't a split. `<<''` opens a heredoc that ends at the first empty line, as bash reads it. A delimiter's quotes pair with backslash escapes honoured, and a double-quoted word drops the backslash before `\\`, `"`, `$` and a backtick. `((` is arithmetic only when its inner parenthesis closes right before its outer one, or not on its line; anything else is two subshells. A `(` where a command may start opens a subshell whose parentheses are not part of its commands, so `(cd a; npm test)` gives `npm test`, and a `)` with no opener on its line ends a command too (narrowed in the review round below). Only paragraph text makes the next line lazy, and a blockquote's line counts as its content does. `===` is a setext underline only at its paragraph's own level. Indented code starts after any line but a paragraph's: a heading, thematic break, setext underline, closed HTML block, empty `>` or closing fence. A code fence inside a blockquote is code, read with the quote's markers off. A comment's trailing backslash continues nothing. `<<` inside `$[…]` is a shift. An HTML block of types 1 to 5 runs to its closer past blank lines when a later line holds one, and else still ends at the first blank line, so an unclosed `<!--` can't hide the rest of a skill (the owner's option 3, over CommonMark's reading to the end of the document).
    - **Tried and left out:** giving no candidate from the last segment of a line that ends inside a quote (the owner's 3c). Bash runs `npm test -- --grep "slow` / `cases"` with a two-line argument, and the rule dropped that candidate, which the owner's stop rule for 3c forbids. Its patch is kept with the session's scratch files, and the quoted-string limit below stands.
    - **Tests:** 20 new, 240 in all, in 16 code and test commits, with 6 assertions added to existing tests for mutants. Two assertions changed with the owner's approval of 2026-11-05: the `cat <<''` case in "with nothing to read as a delimiter, or an unclosed quote, no heredoc opens" (from `9663e70`), whose loop's other four lines keep their expectations; and the fence case of "an indented line with no blank line before it continues its paragraph" (`parse.test.ts:478`, from `ec134d9`), moved to the test for code after a heading and read as code. "A blank line ends any HTML block" is renamed to say an unclosed block, and keeps its assertion. 13 of the 20 failed before their fix, each for the expected reason; 5 were guards, and 2 were written for mutants.
    - **Mutation checks:** 246 mutants, all caught: 196 carried from earlier rounds, with 18 anchors moved to the code as it stands now and one dropped (`P next not moved`, whose backward quote scan is gone), and 50 new, for the subshell and arithmetic rules, `closers()`, the heredoc word, lazy continuation, the setext underline, indented code, the quoted fence, the comment backslash, `$[…]` and the HTML block lookahead. Across the round's three runs, 10 survived at first. 9 showed test gaps, filled in `becbcb2`, `b96889d` and `6197529`: a spaced break before an indented list, a list marker inside a block tag, HTML content as paragraph text, a single-quoted delimiter's backslashes, a quoted parenthesis inside a substitution, the last closer of a kind, a bare `[`, and a fence straight after a paragraph, closed either way. 1 targeted an assignment nothing read any more, removed in `b96889d`.
    - **Bash as the oracle:** 4,000 random bash blocks from the shapes the fixes touch, run in bash with the verify commands stubbed. `main` and this PR agree with bash on 2,006; this PR is right where `main` was wrong on 1,243, and wrong where `main` was right on 2, both blocks where bash stopped at `echo Don't` and `main` had lost the later commands to the `$[` heredoc; both miss 749, all commands inside a function body, which neither reads.
    - **markdown-it as the oracle, 100,000 random documents each:** rules: none invented that `main` doesn't, and 242 lost that `main` kept, all in HTML-block modelling the parse doesn't do: a tag that can't start a block alone on a line (`<span>`, `</pre>`), a block tag inside a list item, `<pre>` ending at any closing tag, and an unclosed block, which CommonMark runs to the end. Steps: 1 lost through the same `</pre>` gap, and 3 invented, through the "item that can't interrupt a paragraph" limit in #17 and the same HTML gaps. This check caught the setext regression above before it shipped.
    - **Old against new over all 9,287 `SKILL.md` files on this machine, 1 unreadable:** nothing differs, checked after every fix. Before the subshell rule was narrowed to where a command may start, two copies of one skill gained a candidate from a diagram in an untagged code block, which is why the rule has that condition. The fence half of item 6 changed no file's rules.
    - **Known limits, revised:** `((cd a); npm test)`, a comment ending in `\` and `$[1<<2]` are fixed. A quoted string spanning lines is still read line by line, so the line that closes it is read from its start, and a command after the closing quote on that line is lost. An unbalanced `((` still leaves arithmetic open to the end of its code block. New with option 3: an opener followed much later by its closer in prose, `<!--` once and then `A --> B` in a paragraph, hides the span between, as GitHub does. A `MUST` inside a closed HTML comment still counts as a rule.
    - **Not checked in a terminal:** `register.tsx` doesn't import `parse.ts`, so loading the mod can't exercise it, as the owner decided for #16; re-checked on this branch.
  - **Review round on #19 (2026-11-05, the cold `/code-review` of `936dde1`, with Codex's comment [r4484003475](https://github.com/bankielewicz/CM/pull/19#discussion_r4484003475) on it):** 12 findings. By the owner's answers of 2026-11-05 they all land on #19: the policy goes by effect, not origin, and they were found in its one review round. Findings 1 to 8 are fixed test-first, in the order 5, 6, then 1 with 4 and 7 as one change, then 2, 3 and 8. Finding 10 is folded into 3's commit and finding 11 into the docs. Finding 9 needs nothing: both changed assertions were approved on 2026-11-05, and the terminal check stays skipped for the reason above.
    - **Speed (findings 5 and 6):** only a continued line's newest piece is read to see whether it goes on, with what the piece before it left open, and the joined line is read once. 20,000 continued lines took 9 s and now take 27 ms. Where a command may start is decided once per word, not by rescanning for each `(`: 80,000 parentheses took 12.8 s and now take 16 ms.
    - **One model of which `)` ends a command (findings 1, 4 and 7, which answers 12):** `readShell` tracks the groups open around each point: a subshell, a substitution whose commands are read, and a case statement. Those left open carry to the next line, as arithmetic does. A `)` ends a command only when it closes one of them or a case pattern; anywhere else it's a character. So `${pattern:-foo)}`, `1) npm test` in an untagged block, `done :) npm test` and `` `a) make lint` `` read as `main` read them. A subshell may also start after `|`, `&` or `{`, and `${…}` is one piece of its word.
    - **What the tests needed beyond the owner's rule:** the rule cuts only at a subshell's or case pattern's `)`. Two existing assertions need more: `$((cd a); npm test)` gives `npm test`, and `echo $(npm test)` gives nothing. So a substitution where a command starts, or one running on to later lines, has its commands read, and its `)` leaves the rest of the word inert. A substitution or backtick closed inside a word is sealed: nothing in it is split or read. The cost is that `x=$(cd a; npm test)`, `echo $(a; npm test)` and the same in backticks give nothing, where bash runs `npm test`. Head gave `npm test` there, through the inconsistency finding 4 names, and `main` gave `npm test)`. `$(npm test) && make lint` now gives both. Reading every substitution's commands would mean changing the `echo $(npm test)` assertion, which is the owner's call.
    - **Markdown (findings 2, 3 and 8):** a fence opened in a blockquote ends a list as any quote line does, and no fence opens inside an HTML block. `main` already opened an unquoted fence there, which lost the block's rules and read commands from a commented-out fence. A paragraph's level is set where it starts, so a lazy line can't move it, and `===` after one is lazy text. A quoted line four columns past its marker is indented code, with columns counted from the marker and tabs to the next stop.
    - **Found by this round's checks and fixed:** the markdown-it check against `main` found a fence in a blockquote inside a list item running on past a quote marker left of the item's content, which markdown-it reads as a quote of its own. `1. [ ] x` / `   > ```` / `> MUST quoted` lost its rule. That came from #19's own `0743412`. The mutation check's survivors gave 21 assertions and 5 simplifications. Two of the simplifications change answers, and only on text bash rejects as a syntax error: a word straight after a subshell's `)` or after `;;&` now gives nothing.
    - **Tests:** 18 new, 259 in all, and 1 assertion added this round and then removed because nothing could fail it. Run one assertion at a time against each fix's parent, 41 of the 56 written before their fix failed for the expected reason, and 15 were guards. The 21 written for mutants pass on their parent, as they pin what the code already did.
    - **Mutation checks:** 306 mutants on the final code, 305 caught. 236 are carried from #19's first round, with 26 anchors moved to the code as it stands, and the 10 on the replaced `)` heuristics dropped. 70 are new, for each fix: the piece read and its carried state, keywords and operators where a command may start, sealed spans, each group's open and close, case subjects, patterns, clauses and `esac`, the quoted fence and list, the paragraph level, and the quoted indent. The first run, on 305, let 27 through, and the run after their fixes let 6 through.
      - 24 showed test gaps, filled in `7a97df9` and `edcf92f`. One was filled twice: a later simplification made its first test stop telling the two apart.
      - 6 targeted code that changed nothing, which was simplified or removed. Two of those simplifications change answers, only on text bash rejects.
      - 1, a clause end one character wide, is equivalent and dropped.
      - 1 is the quoted-string limit below, kept: carrying a quote left open at a line's end to the next line.
    - **Bash as the oracle, 4,000 random blocks on each of two seeds:** scored exactly, so `npm test)` counts as wrong. Against `main`, this round is right where `main` was wrong on 1,448 and 1,466 blocks. It's wrong where `main` was right on 2 and 3, all `$[1<<2]` before `echo Don't`, as in the first round. Against head, it's right on 706 and 740 where head was wrong. It's wrong on 175 and 173 where head was right, every one a substitution closed inside a word: the sealed rule's cost above. Scored by command id, as the first round did, `npm test)` counts as right, and the sealed shapes show as 85 and 73 regressions against `main`.
    - **markdown-it as the oracle, 100,000 random documents:**
      - Against `main`: 8,052 rule, 24 step and 415 command answers fixed. Every rule loss, 279, and every invention but one, 11 steps and 9 commands, sits on a line markdown-it reads as an HTML block the parse doesn't model: an unclosed `<pre>` or `<!--`, `<span>` or `</pre>` opening one, or a block tag that ends a list. The other invents a step: a quoted fence opener between an item's marker and its content column, which markdown-it puts outside the item, hides the quote marker after it, under the list limit below.
      - Against head: 3,793 rule, 115 step and 235 command answers fixed. 54 rules lost and 9 steps invented, all in such HTML blocks. 5 step lines are lost where an ordered item that can't interrupt a paragraph opens a list here (#17): the first list now ends at a quote, as markdown-it's does, so markdown-it's own list is the second one, which isn't read.
    - **Old against new over every `SKILL.md` on this machine:** the 9,288 paths #19 used, 9,285 of them still there, and the 9,498 there today, 1 unreadable. Nothing differs from `main` or from head. The shapes occur: 888 files continue a shell line, 265 hold `$(`, 99 a `)` inside `${…}`, 37 a separator inside a one-line `$(…)`, 25 a `(` after `|`, `&` or `{`, 19 a `case`, 11 a quoted fence and 6 a quoted line four columns in. None sits where a verify command or a rule reads differently. The comparison does see changes: dropping the npm pattern from the verify list changes 113 files.
    - **Known limits, as this round leaves them:** findings 1, 2, 7 and 8 are fixed, and with them the limits the review named. Besides the earlier ones:
      - The sealed substitution above.
      - A `case` whose `in` is on a later line opens nothing.
      - A `((` or `$(` opened on one piece of a continued line and closed on a later one, with a `#` between, reads that `#` as inside the pair: 27 in 500,000 random blocks.
      - A fence in a list item runs on past a line left of the item's content, which CommonMark reads as ending the item. Quoted fences end there now. Unquoted ones don't, because an author who wrote `npm test` at column 0 inside a fence most likely meant it.
      - A list keeps the lines between its marker's indent and its content's (#17). With a quoted fence there, that can give a second step.
      - The quoted-string limit stands: a quote left open at a line's end isn't carried to the next line. Carrying it fixes 93 of 4,000 random bash blocks exactly, regresses none and changes no real skill, so it's a candidate for #17 or the next PR.
    - **Freeze:** this was #19's one review round, its first Codex pass plus a cold `/code-review` (owner, 2026-11-05). It takes no more code. Findings after it go to #17 or the next PR under the same policy.
- [x] P1.3 **Frontmatter and overrides** (F1.7, F1.9). **Done: PR #10.** Parse and schema-validate the `taskmaster:` block, and read the skill's override file, `.taskmaster/overrides/<skill>.json` (owner decision 5). Precedence is frontmatter, then override, then LLM, then heuristics (principle 1). **Red:** invalid frontmatter falls back with a logged reason, and an override beats extraction. *Depends on P1.2.*
  **Status (2026-11-04):**
  - `hooks/contract.ts` validates a declared contract strictly and all-or-nothing, so an invalid one is never half-used. It checks known keys, version 1, the three modes, step ids (well-formed and unique), titles, `mandatory`, `when`, exactly one verify kind with a whole-number `exit`, `confirm_before` naming real steps, and provenance.
  - **The frontmatter tier is skipped when the engine sets `frontmatterProblem`.** Its own docs leave refusing such a skill to the hook, and a dropped frontmatter would otherwise lose a `taskmaster:` block silently.
  - **`skill.prompt` reads the override file** (`<root>/<overrideDir>/<overrideFile(skill)>`) only when the frontmatter gives no contract. It stores the result as the capture's `declared`, and logs each set-aside contract to the **debug** log only. The capture shape is now `skills-3`.
  - **`pickTier`** holds principle 1's full order, unwired, with the model tier's slot for P1.4. P1.4 also names `contract_source`.
  - **Tests:** 44 new, and `hooks/contract.ts` has 100% coverage of lines and functions. Seven mutants each fail their own test: the precedence order (twice), all-or-nothing, reading only when needed, the debug destination, `frontmatterProblem`, and file-name safety.
  - **Checked live:** a real `notes.json` override gave `source: override` with its contract. A skill with `mode: loud` gave `none`, with its reason and a debug-log line, and showed nothing.
  - **Fix round (2026-11-05, after #19 merged, with `main` merged in at `2f1f41b`):** issues #15 and #12, each test-first in its own commit, as the owner decided on 2026-11-04.
    - **#15, Codex's P2 ([r4471635625](https://github.com/bankielewicz/CM/pull/10#discussion_r4471635625)):** a `session.end` during the override read no longer puts the ended session's skill into the list its reset starts (`8895b6f`). A generation counter does it: `session.end` advances it, `skill.prompt` reads it at the top of the hook, and the queued save writes nothing if it has changed. The test engine gains `holdFirstRead`.
    - **#12:** any `frontmatterProblem` now leaves a skill unattributed, because flagged frontmatter may have lost the `context: fork` that keeps a forked skill out of the caller's loop (`fc6134f`). That's the owner's decision of 2026-11-04, so it doesn't wait on the live probe.
    - **Tests:** 2 new, 304 in all. Each failed before its fix for the expected reason. Six mutants each fail a test: three on the counter, including reading it after the override read, and three on the guard.
  - **For the owner:** principle 1 puts frontmatter before an override. But F1.8 and F16.6 say overrides exist to fix skills you can't edit, so an installed skill that ships a wrong `taskmaster:` block can't be overridden. Should an override beat a third-party (non-project) skill's frontmatter?
  - **Before merging:** the owner runs the interactive-terminal check on this PR (owner's decision, 2026-11-04), and it's recorded here as for P1.0.
- [ ] P1.4 **Cached extraction and enforcement level** (F1.3, F1.4). One Haiku call returns JSON that is validated against a schema and cached in `$.store` by path + hash. If the call fails, the F1.2 result is used. The level is `enforce`, `advisory` or `none`: `none` for reference and persona skills and for `exemptSkills`. **Red:**
  - **The cache key** (found in P1.1, checked live on 2.1.317). `skill.prompt`'s text is `"Base directory for this skill: <dir>\n\n"` + the body, and a typed command's arguments are appended as `"\n\n\nARGUMENTS: <args>"`. So P1.1's capture `hash` changes with the skill's folder and with every argument. Key the cache on a hash of the body alone (header and `ARGUMENTS` block removed), with the path, or on the file's own content. A skill whose body has `$ARGUMENTS` takes the words into the body, where they can't be stripped (seen live on 2.1.318), so only the file's content is stable for those. The capture keeps no text, so take it from `e.text` in the hook.
  - **A design question for the agreement rule (PR #9's review).** Heading steps always win over a list, so a single `## 1. Prerequisites` heading hides a real numbered list: the parse gives one step where the model may find many. Decide whether the agreement rule absorbs that, since the two disagree and the skill stays `advisory`, or the parse's precedence has to change. The parse keeps it as is for now (owner's decision, 2026-11-04).
  - a second load of the same hash makes no model call,
  - a failed call yields the F1.2 result as `advisory`,
  - high confidence that disagrees with the parse stays `advisory`.

  *Depends on P1.3.*
- [ ] P1.5 **Protocol footer and task seeding** (F1.5, F1.6). Append the footer (about 10 lines) with namespaced step ids (`skill:S#`) and the three tools. Seed one task per step with `$.tool.call(TaskCreate)` (spike: `seed-task`). **Red:** the footer lists every step id and the three tools, seeded tasks carry `[S#]`, and a `none` contract gets no footer. *Depends on P1.4. With P1.17, covers DoD 1.*

## M2. Ledger and tools (F2, F3)
- [ ] P1.6 **Ledger, task map and coverage map** (F2).
  - For every `tool.call`: `agentId`, tool, a trimmed input digest, `isError`, a sequence number, files touched, and the Bash command line.
  - The task map comes from `TaskCreate`, `TaskUpdate` and `TodoWrite` *results*.
  - Each step has a coverage state: `uncovered`, `pending`, `in progress`, `satisfied`, `waived` or `needs re-verify`.
  - Everything is kept in `$.state` and never rebuilt from `TaskList`.
  - **Decide how long a starting agent's claim lasts first (owner's D3, PR #8).** This is the first task to hold a loop to a skill through `taskmaster.skills`, so attribution's limits start to matter here. The follow-up is claims that expire by age: stamp the spawn, ignore claims older than a few seconds (a preload came at most +52 ms after the spawn, a first tool call at least +2.8 s), and stop clearing `starting` on prompts. That retires both P1.1 limits on claims: the report that clears a claim, and the killed agent whose claim lingers. Use `$.clock`, which tests can control, and don't let a failing clock read throw out of attribution.

  **Red:** a scripted call sequence produces the expected coverage map, and the mod's own calls stay out of the ledger. *Depends on P1.5.*
- [ ] P1.7 **The three tools** (F3). `taskmaster_waive`, `taskmaster_await_user` and `taskmaster_checkpoint`, each registered with `isDeferred: false`. At `strict`, a waiver needs the user's yes through `$.ui.ask`. **Red:** each tool updates the run state, and a strict-mode waiver without a yes is refused. *Depends on P1.6.*

## M3. Gates (F4 G1–G3, F5, §6)
- [ ] P1.7b **Guard the contract's levers, and add the personal layer** (F17, F1.8, F1.9; owner decisions 6 and 7). This must land before the gates enforce anything, and P1.8–P1.10 depend on it.
  - **Protected paths:**
    - `<root>/<overrideDir>/**`,
    - the mod's `$.store` file (`~/.claude/plugins/store/taskmaster*`),
    - a project skill's `taskmaster:` key,
    - settings files where a write touches the mod's `pluginConfigs`.
  - **The guard:** `tool.check` answers `ask` for `Write`, `Edit` and `NotebookEdit` on a protected path. It also answers `ask`, as a best effort, for non-read-only `Bash` that names a protected path, and for `Bash` that starts a nested `claude`, which could type a command and answer its dialog.
  - **Freeze and approval:** a run keeps the contract it started with. A change that loosens a contract (as F17 defines it) applies only after the person's yes in `$.ui.ask`, and never in a `-p` run. A change that only tightens applies at once.
  - **The two layers** (owner decision 7):
    - The order: the person's `$.store` entry, keyed by repository and skill, then the project file, read each time there's no entry. Nothing copies the file into the store.
    - The personal layer is written only by a typed `/taskmaster` command or after `$.ui.ask`. Its session copy lives in `$.state`, so a store that differs from the mod's last write in the same session is ignored and files an incident. Across sessions only the guard protects it (F17, mechanism 5).
    - A project file that loosens the contract it replaces needs the person's yes. The yes is kept in `$.store`, keyed by repository, skill and the file's hash, so a changed file asks again, and so does a fresh cloud container. P1.7c adds `overrideTrust: default-branch`.
  - **Visibility:** the source of each override is recorded for P1.17's summary, and a loosened contract is flagged. A tool call that touches a protected path is recorded for P1.21's *model gaming* tripwire.
  - **Claude-facing text** never mentions overrides or the personal layer. A refused write says to ask the person, or to use `taskmaster_waive`.
  - **Open question for the owner, before this task starts:** may an override beat a third-party skill's own frontmatter? (Decision 7 settled which layer wins.)
  - **Checked live:** a command typed in the Claude app carries `origin: { kind: 'composer' }` (the `/tm-origin` probe, 2026-11-04). **Still to check live:** a plugin's `ask` in bypass mode.
- [ ] P1.7c **Trust the default branch, behind the override guard** (F17.1, F12; owner decision 8).
  - **The template:** ship F17.1's workflow as `taskmaster/templates/override-guard.yml`, with its setup steps in the README.
  - **The setting:** `overrideTrust`, `ask` (the default) or `default-branch`, in `DEFAULTS`, `userConfig` and the F12 test.
  - **The check:** with `default-branch`, a project file whose content matches the default branch's version applies without asking. The mod fetches the default branch itself, so a moved local ref can't fake a match. Any other file goes through P1.7b's approval. This task decides where the fetch runs: a hook doesn't wait on slow work, so perhaps once at `session.start`, kept for the session.
  - **The guard grows:** with `default-branch`, `Bash` that runs `git remote set-url` or `git update-ref`, or writes under `.git/`, goes to a person, as a best effort. A fresh fetch defeats a moved ref, not a redirected remote.
  - **Red:** a matching file applies without `$.ui.ask`. A file that differs, or a failed fetch, asks. With `ask`, a matching file still asks, unless the store already keeps a yes for that file version. The guard asks for `git update-ref`.
  - **The owner's step, for this repository:** add the workflow under `.github/workflows/` with `gate-guard` lifted, create the `taskmaster-overrides` environment, and make both jobs required checks once the file is on `main`. The deny rule F17.1 suggests goes in `.claude/settings.json`, which is also the owner's to edit.
  - *Depends on P1.7b. The gates don't depend on it, because `ask`, the default, is safe without it.*

  **Red:**
  - each guarded write gets `ask`, and an unguarded one doesn't,
  - a loosening override is ignored without a yes, and a tightening one applies,
  - a store edited behind the mod's back is ignored and recorded,
  - the frozen contract survives a mid-run override edit.

  *Depends on P1.6 and P1.3.*
- [ ] P1.8 **G1: completion gate** (F4, F8.4). Deny `TaskUpdate status=completed` when:
  - no work was recorded between `in_progress` and `completed`,
  - a verify spec isn't met after the last edit (matched on both the command and the error flag, so `echo PASS` doesn't count),
  - completions arrive in a burst with no work between them,
  - `metadata.handoff` is missing.

  Every deny ends with the waive instruction. This is the only gate with a `.catch`, because it may fail closed. A `classic.TaskCompleted` block is the backstop (spike: `deny-complete`, `taskcompleted-block`). **Red:** one test per deny reason, plus `echo PASS`, plus a completion that passes. *Depends on P1.7 and P1.7b. With P1.9, covers DoD 2.*
- [ ] P1.9 **G2: delete gate** (F4). `TaskUpdate status=deleted` on a step's task is denied and redirected to `taskmaster_waive`. **Red:** deleting a task that isn't a step's is allowed. *Depends on P1.6 and P1.7b.*
- [ ] P1.10 **G3: Stop gate, with F5 safety and the freshness gate** (F4, F5, F8.4). Block the stop while this loop's steps are uncovered, pending or in progress. The reason lists the step ids and the three ways out: do the step, waive it, or call `await_user`.
  - **Limits:** at most `maxStopBlocks` blocks per contract per user turn, and a new block only after the ledger has moved. After that, release the stop with `released: S3, S5 unverified` below the answer.
  - **Never block** with background tasks or crons running, on a `stop_hook_active` re-entry, or after `isAborted`.
  - **Waits pass:** `await_user` this turn, or a trailing "?" (owner decision 2). A stop let through by a trailing "?" is recorded, so P1.17 can list it below the answer.
  - **Fails open** (spike: `stop-block`).
  - **Freshness gate:** under the same cap, also block when there has been no checkpoint call since the last write call.

  **Red:** a test per rule, including "no trapped session: the stop after the cap always passes" (Gate B safety: 0 trapped sessions), and one that a trailing "?" lets the stop through and records it. *Depends on P1.7 and P1.7b. DoD 3.*
- [ ] P1.11 **Strictness and the off switches** (§6, F9). `observe`, `advisory`, `enforce` and `strict` change what G1–G3 do: log, warn, deny/block, or strict mode's extras (a waiver needs the user's yes; the cap is 3 blocks). Esc (`isAborted`) freezes every gate for that turn, `/taskmaster off` always wins, and reference skills cause no blocks. **Red:** a table-driven test over §6's rows for G1–G3. *Depends on P1.8–P1.10. DoD 4.*

## M4. Checkpoints and resume (F8.1–F8.6)
- [ ] P1.12 **Store and contents** (F8.1, F8.2).
  - **Files:** `.taskmaster/active.json`; `runs/<id>/checkpoint.json` (schema-versioned); `HANDOFF.md`; journal chunks in `journal-<n>.jsonl`.
  - **Mirror:** a mirror and index of the checkpoints in `$.store`.
  - **Redaction:** secrets are redacted before every write.
  - **Finding a run:** a run is found through `active.json`, never by session id. `/clear` changes the id, and a restart keeps it (plan §9).
  - **Skill hashes:** a checkpoint identifies a skill by P1.4's body key, never by the capture's `hash`. That one covers a typed command's arguments, and checkpoints can be committed.

  **Red:** a checkpoint round-trips, a planted secret never reaches disk, and a shell `cd` doesn't move the writes. *Depends on P1.6.*
- [ ] P1.13 **When to write, and git** (F8.3, F8.1).
  - **When to write:** after every task transition, every `checkpointEveryWrites` write calls, at PreCompact, at every Stop, at `session.end` (the run is marked `paused` unless it's done), and at `contextCheckpointPercent`.
  - **Milestone commits:** `git add -- .taskmaster/`, then `git commit --only -- .taskmaster/` (spike: `git-commit-only`), at most one commit per milestone. **Leave `overrides/` out of both** (F17), so the mod's own checkpoint never commits an unapproved override edit. `checkpointPush: milestone` pushes them.
  - **First-commit notice:** shown for a public or unknown remote, using `gh repo view` to find out which. The answer is stored per repository, and a headless run logs that the notice wasn't shown.

  **Red:**
  - the user's staged work stays staged,
  - there's one commit per milestone,
  - a private remote gets no notice, and a missing `gh` gives "may be public".

  *Depends on P1.12. DoD 7.*
- [ ] P1.14 **Compaction** (F8.5, without the auto-draft).
  - **At the context threshold:** add a hidden row asking for `taskmaster_checkpoint`.
  - **Before compaction:** write the checkpoint at PreCompact, before `session.compact`'s `next()`.
  - **Compaction instructions:** add the "preserve the run id, step ids, current step and `HANDOFF.md` path" line to `session.compact`'s `instructions`.
  - **At `SessionStart(compact)`:** send the contract, coverage and next action as `additionalContext`.

  **Red:** a test driven by the spike's observed event order (`session.compact` → PreCompact → SessionStart(compact) → PostCompact). *Depends on P1.13. DoD 5.*
- [ ] P1.15 **Cold-start resume** (F8.6, with §9's restart finding).
  - **Compare body hashes.** A resume in another checkout (a cloud container, a laptop) has a different skill folder, so P1.1's capture hash differs even when the skill hasn't changed. Compare a hash of the body without the header and `ARGUMENTS` block (P1.4's key), or every cross-machine resume asks about a changed skill.
  - **When to check:** at `SessionStart(startup|clear)` *and* at `session.start`, without offering the same run twice.
  - **How it's offered:** a briefing as `additionalContext`, plus a band entry; `resumePolicy` applies.
  - **`/taskmaster resume`:**
    - it reloads the skill, asking through `$.ui.ask` if the hash changed,
    - it seeds the tasks from the checkpoint,
    - G3 holds the stop until `HANDOFF.md` has been read (owner decision 1).
  - **Staleness:** the git anchor and file hashes mark changed steps `needs re-verify`.
  - **`source: resume`:** gets only a light reminder.

  **Red:**
  - a restart that fires only `session.start` still offers the run,
  - running the check twice offers the run once,
  - a changed file drops its step to `needs re-verify`.

  *Depends on P1.12. DoD 6.*

## M5. Control and visibility (F9, F11)
- [ ] P1.16 **`/taskmaster` command** (F9). Status (including which watched events fired on this build, read from P1.0's self-check record, and the settings, read from the live config because the record holds the last saver's), `off | advisory | enforce | strict`, `waive <step> <reason>`, `contract show <skill>`, `checkpoint`, `runs`, `resume [run]`, `abandon [run]`, `report` and `exempt <skill>`. **Red:** a test of each subcommand's effect on state. *Depends on P1.11 and P1.15.*
- [ ] P1.17 **Status line, band, toasts, and the summary below the answer** (F11).
  - **Status line:** `skill · 3/7 · 1 waived`.
  - **Toasts:** shown on blocks.
  - **Below each final answer:** under an active contract, the steps satisfied, waived and released, and any stop a trailing "?" let through (owner decision 2).

  **Red:** UI mounted on `surface: 'terminal'`, with the test body looped over `['terminal', 'desktop']` (`CLAUDE.md`). A stop let through by a trailing "?" appears in the summary. *Depends on P1.10. DoD 1.*

## M6. Metrics and experiments (F13.1–F13.4, plus F13.6 export)
- [ ] P1.18 **Event log, run summary and export** (F13.1, F13.2, F13.6).
  - **Events:** schema-versioned, with the common fields (including `arm` and `contract_source`) and every listed event type.
  - **Privacy:** commands are stored as the normalized program plus a hash of the arguments, paths are hashed, and everything is redacted. `skill_id`'s hash is P1.4's body key, never the capture's `hash`, which covers a typed command's arguments.
  - **`runs.jsonl`:** silent skips, effective and friction blocks, saves, overhead and outcome.
  - **Commands:** `/taskmaster metrics`, and `metrics export` (JSONL + CSV + a data dictionary).

  **Red:** every gate decision emits a schema-valid event, and no event holds raw prompt, code or file text. *Depends on P1.11. DoD 8.*
- [ ] P1.19 **Ratings and implicit signals** (F13.3). The band offers ratings to a `ratingSample` of runs, at most once an hour, as one click that can be dismissed. Interventions are logged as implicit signals. **Red:** a test of the sampling and the hourly cap. *Depends on P1.18.*
- [ ] P1.20 **Experiment arms** (F13.4).
  - `baseline`: metrics and checkpoints only, with no footer and no gates.
  - `generic`: enforcement with the skill's frontmatter ignored.
  - `frontmatter`: only for skills that have frontmatter.
  - **Assignment:** the arm is a deterministic hash of `run_id` against `experimentWeights`, and is recorded on every event.
  - **Options:** `experimentBlind` hides the arm label, and `experiment: off` is the default.

  **Red:** assignment is deterministic, and `baseline` never adds a footer or denies. *Depends on P1.18.*

## M7. Canaries (F15.1, F15.2 manual, F15.5)
- [ ] P1.21 **Tripwires and incidents** (F15.1). Each friction, miss and contract-health trip writes an incident with a slice of the journal around it. **Red:** one test per tripwire. *Depends on P1.18.*
- [ ] P1.22 **Session circuit breaker** (F15.5). Three user friction signals in one session drop the mod to advisory for the rest of it. It says so once and files an incident. Claude's own waivers never count. **Red:** five waivers by Claude don't trip it, and three overrides by the user do. *Depends on P1.21.*
- [ ] P1.23 **`/taskmaster retro`, manual RCA** (F15.2).
  - **Queue:** incidents queue in `.taskmaster/rca/queue/`.
  - **One model call per incident:** a `$.model.complete` call on `rcaModel`, capped by `rcaDailyCap`, with schema-validated output.
  - **Rules:** a "why" with no cited journal events is dropped. Categories come from the fixed taxonomy. After 3 RCAs with the same signature, the next ones are only counted.

  **Red:**
  - an uncited "why" is dropped,
  - a 4th incident with the same signature is only counted,
  - the daily cap holds.

  *Depends on P1.21. DoD 9.*

## M8. Frontmatter advisor, single skill (F16.1–F16.4, F16.6–F16.8; built last, because Phase 1.5 uses it)
- [ ] P1.24 **The skill, command and tools** (F16.1–F16.3).
  - **The skill:** ship `skills/frontmatter/` (`taskmaster:frontmatter`) with its own `taskmaster:` frontmatter (spike: `plugin-skills-folder`).
  - **The command:** `/taskmaster frontmatter suggest|apply|check`.
  - **Finding a target:** from the skills the mod has seen load, a `$.fs.list` scan of the standard folders, or an explicit path.
  - **The tools:** `taskmaster_frontmatter_draft`, `_validate` and `_apply`. The mod writes overrides itself, and returns file edits for Claude to make with `Edit`.

  **Red:** the draft returns the compiler's draft and the repo's verify commands, and applying as `override` leaves the skill file byte-for-byte unchanged. *Depends on P1.4 and P1.18.*
- [ ] P1.25 **Workflow, lint, post-check and provenance** (F16.4, F16.6–F16.8).
  - **Lint:** schema, grounding, runnable verify specs, and reasonableness.
  - **Post-check:** only the `taskmaster:` key may change.
  - **Target:** chosen by the skill's source, using F16.6's table.
  - **Provenance:** the provenance keys and events are recorded, and the user's edits to a suggestion are logged as extraction incidents.

  **Red:** a change to the skill body is caught by the post-check, and a step that isn't in the skill text fails grounding. *Depends on P1.24. DoD 10.*

## M9. Phase 1 exit
- [ ] P1.26 **Definition of done, checked live** (§11). Walk through items 1–10 in a real terminal session, including the forced-`/compact` test (DoD 5) and the `/clear` cold-start test (DoD 6), and record the results here. Then Phase 1.5 begins (plan §9). *Depends on all of the above.*
