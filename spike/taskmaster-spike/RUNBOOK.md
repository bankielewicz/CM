# Taskmaster spike runbook

This answers Gate A (`docs/taskmaster-plan.md` §10.1) on *your* build of Claude Code. A full run takes about 20–30 minutes. Each step names the check it answers. Results build up in `/tm-spike status`, in the pane (`/tm-spike pane`), and in `.taskmaster/spike/FINDINGS.md` (`/tm-spike report`).

## 0. Load it

- **In a terminal, from a clone of this repo:** `claude --plugin-dir ./spike/taskmaster-spike`. The `--plugin-dir` flag also hot-reloads the folder when you edit it.
- **In the Claude Code session that wrote it:** answer **Turn them on** when asked about mods. It loads when that turn ends.

Then run `/tm-spike status`. Every check reads `· not run`, except `readonly-query`, which runs by itself about 3 s after start.

**Safety.** Nothing is blocked or denied until you arm a probe, and each probe fires once. A hot reload (editing the mod) forgets armed probes but keeps results, so re-arm after an edit. `/tm-spike reset` clears all results. The spike writes only under `.taskmaster/spike/`, so add that folder to `.gitignore`.

## 1. Probes that run on their own command (no prompt needed)

| Run | Check | Pass means |
| --- | --- | --- |
| `/tm-spike probe git-commit-only` | `git-commit-only` | `git add -- .taskmaster/` then `git commit --only -- .taskmaster/` commits only that folder, and other staged work stays staged. It runs in a throwaway repo under `/tmp`. |
| `/tm-spike probe journal-stress` | `journal-budget` | 1,200 events roll over at least twice, with p95 write ≤ 100 ms and max ≤ 1 s |
| `/tm-spike probe readonly-query` | `readonly-query` | A `$.tool.check` query marks `ls` as read-only and `rm …` as not, before anything runs. If the mod's own hook never sees its queries (as observed on 2.1.317), the check says so and lists which real calls carried `isReadOnly` instead. |

## 2. Probes you arm, then trigger with a prompt

Arm a probe, then send the prompt shown. Run one probe at a time.

| Arm | Then send | Check | Pass means |
| --- | --- | --- | --- |
| `/tm-spike probe stop-block` | `say hi` | `stop-block` (**blocking**) | Claude is blocked once, continues, and replies `SPIKE-CONTINUED` |
| `/tm-spike probe deny-write` | `Create a file named spike-deny-test.txt containing hello.` | `deny-write` (**blocking**) | The write is denied, the file isn't created, and Claude replies `SPIKE-DENIED-SEEN` |
| `/tm-spike probe deny-complete` | `Create a task called spike test, mark it in progress, then mark it completed.` | `deny-complete` (**blocking**) | The completion is denied, and `TaskGet` still reads `in_progress` |
| `/tm-spike probe taskcompleted-block` | `Create a task called spike backstop, mark it in progress, then mark it completed.` | `taskcompleted-block` | The `TaskCompleted` block vetoes the completion, and `TaskGet` doesn't read `completed` |
| `/tm-spike probe seed-task` | `List your tasks.` | `seed-task` | Claude's own `TaskList` shows the task the mod created |
| `/tm-spike probe deny-write-subagent` | `Use a subagent to create a file named spike-deny-sub.txt containing hello.` | `deny-write-subagent` | The subagent's write is denied |
| `/tm-spike probe subagent-stop-block` | `Use a subagent to read docs/taskmaster-plan.md and summarise it in one line.` | `subagent-stop-block` | The subagent Claude spawns is blocked once, continues, and its final answer (read from its `turn.complete`) ends with `SPIKE-SUB-CONTINUED` |
| `/tm-spike probe deny-handback` | `Use a subagent to read docs/taskmaster-plan.md and summarise it in one line.` | `deny-handback` | The spawned subagent's first `SubagentHandback` is refused, it keeps working, and its final report ends with `SPIKE-HANDBACK-CONTINUED` |

**About the subagent probes.** Claude Code's own helper agents (the compaction summarizer, and small helpers that run around each prompt) raise SubagentStop too, with an empty agent type. `subagent-stop-block` ignores them and fires only for an agent started through the Agent tool. On 2.1.317, a spawned agent's SubagentStop has an empty `last_assistant_message` when it hands back (auto mode), and its second stop comes *before* its `turn.complete`. So the probe judges the marker from `turn.complete`'s answer, and reports `stop_hook_active` from the second stop.

**Why `deny-handback` exists.** On 2.1.317 in auto mode, `subagent-stop-block` failed. The subagent had already delivered its report through the `SubagentHandback` tool, the engine ended it whatever SubagentStop answered, and there was no second stop. `deny-handback` tests the alternative for G4: refuse that tool call while the subagent is still running. **The path differs by mode.** On 2.1.317, only auto-mode subagents hand back. In plan and default mode, a subagent ends with a plain answer, and `subagent-stop-block` holds it (it passed in default mode). So run `subagent-stop-block` in plan or default mode, and `deny-handback` in auto mode. In the other modes nothing is handed back, and `deny-handback` stays armed. Arming a probe resets its row to pending, so note a result before re-arming it in another mode.

## 3. Skills: does a plugin's `skills/` folder load, and which loop is a skill attributed to?

Send these three prompts:
1. `Run the taskmaster spike-probe skill.` This tests the main loop through the Skill tool (`skill-tool:main`) and `plugin-skills-folder`.
2. `Run the taskmaster-spike skill-preload agent for the spike preload test.` The agent preloads the skill (`agent-preload`).
3. `Spawn a general-purpose subagent and have it run the taskmaster spike-probe skill.` This tests a subagent using the Skill tool (`skill-tool:subagent`).

`skill-attribution` passes once there is a main-loop attribution and a subagent attribution. `plugin-skills-folder` also reports whether the skill's `taskmaster:` frontmatter arrived intact.

## 4. Compaction, `/clear`, and a new session

Run these in this order. `/clear` clears the conversation, and may clear the task list too (which is what `tasklist-persist` tests), so it goes last.

1. Run `/compact`. This answers `compaction-events` and adds `compact` to `sessionstart-source`. On 2.1.317 the order is session.compact (start) → PreCompact → the summarizer's SubagentStop → SessionStart(compact) → PostCompact → session.compact.done: `session.compact` wraps the whole compaction.
2. Ask `Create a task called persistence check.`, then run `/clear`. About 3 s later the mod lists the tasks again. This answers `tasklist-persist` (PERSISTS or DOES NOT PERSIST) and adds `clear` to `sessionstart-source`. **Don't edit the mod between these two steps.** A hot reload forgets the tasks the mod has seen, so the old session would be recorded with none, and there'd be nothing to compare.
3. Optional: quit, start a brand-new session in the same folder, and run `/tm-spike status` again. Results carry over through `.taskmaster/spike/findings.json`.

`check-call-order` fills in by itself after a few tool calls of any kind.

## 5. A session in bypass permissions mode

The Plan Gate decides in the real call's `tool.check`, so `tool.check` has to fire in every permission mode, bypass included. `check-every-mode` counts main-loop model tool calls per permission mode (read from `permission_mode` on UserPromptSubmit, Stop and SessionStart) and how many of them had a `tool.check`. It updates at the end of each turn.

**Cloud sessions don't offer bypass.** Their mode menu has only Accept edits, Plan and Auto, and Accept edits records as `default`. So run this section from a terminal session. A cloud session on 2.1.317 had every call checked: auto 90/90, plan 59/59, default 28/28.

1. Start a session in bypass permissions mode with the spike loaded, for example `claude --permission-mode bypassPermissions --plugin-dir ./spike/taskmaster-spike`, or switch the session's mode to bypass.
2. Ask for anything that makes at least 5 tool calls (for example `List the files in spike/taskmaster-spike and read its README.`).
3. Run `/tm-spike status`. `check-every-mode` passes when bypassPermissions shows `N/N` with N ≥ 5, and fails if bypass skipped a `tool.check`. A miss in another mode is listed but doesn't decide the check.
4. While in bypass, re-run both subagent probes, to see which way a bypass-mode subagent ends (see the subagent-probe notes in §2). Write down the auto-mode results first: a re-run replaces a check's row.

## 6. Report

Run `/tm-spike report`. It writes `.taskmaster/spike/FINDINGS.md`: one row per check (result, evidence, and the plan's fallback), plus the **Gate A verdict**:

- **GO**: every blocking check passed (`stop-block`, `deny-write`, `deny-complete`).
- **NO-GO for part of enforcement**: a blocking check failed. The report names the pivot from the plan.
- **Undecided**: a blocking check hasn't run yet.

A failed non-blocking check isn't a no-go. It switches on the fallback named in its row.

## What the journal holds

`.taskmaster/spike/journal-<session>-<start>-NNN.jsonl` records one line per event: sessions, prompts (length and command name only), turns, every tool call (tool, agent, a short redacted digest, result flags, duration), permission checks, skills (name, source, path, frontmatter keys, text length and hash), subagent spawns, stops, task events, compaction, and context fill in 10% steps.

It never stores prompt text, file contents, or tool output. Secrets matching known key and token patterns are redacted before writing.

## Known limits of the spike

- Skill attribution is inferred from what else is open at the time (a Skill call, an Agent call, a recent spawn, a typed command), because `skill.prompt` carries no `agentId`. "unattributed" in the counts is a finding, not a bug.
- `tasklist-persist` compares task id plus subject against the previous session's last known list. Ids can restart at 1 in a new session, so both have to match.
- Probes are one-shot and live in memory. Re-arm after a hot reload.
- `check-every-mode` records a call under the mode last reported by a classic hook. Until the first prompt of a session (or after a reload in the middle of a turn) that is `unknown`, and a mode switched during a turn counts from the next turn.
