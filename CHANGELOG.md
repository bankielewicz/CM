# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Added a merge requirement for mods: passing tests and at least 95% line and function coverage, run locally with `npm run coverage` and in pull requests by the `mod-coverage` check.
- Added a Claude Code Stop hook that blocks the end of a turn while changed mod code is under the bar or its tests fail.
- Added `coverage-exempt.json` to excuse a mod from the percentage, with a reason. The Phase 0 spike is listed, at 61.58% line coverage, and its tests must still pass.
- Added the MIT License.
- Added a `gate-guard` check that fails a pull request changing the coverage gate's own files, and Claude Code deny rules for those files and for `gh pr merge`.
- Added the Phase 1 task list, `docs/phase-1-tasks.md`: 28 test-first tasks in build order.
- Added the `taskmaster` mod's scaffold (P1.0). It reads the Phase 1 settings and runs a startup self-check, which records in `$.store` which of the events it needs fire on each Claude Code build. It's observe-only and shows nothing. A setting outside its range is moved into the range, so it can't switch the mod off. A folder setting inside `.git` falls back to its default.
- Added skill capture (P1.1). Each skill is recorded as it loads, with a hash of its text and the loop it belongs to: the main loop, or the subagent that loaded it with the Skill tool or had it preloaded. Its text isn't kept, because it can hold the words of a typed command. A skill that two loops could claim, or a forked skill, is left unattributed.
- Added the deterministic skill parse (P1.2). It reads steps (from "Step N" or numbered headings, a numbered list, or a checklist), MUST, NEVER and ALWAYS rules, and test, lint and build commands from a skill's text, with no model.

### Changed

- Gate A passed (GO, 2026-11-03). The plan records the result in §10.1, and the README no longer describes the check as open.

### Removed

- Removed the Phase 0 spike (`spike/taskmaster-spike/`) and its coverage chart, now that Gate A has passed. The result is in the plan's §10.1, and the spike's files are in git history at [`d46b356`](https://github.com/bankielewicz/CM/tree/d46b356/spike/taskmaster-spike). Its `coverage-exempt.json` entry stays until the owner removes it (P1.0b step 2), and the gate ignores it until then.
