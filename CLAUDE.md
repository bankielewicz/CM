# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Taskmaster is a planned Claude Code mod that holds Claude to the workflow of whatever skill it loads. `docs/taskmaster-plan.md` is the design. The real mod doesn't exist yet. The only code is `spike/taskmaster-spike/`, the Phase 0 spike: an observe-only mod with one-shot probes that answers the Gate A feasibility checks (plan §10.1). It builds no enforcement, so don't add gates to it.

## Commands

Run from the repo root. The `claude` CLI loads, validates and tests a mod. npm holds only the coverage tooling, so run `npm ci` once.

```sh
claude plugin test spike/taskmaster-spike         # one mod's tests, about 1 s
npm run coverage                                  # every mod; exits 1 under 95% line or function coverage. Also takes mod folders
npm test                                          # the coverage gate's own tests
claude plugin validate spike/taskmaster-spike     # README-install and plugin-directory advice is expected
npx -y -p typescript@5.6 tsc -p spike/taskmaster-spike   # needs the engine-written types (see below)
claude --plugin-dir ./spike/taskmaster-spike      # load it; from a terminal, the flag hot-reloads on edit
```

- **Single test:** not supported. `claude plugin test` takes only a folder and runs every `*.test.ts(x)` under it, and the kit from `claude-code/testing` has no `test.only`, so a test file using it fails to load.
- **Typecheck:** `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes when an interactive session loads the mod. It is absent in a fresh clone. Until then, load the `plugin-authoring` skill, whose text names this build's `claude-code.d.ts`, and use the tsconfig from that file's header, kept outside the mod folder, with `include` naming that file and the mod's `hooks`, `types` and `tests`. Don't commit the types folder. CI doesn't typecheck, because the types aren't available there.

## Developing a mod

Work test-first, in this order, and report the commands you ran with their output.

1. **Red:** write a test for the expected behaviour and run it. It must fail, for the reason you expected, before the implementation exists. A bug fix starts as a test that reproduces the bug.
2. **Green:** write the code that passes it. Don't weaken, delete or rewrite a test to get there, and don't hard-code what it expects.
3. **Coverage:** `npm run coverage` must pass, with at least 95% line and function coverage per mod.
4. **Verify:** run `claude plugin validate` and the typecheck, then load the mod with `claude --plugin-dir` and check it in a real terminal. The kit exercises hooks and what they return, not how anything is painted. `claude --debug` logs every hook that failed.

Writing tests with the kit:

- Nothing sits beneath the plugin. Hooks a test registers with `on` stand for the engine, and what they answer reaches the plugin as given.
- Mount UI on a named surface, `surface: 'terminal'`, never an assumed one. Looping the body over `['terminal', 'desktop'] as const` shows the mod doesn't depend on one surface.
- A reload keeps `$.state` and `$.store`, so seed what an earlier version stored and test that the new code copes with it.

How the bar is enforced:

- `scripts/mod-coverage.mjs` measures under the real kit by instrumenting a temporary copy, because `claude plugin test` has no coverage option and silently ignores flags it doesn't know. Every source file in a mod counts, whether or not a test loads it, except test files and helpers in `tests/`, type declarations and `.claude-plugin/`. `istanbul ignore` comments have no effect. The counters come from what tests print, so a test written to print fake ones would pass: never write one, and look for that when reviewing tests.
- A Stop hook (`.claude/settings.json`, `scripts/coverage-stop-hook.mjs`) blocks the end of a turn when a mod's code or tests differ from what's pushed and that mod is under the bar.
- `.github/workflows/mod-coverage.yml` runs the gate on every PR and uploads Cobertura for the ruleset's "Restrict code coverage" rule. Its `mod-coverage` job is a required check, so keep that job name and don't give the workflow a `paths:` filter: a required check that gets filtered out never reports.
- `coverage-exempt.json` excuses a mod from the percentage, with a reason. It's still measured and printed, failing tests still fail it, and it stays out of the uploaded report. Only the owner decides an exemption. With every mod exempt, as now, the gate writes no report and the upload is skipped. The coverage rule didn't block PR #1 without one, so the `mod-coverage` check is what enforces the bar.
- `gate-guard` (`.github/workflows/gate-guard.yml`, `scripts/gate-guard.mjs`) fails any PR that changes the gate's own files, dependency updates included. It runs from the base branch through `pull_request_target`, so it must never check out or run PR code. To change one of those files, the owner lifts the check in the ruleset.
- `.claude/settings.json` denies Claude edits to the same files and `gh pr merge`, and a test keeps its list in step with `PROTECTED` in `scripts/gate-guard.mjs`. If one of those files needs changing, give the owner the exact edit; don't look for another way to write it.
- The 95 lives in `THRESHOLD` in `scripts/mod-coverage.mjs` and in the GitHub ruleset, so change them together. The ruleset reads lines only, so only the `mod-coverage` check holds functions to it. Line coverage alone isn't enough, because loading a file runs every line of its one-line functions. Branch coverage is printed but not required. If the bar can't be met, ask; don't lower it or exclude files.

## Spike architecture

- `hooks/register.tsx` holds nearly everything: all hooks, the `/tm-spike` command, the probes, and the persistence of findings.
- `hooks/checks.ts` is the Gate A catalog (`CHECKS`), the verdict logic (`gateVerdict`, `modeVerdict`), and the status and report formatting.
- `hooks/journal.ts` writes the rolling JSONL journal. It stores no prompt text, file contents or tool output, and redacts secrets before writing.
- `tests/spike.test.ts` has no engine beneath the plugin: its `engine()` helper registers hooks that answer each `$` call the spike makes.
- `skills/spike-probe/` exists only to test skill loading and attribution.

Each hook passes its event on unchanged unless a probe is armed. Armed probes live in memory, fire once and disarm. Results are saved to `.taskmaster/spike/findings.json` (gitignored) and reloaded at `session.start`, so a hot reload forgets armed probes but keeps results.

A new check means a `CheckId` in `types/index.d.ts`, an entry in `CHECKS`, a test, and a row in `RUNBOOK.md`. A new armed probe also needs `ProbeName` and `PROBE_HELP` in `register.tsx`.

## Mod API constraints

These were learned live on build 2.1.317 and apply to the real mod too. Plan §9 ("Learned while building the spike") has the full list; read it before writing hook code.

- `$` can't be passed, bound or stored. Spell every call `$.noun.method(...)` where it's made. `session.start` builds one table of closures (`Io` in `register.tsx`) for helpers to use, and hooks that fire earlier buffer their data.
- `atom({ plugin, key })` must name both as string literals, not constants.
- Anchor `.taskmaster/` paths to `$.session.root()`. Relative `$.fs` paths follow the working directory, which a shell `cd` moves.
- A mod's own `tool.check` hook doesn't run on its own `$.tool.check` query, so read `isReadOnly` from the real call's `tool.check`.
- The engine's helper agents also raise `SubagentStop`. Gate only agents seen through `agent.spawn`, and read a subagent's answer from `turn.complete`.

## Where the work stands

`spike/taskmaster-spike/GATE-A-TASKS.md` is the durable checklist, and the first open item is the next step. Built-in tasks don't survive `/clear` or a new session, so re-create them from that file. `RUNBOOK.md` has the steps for each probe and how to read its result. Once Gate A is recorded (item 3.3), prune the first two bullets below.

- Don't start a new cloud session to continue a run. Its fresh container has neither the session's mods folder nor the gitignored findings.
- Over a remote connection `/reload-plugins` is unavailable, and `/clear` doesn't load new mod code. Edits load at the next session start.
- `.taskmaster/spike/` isn't committed, so anything Gate A needs goes into plan §10.1. New spike learnings go into plan §9, and behaviour changes into `RUNBOOK.md`.
- The default branch is protected and nobody can bypass the ruleset, so every change lands through a PR, including where `GATE-A-TASKS.md` says to push.
- The spike predates the coverage bar and is exempt in `coverage-exempt.json`, at 61.58% (`hooks/register.tsx` 57.14%). Its tests must still pass. Delete the entry with the spike once Gate A closes, but land the first real mod before deleting the spike: with no mods at all the gate fails, which blocks every merge.
