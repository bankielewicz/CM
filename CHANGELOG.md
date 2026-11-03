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
- Added the `taskmaster` mod's scaffold (P1.0). It reads the Phase 1 settings and runs a startup self-check, which records in `$.store` which of the events it needs fire on each Claude Code build. It's observe-only and shows nothing.

### Changed

- Gate A passed (GO, 2026-11-03). The plan records the result in §10.1, and the README no longer describes the check as open.
