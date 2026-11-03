# Gate A close-out: tasks

This is the durable copy of the Gate A close-out task list. Claude's built-in task list probably won't survive step 2.6 (`/clear`), which is exactly what `tasklist-persist` tests, or the new session in 3.1. After either one, point Claude at this file to re-create the open tasks. The numbers in brackets are the built-in task ids in the session that made this list.

**Decisions taken**
- The list is kept in two places: built-in tasks and this file.
- If `deny-write-subagent` fails, G1 and the Plan Gate cover only the main loop, and the gap is documented. That isn't a no-go, because Phase 1 is main-loop only.

## 1. Fix the spike and record what was learned (Claude)
- [x] 1.0 Write this checklist [#1]
- [x] 1.1 `subagent-stop-block`: fire only for agents spawned through the Agent tool (a `spawnedAgents` set filled from `agent.spawned`). Ignore helper agents with an empty `agentType`, including the compaction summarizer. [#2]
- [x] 1.2 `subagent-stop-block`: decide at that agent's `turn.complete`: pass if the answer has `SPIKE-SUB-CONTINUED`, fail if it doesn't. Its second SubagentStop comes first and only records `stop_hook_active`. `last_assistant_message` is empty for real subagents. [#3]
- [x] 1.3 `compaction-events`: reset `compactSeen` at `session.compact` (it fires first and wraps the compaction), not at PreCompact. Log `session.compact.done`. [#4]
- [x] 1.4 `readonly-query`: keep its evidence current from real calls' `isReadOnly`. [#5]
- [x] 1.5 New check `check-every-mode`: count main-loop model calls, and how many had a `tool.check`, per permission mode (`permission_mode` from UserPromptSubmit, Stop and SessionStart). It passes on 5+ bypass calls that all had one. [#6]
- [x] 1.6 Tests for 1.1–1.5 in `tests/spike.test.ts` [#7]
- [x] 1.7 RUNBOOK: subagent-probe notes, `/compact` before `/clear`, the tasklist-persist warning, the bypass step, the new check [#8]
- [x] 1.8 `docs/taskmaster-plan.md`: add the new learnings, and rewrite the §10.1 deny row with the softer subagent rule [#9]
- [x] 1.9 `claude plugin validate`, `tsc -p`, `claude plugin test`: all green [#10]
- [x] 1.10 Commit and push to `claude/jolly-thompson-5z0tnc`. The mod hot-reloads, which forgets armed probes and keeps results. [#11]

## 2. Remaining probes, one at a time (you arm, Claude answers)
- [ ] 2.1 `/tm-spike status`: the mod reloaded and nothing is armed [#12]
- [ ] 2.2 `/tm-spike probe deny-write-subagent`, then "Use a subagent to create a file named spike-deny-sub.txt containing hello." Expect pass, and the file shouldn't exist. [#13]
- [ ] 2.3 `/tm-spike probe subagent-stop-block`, then "Use a subagent to read docs/taskmaster-plan.md and summarise it in one line." Expect pass with `SPIKE-SUB-CONTINUED`. [#14]
- [ ] 2.4 `/tm-spike probe readonly-query`: the evidence lists Bash [#15]
- [ ] 2.5 `/compact`: `compaction-events` turns to pass. It runs before `/clear` on purpose. [#16]
- [ ] 2.6 "Create a task called persistence check.", then `/clear`. About 3 s later `tasklist-persist` reads PERSISTS or DOES NOT PERSIST. Don't edit the mod between these two steps. [#17]

## 3. Bypass session, report, Gate A, Phase 1
- [ ] 3.1 A new session in bypass permissions mode with the spike loaded: make at least 5 tool calls, and `check-every-mode` should show checks equal to calls [#18]
- [ ] 3.2 `/tm-spike report`: every row is answered, and the verdict is read against §10.1 [#19]
- [ ] 3.3 Record Gate A in `docs/taskmaster-plan.md` §10.1: the verdict, the date, the build, the fallbacks switched on, and the findings table. `.taskmaster/spike/` is gitignored. Tick this file, then commit and push. [#20]
- [ ] 3.4 Split the Phase 1 MVP (plan §9) into tasks [#21]
