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

**Owner decisions** (2026-11-03, on the proposals this list first made)
1. **Resume without the Plan Gate (P1.15).** F8.6 has the Plan Gate make a resumed run reload the skill, rebuild its tasks and read `HANDOFF.md` before any write, and Phase 1 has no Plan Gate. So `/taskmaster resume` reloads the skill and rebuilds the tasks itself, and G3 holds the stop until `HANDOFF.md` has been read.
2. **Legitimate waits (P1.10, P1.17).** Phase 1 recognises a wait from `taskmaster_await_user`, or from a trailing "?" on the last message (F5's fast pre-check). A stop that a trailing "?" lets through is listed in the summary below the answer, so a question can't hide a skipped step. The `$.model.classify` fallback arrives with Phase 2's question detection.
3. **The spike (P1.0b).** Delete it, in the two PRs and the order P1.0b gives.
4. **`sentimentClassifier` waits** (PR #6 review). It's F13.3's optional label of your next prompt after a block. No Phase 1 task builds it, and a privacy setting that does nothing would mislead, so it isn't a setting yet. It comes back with the task that builds it.
5. **Override files are JSON** (2026-11-04, for P1.3). The mod API has no YAML parser, so `.taskmaster/overrides/<skill>.json` holds the `taskmaster:` block's object (plan F1.9).

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
- [ ] P1.0b **Delete the spike** (owner decision 3). **Waiting on the owner: step 2.** Two PRs, in this order, and only after P1.0 is merged:
  1. **Delete `spike/`. Done in PR #7.** A PR removes the folder and updates the paths in `CLAUDE.md` and `README.md`. The `coverage-exempt.json` entry stays for now. The gate looks up exemptions only for the mods it finds (`scripts/mod-coverage.mjs:331`), so it ignores the leftover entry, and `taskmaster/` keeps it from failing with "no mods found". The Gate A record already lives in plan §10.1.
  2. **Remove the exemption entry.** A second PR deletes the `spike/taskmaster-spike` entry from `coverage-exempt.json`. That file is protected: Claude can't edit it (`.claude/settings.json`), and `gate-guard` fails the PR until the owner lifts that check in the ruleset for it. `main` takes no direct pushes, so this step is a PR too.

  Don't reverse the order. Removing the entry while `spike/` exists fails `mod-coverage`, because the spike is at 61.58% (`scripts/mod-coverage.mjs:281`).

## M1. Contract compiler (F1)
- [x] P1.1 **Capture and attribute** (F1.1). **Done: PR #8.** On `skill.prompt`, capture the skill, its text, frontmatter, source, plugin name, path and a content hash. Attribute it to a loop: through the `Skill` tool's `tool.call.agentId`, through `agent.spawn` for preloaded skills, or to the main loop for a typed `/name` (spike: `skill-attribution`). **Red:** one test per attribution path. *Depends on P1.0.*
  **Status (2026-11-04):**
  - `hooks/skills.ts` captures each skill into `$.state` (`taskmaster.skills`, the newest 20), with a SHA-256 of its text and its loop. 20 new tests; coverage stays at 100% of lines and functions.
  - **Attribution rules, from orders seen live on 2.1.317:**
    1. An open `Skill` call whose `skill` matches: `skill.prompt` fires inside the call.
    2. An open `prompt.submit` whose `command` matches: a typed `/name` expands inside `prompt.submit`'s `next(e)`, before the main `turn.start`.
    3. The one agent whose spawn has answered and that hasn't yet made a tool call or ended its turn: a preloaded skill expands after `agent.spawn` resolves, not while it's open.
    4. Otherwise `unattributed`. That includes two loops claiming the same skill, or two agents starting at once.
  - **Checked live**, with a probe mod reading `taskmaster.skills`: typed `/notes` gave `main`/`typed`, the model's `Skill` call gave `main`/`skill-tool`, and a registered agent with `notes` preloaded gave that agent's id with `agent-preload`. A `Skill` call inside a subagent is checked only in the kit; the spike saw it live once.
  - **Mutation checks:** each test fails when its safeguard is removed (closing a `Skill` call or typed command, ending the preload window at a tool call or turn end, starting it at a spawn, the ambiguity rule). The `catch` around the capture can't be seen in the kit: a hook that throws is skipped, and the skill passes on either way.
- [x] P1.2 **Deterministic parse** (F1.2). **Done: PR #9.** Name, description, and the `allowed-tools`, `context: fork` and `disable-model-invocation` frontmatter keys. Numbered or ordered lists, "Step N" headings, `- [ ]` checklists, MUST/NEVER/ALWAYS lines, and test, lint or build commands in code fences (candidate verify commands). **Red:** fixtures for a numbered workflow, a checklist skill, and a reference skill that yields no steps. *Depends on P1.1.*
  **Status (2026-11-04):**
  - `hooks/parse.ts`'s `parseSkill(text, frontmatter)` is pure. It isn't wired to a hook yet: P1.4 builds the contract from it.
  - **Steps come from one source,** in this order: "Step N" or numbered headings (`## 1. Setup`), else the first top-level ordered list, else the first top-level checklist.
    - A list runs across blank lines, indented paragraphs and code blocks, and ends at the next unindented line that isn't an item.
    - A heading step runs until the next heading at its level or above.
  - **Rules** are uppercase whole-word `MUST`, `NEVER` or `ALWAYS` outside code.
  - **Verify candidates** come from shell code blocks, indented or not.
    - Each `&&`, `||` or `;` segment is matched separately, with leading `VAR=value` dropped and `\` continuations joined.
    - Each records the step it sits under. A command repeated under another step is kept for that step too, so "run the tests again" keeps its own verify spec.
  - **The text frame:** the "Base directory" line, a typed command's `ARGUMENTS` block and a stray YAML block are skipped.
  - **Tests:** 25 new. Coverage is 100% of lines and functions. Eight mutants each fail their own test: step-source order (both ways), lists ending at blank lines, fences only at column 0, heading ranges, nested items, the `ARGUMENTS` block, and `VAR=` prefixes.
  - **Smoke test over 219 real skills on this machine** (bundled and plugin skills, in the real text form):
    - 206 give steps (152 from headings, 53 from a numbered list, 1 from a checklist), and 13 give none.
    - It found one bug, fixed test-first: an em dash after "Step N".
  - **Not yet verified live:** the `ARGUMENTS` separator was seen once, after a body ending in a newline. Whether a body without a trailing newline still gets two blank lines before `ARGUMENTS` is unchecked. This frame-stripping and P1.4's cache key both rely on it.
    - Some reference skills' numbered lists of principles read as steps. That's expected: P1.4's model classification (`workflow`, `reference`, `persona`) and the agreement rule decide those.
    - None of those skills has a test, lint or build command in a shell block, so verify candidates are checked in the tests only.
- [x] P1.3 **Frontmatter and overrides** (F1.7, F1.9). **Done: PR #10.** Parse and schema-validate the `taskmaster:` block, and read the skill's override file, `.taskmaster/overrides/<skill>.json` (owner decision 5). Precedence is frontmatter, then override, then LLM, then heuristics (principle 1). **Red:** invalid frontmatter falls back with a logged reason, and an override beats extraction. *Depends on P1.2.*
  **Status (2026-11-04):**
  - `hooks/contract.ts` validates a declared contract strictly and all-or-nothing, so an invalid one is never half-used. It checks known keys, version 1, the three modes, step ids (well-formed and unique), titles, `mandatory`, `when`, exactly one verify kind with a whole-number `exit`, `confirm_before` naming real steps, and provenance.
  - **The frontmatter tier is skipped when the engine sets `frontmatterProblem`.** Its own docs leave refusing such a skill to the hook, and a dropped frontmatter would otherwise lose a `taskmaster:` block silently.
  - **`skill.prompt` reads the override file** (`<root>/<overrideDir>/<overrideFile(skill)>`) only when the frontmatter gives no contract. It stores the result as the capture's `declared`, and logs each set-aside contract to the **debug** log only. The capture shape is now `skills-2`.
  - **`pickTier`** holds principle 1's full order, unwired, with the model tier's slot for P1.4. P1.4 also names `contract_source`.
  - **Tests:** 44 new, and coverage stays at 100% of lines and functions. Seven mutants each fail their own test: the precedence order (twice), all-or-nothing, reading only when needed, the debug destination, `frontmatterProblem`, and file-name safety.
  - **Checked live:** a real `notes.json` override gave `source: override` with its contract. A skill with `mode: loud` gave `none`, with its reason and a debug-log line, and showed nothing.
  - **For the owner:** principle 1 puts frontmatter before an override. But F1.8 and F16.6 say overrides exist to fix skills you can't edit, so an installed skill that ships a wrong `taskmaster:` block can't be overridden. Should an override beat a third-party (non-project) skill's frontmatter?
- [ ] P1.4 **Cached extraction and enforcement level** (F1.3, F1.4). One Haiku call returns JSON that is validated against a schema and cached in `$.store` by path + hash. If the call fails, the F1.2 result is used. The level is `enforce`, `advisory` or `none`: `none` for reference and persona skills and for `exemptSkills`. **Red:**
  - **The cache key** (found in P1.1, checked live on 2.1.317). `skill.prompt`'s text is `"Base directory for this skill: <dir>\n\n"` + the body, and a typed command's arguments are appended as `"\n\n\nARGUMENTS: <args>"`. So P1.1's capture `hash` changes with the skill's folder and with every argument. Key the cache on a hash of the body alone (header and `ARGUMENTS` block removed), with the path, or on the file's own content.
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

  **Red:** a scripted call sequence produces the expected coverage map, and the mod's own calls stay out of the ledger. *Depends on P1.5.*
- [ ] P1.7 **The three tools** (F3). `taskmaster_waive`, `taskmaster_await_user` and `taskmaster_checkpoint`, each registered with `isDeferred: false`. At `strict`, a waiver needs the user's yes through `$.ui.ask`. **Red:** each tool updates the run state, and a strict-mode waiver without a yes is refused. *Depends on P1.6.*

## M3. Gates (F4 G1–G3, F5, §6)
- [ ] P1.8 **G1: completion gate** (F4, F8.4). Deny `TaskUpdate status=completed` when:
  - no work was recorded between `in_progress` and `completed`,
  - a verify spec isn't met after the last edit (matched on both the command and the error flag, so `echo PASS` doesn't count),
  - completions arrive in a burst with no work between them,
  - `metadata.handoff` is missing.

  Every deny ends with the waive instruction. This is the only gate with a `.catch`, because it may fail closed. A `classic.TaskCompleted` block is the backstop (spike: `deny-complete`, `taskcompleted-block`). **Red:** one test per deny reason, plus `echo PASS`, plus a completion that passes. *Depends on P1.7. With P1.9, covers DoD 2.*
- [ ] P1.9 **G2: delete gate** (F4). `TaskUpdate status=deleted` on a step's task is denied and redirected to `taskmaster_waive`. **Red:** deleting a task that isn't a step's is allowed. *Depends on P1.6.*
- [ ] P1.10 **G3: Stop gate, with F5 safety and the freshness gate** (F4, F5, F8.4). Block the stop while this loop's steps are uncovered, pending or in progress. The reason lists the step ids and the three ways out: do the step, waive it, or call `await_user`.
  - **Limits:** at most `maxStopBlocks` blocks per contract per user turn, and a new block only after the ledger has moved. After that, release the stop with `released: S3, S5 unverified` below the answer.
  - **Never block** with background tasks or crons running, on a `stop_hook_active` re-entry, or after `isAborted`.
  - **Waits pass:** `await_user` this turn, or a trailing "?" (owner decision 2). A stop let through by a trailing "?" is recorded, so P1.17 can list it below the answer.
  - **Fails open** (spike: `stop-block`).
  - **Freshness gate:** under the same cap, also block when there has been no checkpoint call since the last write call.

  **Red:** a test per rule, including "no trapped session: the stop after the cap always passes" (Gate B safety: 0 trapped sessions), and one that a trailing "?" lets the stop through and records it. *Depends on P1.7. DoD 3.*
- [ ] P1.11 **Strictness and the off switches** (§6, F9). `observe`, `advisory`, `enforce` and `strict` change what G1–G3 do: log, warn, deny/block, or strict mode's extras (a waiver needs the user's yes; the cap is 3 blocks). Esc (`isAborted`) freezes every gate for that turn, `/taskmaster off` always wins, and reference skills cause no blocks. **Red:** a table-driven test over §6's rows for G1–G3. *Depends on P1.8–P1.10. DoD 4.*

## M4. Checkpoints and resume (F8.1–F8.6)
- [ ] P1.12 **Store and contents** (F8.1, F8.2).
  - **Files:** `.taskmaster/active.json`; `runs/<id>/checkpoint.json` (schema-versioned); `HANDOFF.md`; journal chunks in `journal-<n>.jsonl`.
  - **Mirror:** a mirror and index in `$.store`.
  - **Redaction:** secrets are redacted before every write.
  - **Finding a run:** a run is found through `active.json`, never by session id. `/clear` changes the id, and a restart keeps it (plan §9).

  **Red:** a checkpoint round-trips, a planted secret never reaches disk, and a shell `cd` doesn't move the writes. *Depends on P1.6.*
- [ ] P1.13 **When to write, and git** (F8.3, F8.1).
  - **When to write:** after every task transition, every `checkpointEveryWrites` write calls, at PreCompact, at every Stop, at `session.end` (the run is marked `paused` unless it's done), and at `contextCheckpointPercent`.
  - **Milestone commits:** `git add -- .taskmaster/`, then `git commit --only -- .taskmaster/` (spike: `git-commit-only`), at most one commit per milestone. `checkpointPush: milestone` pushes them.
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
  - **Privacy:** commands are stored as the normalized program plus a hash of the arguments, paths are hashed, and everything is redacted.
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
