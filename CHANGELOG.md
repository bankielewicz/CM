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
- Added a runbook for the event-order probe (`docs/probes/event-order.md`), to rerun after a Claude Code update.
- Added the deterministic skill parse (P1.2). It reads steps (from "Step N" or numbered headings, a numbered list, or a checklist), MUST, NEVER and ALWAYS rules, and test, lint and build commands from a skill's text, with no model.
- Added declared contracts (P1.3). A skill's `taskmaster:` frontmatter block, or its override file `.taskmaster/overrides/<skill>.json`, is checked strictly. An invalid one is set aside whole, with its reason in the debug log.

### Changed

- The deterministic skill parse (P1.2) now reads plain text straight after a list item's own text as part of the item, so a list runs on past such a line, and reads a list straight after a block tag such as `<div>`, with no blank line between, as HTML, so it gives no steps.
- The deterministic skill parse (P1.2) now reads a code fence inside an HTML block as HTML, as CommonMark does, so the block's `MUST` lines count as rules and its commands aren't candidates. It reads the commands of a substitution where a command starts, so `$(npm test) && make lint` gives both, and none inside one closed within a word, so `x=$(cd a; npm test)` gives nothing where it gave `npm test)`.
- Gate A passed (GO, 2026-11-03). The plan records the result in §10.1, and the README no longer describes the check as open.

### Removed

- Removed the Phase 0 spike (`spike/taskmaster-spike/`) and its coverage chart, now that Gate A has passed. The result is in the plan's §10.1, and the spike's files are in git history at [`d46b356`](https://github.com/bankielewicz/CM/tree/d46b356/spike/taskmaster-spike). Its `coverage-exempt.json` entry stays until the owner removes it (P1.0b step 2), and the gate ignores it until then.

### Fixed

- Fixed seven cases in the deterministic skill parse (P1.2): a line indented four spaces past a list item's content read as text, so a `MUST` in that code became a rule, a list marker inside an HTML block read as a list item, a line wrapped in triple backticks hid the rest of the skill, heredocs with delimiters like `EOF-JSON` lost the commands after them, a line ending in two backslashes swallowed the next command, a paragraph after an indented list hid the workflow that followed, and code spans such as `__init__.py` lost their contents in step titles.
- Fixed eleven more cases in the deterministic skill parse (P1.2): a nested subshell such as `((cd a); npm test)` read as arithmetic and lost its command, a subshell's parentheses stayed in its commands, a heredoc delimiter's own `;` was read as a split, `<<''` opened no heredoc, an escaped quote in a delimiter opened none either, a code fence inside a blockquote was not code, a heading or thematic break nested in a list item let the next line keep the list open, an indented line straight after a heading or a closing fence read as text so a `MUST` in that code became a rule, a comment's trailing backslash took the next line with it, `<<` inside `$[…]` opened a heredoc, and an HTML comment or `<pre>` block closed past a blank line was read as Markdown from the blank line on.
- Fixed two more cases in the deterministic skill parse (P1.2): a subshell after `|`, `&` or `{` kept its `)` in its command or lost the command, and a line indented four columns inside a blockquote read as text, so a `MUST` in that code became a rule.
