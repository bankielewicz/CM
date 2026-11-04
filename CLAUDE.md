# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Taskmaster is a planned Claude Code mod that holds Claude to the workflow of whatever skill it loads. `docs/taskmaster-plan.md` is the design, and `docs/phase-1-tasks.md` is the build order. The mod is `taskmaster/`, built test-first one task at a time. So far it's the P1.0 scaffold: it reads its settings and runs a startup self-check, and every hook passes its event on unchanged. The Phase 0 spike, an observe-only mod with one-shot probes that answered the Gate A checks, was deleted after Gate A passed. Its result is in plan §10.1, and its files are in git history at [`d46b356`](https://github.com/bankielewicz/CM/tree/d46b356/spike/taskmaster-spike).

## Commands

Run from the repo root. The `claude` CLI loads, validates and tests a mod. npm holds only the coverage tooling, so run `npm ci` once.

```sh
claude plugin test taskmaster                     # one mod's tests, about 1 s
npm run coverage                                  # every mod; exits 1 under 95% line or function coverage. Also takes mod folders
npm test                                          # the coverage gate's own tests
claude plugin validate taskmaster                 # the icon and plugin-directory advice is expected
npx -y -p typescript@5.6 tsc -p taskmaster        # needs the engine-written types (see below)
claude --plugin-dir ./taskmaster                  # load it; from a terminal, the flag hot-reloads on edit
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
- A test can't read a file, not even `plugin.json`. It imports only code files and `claude-code`, its scope has no Node, and nothing implements `$.fs.read` beneath it.

How the bar is enforced:

- `scripts/mod-coverage.mjs` measures under the real kit by instrumenting a temporary copy, because `claude plugin test` has no coverage option and silently ignores flags it doesn't know. Every source file in a mod counts, whether or not a test loads it, except test files and helpers in `tests/`, type declarations and `.claude-plugin/`. `istanbul ignore` comments have no effect. The counters come from what tests print, so a test written to print fake ones would pass: never write one, and look for that when reviewing tests.
- A Stop hook (`.claude/settings.json`, `scripts/coverage-stop-hook.mjs`) blocks the end of a turn when a mod's code or tests differ from what's pushed and that mod is under the bar.
- `.github/workflows/mod-coverage.yml` runs the gate on every PR and uploads Cobertura for the ruleset's "Restrict code coverage" rule. Its `mod-coverage` job is a required check, so keep that job name and don't give the workflow a `paths:` filter: a required check that gets filtered out never reports.
- `coverage-exempt.json` excuses a mod from the percentage, with a reason. It's still measured and printed, failing tests still fail it, and it stays out of the uploaded report. Only the owner decides an exemption. An entry for a mod that no longer exists, like the spike's until the owner removes it (P1.0b), is ignored. With every mod exempt, the gate writes no report and the upload is skipped. `taskmaster` isn't exempt, so from PR #6 on the gate writes one. That PR's upload failed with HTTP 404, Code Quality probably being off, and the step stayed green because of `fail-on-error: false`. The coverage rule had nothing to read and reported nothing, so the `mod-coverage` check is what enforces the bar.
- `gate-guard` (`.github/workflows/gate-guard.yml`, `scripts/gate-guard.mjs`) fails any PR that changes the gate's own files, dependency updates included. It runs from the base branch through `pull_request_target`, so it must never check out or run PR code. To change one of those files, the owner lifts the check in the ruleset.
- `.claude/settings.json` denies Claude edits to the same files and `gh pr merge`, and a test keeps its list in step with `PROTECTED` in `scripts/gate-guard.mjs`. If one of those files needs changing, give the owner the exact edit; don't look for another way to write it.
- The 95 lives in `THRESHOLD` in `scripts/mod-coverage.mjs` and in the GitHub ruleset, so change them together. The ruleset reads lines only, so only the `mod-coverage` check holds functions to it. Line coverage alone isn't enough, because loading a file runs every line of its one-line functions. Branch coverage is printed but not required. If the bar can't be met, ask; don't lower it or exclude files.

## Mod architecture

- `hooks/register.tsx` registers every hook. At `session.start` it builds the `Io` table (`types/index.d.ts`), the engine calls helpers get in place of `$`.
- `hooks/config.ts` holds `DEFAULTS` (plan F12's Phase 1 keys) and `parseConfig`. That function holds what `register(on, options)` receives to each key's choices and range. `plugin.json`'s `userConfig` declares the same defaults, and a test checks both against F12, reading `plugin.json`'s through the options the kit fills in. A key retyped there fails the test that sets every key, because the kit refuses an option that doesn't fit its declared type. A key removed or added there isn't caught, because `parseConfig` falls back to `DEFAULTS` and undeclared options still arrive.
- `hooks/selfcheck.ts` is the startup self-check (F14). It keeps one record per Claude Code build in `$.store`, under `self-check/<build>`, listing which of the events in `WATCHED` have fired there, and the settings of the last session to save it. `note()` returns at once. Saves run one at a time, merge the stored record before each write, and write nothing after a failed read.
- `hooks/skills.ts` captures each skill as it loads and works out its loop (P1.1). `SkillTracker` holds what is open when `skill.prompt` fires: `Skill` calls, a typed command being submitted, and spawned agents that haven't reached their first model request. Each can claim a skill, and two loops claiming leaves it unattributed. The captures are kept in `$.state` as `taskmaster.skills`, with no skill text. `SaveQueue` saves them one at a time after the hook answers, and `register.tsx` holds the list, so it's current once `saves.idle()` settles, not when a hook answers.
- `hooks/parse.ts` is the deterministic parse (P1.2): `parseSkill(text, frontmatter)` returns steps, rules, verify candidates and the frontmatter keys F1.2 names. It's pure and not yet wired; P1.4 uses it.
- `hooks/contract.ts` is the declared contract (P1.3): `validateDeclared` (strict, all-or-nothing), the frontmatter and override tiers, `resolveDeclared` (frontmatter beats an override) and `pickTier` (principle 1's full order, unwired until P1.4).
- `types/index.d.ts` holds the mod's own types, and its `$.state` contract.
- `tests/engine.ts` is the engine beneath the mod in tests. `engine(on, options)` answers each `$` call and returns what the mod stored, showed and passed on (`reached`). Its options make the store fail, hang or hold a write, make the version lookup fail, hang or give any answer, make `session.start` itself fail, run a callback inside an event's answer (`during`: the engine expanding a skill mid-call), set what `agent.spawn` answers, hang or hold a `$.state` write, seed `$.state`, make `$.clock.now()` fail, and serve files to `$.fs.read` (`files`). They can't make a `$.state` write fail, because the kit answers beneath it. It records what the mod read (`reads`) and logged (`logs`), and a `$.ui.log` line headed for the transcript counts as shown. A test's `$` has no state noun, so `stateValue(world, 'plugin/key')` reads the mod's latest `$.state` write. Saves run after the hook answers, so a test waits for one with `untilSeen`, `untilSaved` or `until`. `settled` in `skills.test.ts` waits for every capture so far.

## Mod API constraints

These were learned live on builds 2.1.317 and 2.1.318 and apply to the real mod too. Plan §9 ("Learned while building the spike") has the full list; read it before writing hook code.

- `$` can't be passed, bound or stored. Spell every call `$.noun.method(...)` where it's made. `session.start` builds one table of closures (`Io` in `register.tsx`) for helpers to use, and hooks that fire earlier buffer their data.
- `atom({ plugin, key })` must name both as string literals, not constants.
- Anchor `.taskmaster/` paths to `$.session.root()`. Relative `$.fs` paths follow the working directory, which a shell `cd` moves.
- A mod's own `tool.check` hook doesn't run on its own `$.tool.check` query, so read `isReadOnly` from the real call's `tool.check`.
- The engine's helper agents also raise `SubagentStop`. Gate only agents seen through `agent.spawn`, and read a subagent's answer from `turn.complete`.
- A hook passed to `on` must be a function literal, or the name of one. A call that returns a hook, such as `on('x', observe('x'))`, stops the module loading.
- Declare no `min` or `max` on a `userConfig` number. The engine refuses to load the module when a stored value is outside them, which switches the whole mod off. Clamp in `parseConfig` instead. A string outside its `options` arrives as unset, so `options` are safe to keep for the `/config` picker.
- A hook may wait on what it needs to answer, never on recording or diagnostics: note the work, return `next(e)`, and save afterwards. The engine holds a skill's load, and an agent's first model request, until `skill.prompt`'s hooks answer.
- A hook on a streaming event (`turn.step`, `process.spawn`) must be an async generator literal, ending `return yield* next(e)`.
- The self-check shows that an event fired, not when, and kit tests raise events in the order a test writes them. So recheck any event order the mod relies on live after a Claude Code update (plan §9).
- A skill's loop comes from what is open when `skill.prompt` fires. `skill.prompt` has no `agentId`, and the order differs by path (plan §9).
- `skill.prompt`'s text is `"Base directory for this skill: <dir>\n\n"` + the body, with a typed command's arguments appended as `"ARGUMENTS: <args>"`, and no YAML block. Parse the body, and hash the body when you need a stable key.
- The API has no YAML parser. Frontmatter arrives parsed in `e.frontmatter`, and override files are JSON (owner decision, plan F1.9).
- `$.ui.log` goes to the visible transcript unless given `{ to: 'debug' }`. The mod's own diagnostics always say `debug`.
- `$.store` is a plain JSON file (`~/.claude/plugins/store/<plugin>_<source>-<hash>.json`) that the same OS user can edit. Don't treat it as tamper-proof (plan F17).
- A plugin's `tool.check` `ask` goes to a person; a `-p` run refuses it. The model can't run a plugin's registered command (the `Skill` tool refuses), and a typed command arrives as `origin: composer` in the Claude app and `origin: sdk` in a `-p` run.
- An atom with a `shape` stores `{ shape, value }`. A plain `$.state.get` returns that wrapper, and `read($, atom)` unwraps it and declines another shape. A plain `$.state.set` writes what it's given, so write the wrapper yourself; the contract's `Shaped<T>` makes the typecheck catch a bare value.

## Where the work stands

`docs/phase-1-tasks.md` is the durable checklist for the Phase 1 MVP, and the first open item is the next step. Skip an item marked **Waiting on the owner**, such as P1.0b, and every item that depends on it: its remaining step is the owner's. If that leaves nothing to start, ask the owner the open question rather than working ahead. Built-in tasks don't survive `/clear` or a new session, so re-create them from that file. Gate A is recorded in plan §10.1 (GO, 2026-11-03).

- New learnings about the mod API go into plan §9, and each task's status into `docs/phase-1-tasks.md`.
- The default branch is protected and nobody can bypass the ruleset, so every change lands through a PR.
- The spike is being retired as `docs/phase-1-tasks.md` P1.0b says. The first real mod, `taskmaster/`, had to land first, in PR #6: with no mods at all the gate fails, which blocks every merge. Then, in this order:
  1. Done: delete `spike/`, in PR #7. The gate ignores the leftover exemption entry.
  2. The owner's step: a PR that changes `coverage-exempt.json` to `{}`, with the owner lifting `gate-guard` for it. Claude can't edit that file.
