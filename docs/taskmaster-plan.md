# Taskmaster: a universal adherence guardrail mod for Claude Code

Status: design plan, revised after the advisor review and three user reviews (no code yet) · Target: Claude Code function-hooks mod API (early access; checked against build 2.1.317's `claude-code.d.ts`)

## 1. Short answer

**Yes, but only if the goal is reframed.** A forced task list on its own does not make Claude "work harder." It produces *artifacts*. When Claude writes its own plan, it plans what it was going to do anyway and then ticks every box: checklist theater, or Goodhart's law. "Bull in a china shop" failures come in four kinds:

| Failure | Can a task-master mod fix it? |
| --- | --- |
| (a) skips steps the skill requires | **Yes**: contract steps plus a Stop gate |
| (b) claims "done" without doing or checking the work | **Yes**: the completion gate checks the mod's own record |
| (c) does work nobody asked for | Partly: drift warnings |
| (d) breaks the skill's constraints (MUST/NEVER) | Mostly no: prose rules can't be checked deterministically, so they're surfaced and audited, not enforced |

The task list improves (a) and (b) only when four things hold:
1. **The plan comes from the skill, not from the model doing the work.** It comes from the skill's frontmatter or a separate extraction call, and the mod seeds the tasks itself.
2. **Evidence is what the mod saw, not what Claude says.** The mod's own `tool.call` ledger records commands, errors, edits, and order, and prose can't fake it. Task `metadata` is Claude's claim, not evidence.
3. **Gates sit where Claude commits:** marking a task `completed`, and stopping.
4. **Skipping is allowed, but only out loud.** A waive tool records each skip with a reason, and every skip is shown to the user.

**What the mod promises:** *Claude never silently skips a declared step, never claims completion without matching evidence, and never loses its place across compaction or a new session.* That can be delivered. "Works harder" can't be promised, because no hook raises reasoning quality.

## 2. What the mod API actually gives us (verified in the type declarations)

| Need | Mechanism | Hard / soft |
| --- | --- | --- |
| Know a skill was loaded: full text, frontmatter, path, plugin | `skill.prompt` (fires for `/name`, the Skill tool, and skills preloaded into a subagent). **It carries no `agentId`**, so the loop is taken from the `Skill` tool's `tool.call` (which has one), from `agent.spawn` for preloaded skills, and a typed `/name` means the main loop | Hard |
| Add the contract to what Claude reads | rewrite `text` in `skill.prompt`. This happens before the row is sent, so the prompt cache stays intact | Hard (delivery) |
| Seed the task list from the contract | `$.tool.call({ tool: 'TaskCreate', ... })` | Hard (Gate A confirmed Claude sees the seeded tasks, §10.1) |
| Block or rewrite a tool call | `tool.call` → `{ deny }` | Hard |
| Tell reads from writes | `tool.check` input `isReadOnly` (the engine's classification; absent means treat it as a write) | Hard |
| Observe tasks | `tool.call` on `TaskCreate` / `TaskUpdate` / `TodoWrite`. **`TaskGet` and `TaskList` don't return `metadata`, and `TaskList` omits `description`**, so the mod keeps its own ledger | Hard |
| Veto a completion | `tool.call` deny on `TaskUpdate{status:'completed'}` (primary); `classic.TaskCompleted` → `{ block }` as a backstop (it reads only `block` / `preventContinuation` / `stopReason`) | Hard |
| Stop Claude from quitting early | `classic.Stop` / `classic.SubagentStop` → `{ block: reason }`; Stop also takes `additionalContext`. The input includes `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | Hard |
| Ask the user | `$.ui.ask` (the AskUserQuestion dialog) | Hard |
| Tools Claude calls | `$.tool.register` (`waive`, `await_user`, `checkpoint`), served by a `tool.call` hook | Hard (validation) |
| Inject a reminder without breaking the cache | `$.session.append({ message: { type: 'user', ... } })` | Hard (delivery) |
| Survive compaction | `classic.PreCompact` (checkpoint before), `session.compact` (rewrite `instructions`), `classic.PostCompact` (provides `compact_summary`), `classic.SessionStart{source:'compact'}` → `additionalContext` | Hard |
| Get ahead of auto-compaction | `session.measure` → `context.percent` | Hard (trigger) |
| Brief a brand-new session | `classic.SessionStart` (`source`: `startup`, `resume`, `clear`, `compact` or `fork`) → `additionalContext` | Hard (delivery) |
| Durable files | `$.fs.read` / `write` / `list` / `exists` / `stat` (whole-file writes; there is no append), `$.process.run` for `git` | Hard |
| Independent judgment | `$.model.complete` (Haiku, `timeoutMs`); `$.model.classify` (cheap label); `$.agent.spawn` (a background subagent whose answer arrives as `turn.complete`; **refused past a Stop**) | Soft |
| Memory | `$.state` (session; survives hot reload), `$.store` (across sessions, per machine) | Hard |
| UI | Pane, `AbovePrompt` band, `$.ui.status`, `$.ui.toast`, `$.command.register`, text below the final answer via `turn.complete` | Hard |
| Interrupts | `turn.complete` has `isAborted` and `agentId`; `turn.start` without `agentId` is a new main-loop prompt | Hard |

**Time budget:** each hook gets 10 s of its *own* time, and the clock stops while a `$` call or `next(e)` is in flight. A `.catch` handler gets 1 s. An LLM call inside `classic.Stop` is therefore allowed; the cost is latency, so bound it with `timeoutMs`.

**Not available, or a poor fit:**
- Rewriting the system prompt mid-thread. It busts the cache and loses thinking.
- Using `$.model.fork` as an auditor. It replays the main thread's last request (so it lacks the final answer), every tool is denied, it covers the main thread only, and it's the same model grading its own story.
- Semantic checks of correctness.
- Stopping a determined model from gaming the gates.

## 3. Design principles

1. **Universal by default, stricter by opt-in.** Any skill or command works with no configuration. Precedence: skill frontmatter, then the user's per-skill override, then LLM extraction, then heuristics.
2. **Deterministic gates, soft judgment.** Hard gates check only facts the mod observed. LLM judgment extracts contracts (cached) and gives an advisory audit at Stop; it never blocks on its own except as noted in F7.
3. **Every block says exactly what to do next, including how to waive.**
4. **No gate can trap a session.** Every gate has loop limits and overrides, and the user's Esc freezes all gates.
5. **Fail open for nags, fail closed only where safe.** The Stop gate fails open, because a bug that fails closed traps the user. Only the `TaskUpdate` gate may fail closed, and its deny message must show how to waive.
6. **Proportional.** Reference skills get no contract. A contract with low extraction confidence is advisory only.
7. **The context window is not storage.** The mod writes checkpoints to disk on observed events and never relies on Claude to remember.
8. **Measure before believing.** Every gate decision is logged with the arm and the contract source. Go/no-go thresholds are written down *before* the evaluation runs (§10), and only a human-approved change validated by replay can loosen or tighten a gate (F15).

## 4. Architecture

```
skill.prompt ─► Contract Compiler ─► Contract {steps, verify specs, rules, kind, confidence}
 + Skill tool.call (agentId)  │                  │
                              ▼                  ▼
                 protocol footer appended    $.state contract stack ──► seed tasks ($.tool.call TaskCreate)
                                                 │
every tool.call ─────────────────────────► Ledger (per agentId: tool, input digest, isError, files, seq)
TaskCreate/TaskUpdate/TodoWrite results ──►   │   + task → step map, task owner
                                                 │
   ┌────────────┬──────────────┬─────────────────┼──────────────┬───────────────────────┐
   ▼            ▼              ▼                 ▼              ▼                       ▼
 G1 Complete  G2 Delete     G3 Stop /        Plan Gate      Drift Monitor          Checkpointer
 (TaskUpdate  →waive        G4 SubagentStop  (writes before (writes w/o task)      (transitions, PreCompact,
  completed)                (fail-open)       plan)                                  Stop, end, context %)
                               │                                                        │
                               ▼                                                        ▼
                      Advisory audit (Haiku, after the gates pass)        .taskmaster/runs/<id>/
                               │                                           checkpoint.json · HANDOFF.md · journal
                               ▼                                                        │
            status line · band · Pane · summary below the answer         Resumer (SessionStart compact/startup/clear)

every gate decision, intervention, rating ─► Metrics (.taskmaster/metrics/*.jsonl, arm + contract_source on each event)
                                                 │
                     tripwires ─► Incidents ─► RCA / 5 whys (idle, separate model call) ─► Proposals
                                                                                             │
                                          replay journals + shadow mode + human accept ◄─────┘
```

## 5. Features and functionality (the build list)

### F1. Contract Compiler: skill → contract (universal)
- **F1.1 Capture** `skill`, `frontmatter`, `source`, `pluginName`, `path`, and a content hash. Not `text`, which can hold the words of a typed command: a hook has it as `e.text`, and later readers take the file at `path` or P1.4's cache. Attribute the skill to a loop: the `Skill` tool's `tool.call.agentId`, `agent.spawn` for preloaded skills, or the main loop for a typed `/name`. When two loops could claim it, or it's a forked skill (`context: fork`), it stays unattributed.
- **F1.2 Deterministic parse (no LLM):** name, description, and frontmatter (`allowed-tools`, `context: fork`, `disable-model-invocation`); numbered or ordered lists, "Step N" headings, `- [ ]` checklists; MUST/NEVER/ALWAYS lines; shell commands in code fences that look like test, lint, or build (these become candidate `verify` commands).
- **F1.3 One cheap model call (Haiku, cached):** classify the skill as `workflow`, `reference`, or `persona`; produce step ids and titles, required versus optional, user-confirmation points, candidate verify commands, and a **confidence** score. The output is JSON, validated against a schema, and cached in `$.store` by `path + hash`, so each skill version is extracted once. If the call fails, use the F1.2 result.
- **F1.4 Enforcement level of the contract:**
  - `enforce`: the skill's own frontmatter, the user's per-skill override, or high LLM confidence where the deterministic parse agrees on the steps,
  - `advisory`: anything else (Claude is reminded, gates warn instead of deny),
  - `none`: `reference` and `persona` skills, and anything in `exemptSkills`.
- **F1.5 Protocol footer**, about 10 lines appended to the skill text: the step ids (namespaced `skill:S#`), "tag each task `[S#]`", "one task in progress at a time", "call `taskmaster_waive` to skip a step, with a reason", "call `taskmaster_await_user` when you need the user's input", and "call `taskmaster_checkpoint` at milestones". The skill's own text stays primary and is never replaced.
- **F1.6 Seed the tasks** from the contract with `$.tool.call(TaskCreate)`. Gate A confirmed Claude sees them (§10.1), so the fallback (the footer tells Claude to create them, and the Plan Gate enforces it) wasn't needed.
- **F1.7 Opt-in frontmatter** for skill authors (optional; never required):
  ```yaml
  taskmaster:
    mode: enforce            # off | advisory | enforce
    steps:
      - id: tests
        title: Run the test suite
        mandatory: true
        verify: { bash: "npm test", exit: 0 }   # or { edits: "src/**" } / { tool: "<name>" }
    confirm_before: [deploy]  # steps that need the user's OK first
  ```
- **F1.8 Per-skill user override (for third-party skills):** the first time a skill runs, the Pane shows the extracted contract. `/taskmaster contract edit <skill>` lets the user fix it, and saves it to the **personal layer** (F1.9). That contract is then `enforce` for that skill version. Only a person can make a change that loosens it (F17).

- **F1.9 Override storage:** a personal entry in `$.store`, and `.taskmaster/overrides/<skill>.json` in the project (under `overrideDir`), which a person commits so the team shares it. Checkpoint commits leave the file out (F17). F16 is the guided way to create either.
  - **JSON, not YAML** (owner decision, 2026-11-04). The mod API has no YAML parser, and a mod has no npm packages. Frontmatter is YAML, but it arrives already parsed.
  - **The file holds the `taskmaster:` block itself**, not `{ "taskmaster": … }`, with the same keys and checks. For example:
    ```json
    { "mode": "enforce",
      "steps": [ { "id": "tests", "title": "Run the test suite", "verify": { "bash": "npm test" } } ],
      "confirm_before": [] }
    ```
  - **Two layers** (owner decisions, 2026-11-04):
    - **The personal layer** is an entry in `$.store`, keyed by repository and skill: edits you don't want to commit. `$.store` is per user and per machine, and doesn't survive a fresh cloud container. **It wins when both exist.**
    - **The project layer** is the file above: shared, committed and reviewed. The mod reads it each time there's no personal entry, as in a fresh cloud container or on a teammate's machine. It never copies the file into the store, so a change to the file reaches everyone without a personal entry, and the mod needn't know whether it runs on a PC or in the cloud.
    - **The file is opt-in.** A person writes it to share a contract: F16's apply with the project layer, or `/taskmaster contract export <skill>` (Phase 2, with `contract edit`, which starts from the file's contract when there is one).
    - **Open question for the owner:** whether an override may beat a third-party skill's own frontmatter.
    - Both layers are protected as F17 says. A project file that loosens what it replaces needs the person's yes, once per file version and store, unless `overrideTrust: default-branch` trusts it (F17.1).
  - **The file is named after the skill as `skill.prompt` names it,** with anything but letters, digits, `.`, `-` and `_` changed to `_`. A plugin's skill arrives plugin-qualified, so `acme:notes` reads `acme_notes.json`; a hand-made `notes.json` won't match it.

### F2. Ledger: the mod's own record (source of truth)
- **F2.1** For each `tool.call` on any loop: `agentId`, tool, a trimmed input digest, `isError`, a sequence number, files touched, and the Bash command line.
- **F2.2 Task map** built from `TaskCreate` / `TaskUpdate` / `TodoWrite` *results*: task id → `[S#]` step, status history, owner (the loop that created it), and the ledger sequence numbers between `in_progress` and `completed`.
- **F2.3 Coverage map:** step → task(s) → state (`uncovered`, `pending`, `in progress`, `satisfied`, `waived`, `needs re-verify`).
- **F2.4** Stored in `$.state` and written to disk checkpoints (F8). Never rebuilt from `TaskList`, which lacks metadata.

### F3. Tools the mod gives Claude (`$.tool.register`, `isDeferred: false`)
- **`taskmaster_waive { step, reason }`** marks a step waived. It's logged, shown in the status line and the final summary, and at `strict` it needs the user's yes through `$.ui.ask`.
- **`taskmaster_await_user { question }`** records a legitimate wait, so the Stop gate won't fire while Claude is waiting on the user.
- **`taskmaster_checkpoint { summary, decisions[], open_questions[], next_action, current_step }`** saves the narrative checkpoint (F8.4).

### F4. Hard gates (deterministic)
- **G1: completing a task (`TaskUpdate status=completed`)** is denied when:
  - no work was recorded between `in_progress` and `completed` ("completed with no recorded work"),
  - a `verify` spec isn't met: there's no matching command *after the last edit*, or its exit was non-zero (matched on both command and error flag, so `echo PASS` doesn't count),
  - a burst of completions arrives with no work between them.

  It may fail closed, and every deny message ends with the waive instruction. `classic.TaskCompleted` → `{ block }` is a backstop for completions that bypass `TaskUpdate`.
- **G2: deleting a contract step's task (`TaskUpdate status=deleted`)** is denied and redirected to `taskmaster_waive`, so a step can't vanish silently.
- **G3: Stop (`classic.Stop`)** blocks when the active `enforce` contract has steps owned by this loop that are uncovered, pending, or in progress. Its reason lists the step ids and the three ways out: do it, waive it, or `await_user`. It fails open.
- **G4: subagent stop (`classic.SubagentStop`)** does the same, scoped to the tasks that subagent owns. It gates only agents the mod saw started through `agent.spawn`, never the engine's own helper agents, such as the compaction summarizer (§9, learned in the spike). A subagent that reports through `SubagentHandback` (auto mode on 2.1.317) can't be held at SubagentStop, so G4 also denies that call while the subagent's steps are open, under the same cap (§10.1).
- **Plan Gate:** under an `enforce` contract, write calls (`Edit`, `Write`, `NotebookEdit`, non-read-only Bash or MCP tools, read-only taken from `tool.check`) are denied until every mandatory step has a task. Read-only calls, task tools, the mod's own tools, and `AskUserQuestion` are always allowed.

### F5. Stop gate safety: loop limits and legitimate exits
- At most **2 blocks per contract per user turn**. Block again only if the ledger has moved since the last block. Otherwise let the stop through and append below the answer: `released: S3, S5 unverified`.
- **Never block** when `background_tasks` or `session_crons` aren't empty, when `stop_hook_active` would re-enter, or when the turn was interrupted (`isAborted`).
- **Legitimate waits** (the biggest false-positive risk): don't block if `await_user` was called this turn, or if the last message is asking the user something. A trailing "?" is the fast pre-check, and `$.model.classify` the fallback.
- **User redirect:** a new main-loop prompt (`turn.start` without `agentId`) suspends Stop-blocking for the previous contract and appends a one-line note asking Claude to continue that contract or abandon it.

### F6. Drift Monitor (soft)
- Write calls with no task in progress: warn under `enforce`, deny under `strict`.
- More than one task in progress: warn.
- Steps done out of declared order: warn only, because order in prose is often advisory.
- At most one batched note per turn, through `$.session.append`.

### F7. Advisory audit (soft, budgeted)
- **When:** at Stop, only after G3 passes, and only while a contract is active.
- **How:** `$.model.complete` with Haiku and `timeoutMs` ≈ 8 s, over **curated evidence of 2–5k tokens**: the contract, a ledger summary, waivers, and `last_assistant_message`. It never sees the full transcript, and no model is called per tool call.
- **Question:** "Which claims in the final message, and which steps, have no supporting evidence in the ledger?" Output is JSON findings with confidence.
- **Phase 2:** advisory only, with findings appended below the answer. **Phase 3:** may block **once** per Stop cycle, only on specific, high-confidence findings.
- **Phase 3 verifier:** for semantic `verify` specs, spawn a read-only verifier subagent *when a task is completed*, not at Stop, because spawning is refused past a Stop.

### F8. Checkpoints that survive compaction and a cold start (MVP-critical)

**F8.1 On-disk store** (in the working tree, where a new session, machine, or container will look):
```
.taskmaster/
  active.json                 # open run ids, owning session, lock heartbeat
  runs/<run-id>/
    checkpoint.json           # machine state (schema-versioned)
    HANDOFF.md                # narrative briefing for a cold session
    journal-<n>.jsonl         # event log, rolled into chunks (no append in $.fs)
```
- For checkpoints, `$.store` holds only a mirror and an index (it's per user and per machine).
- Secrets are redacted before every write.
- **`checkpointGit: commit` (default, approved).** At milestone checkpoints (step completed, PreCompact, Stop with open work, session end), the mod commits `.taskmaster/` (always at `$.session.root()`, never relative to a working directory a shell `cd` can move) alone, through `$.process.run`: first `git add -- .taskmaster/`, then `git commit --only -m "taskmaster: checkpoint <run> <step>" -- .taskmaster/`. The `add` is required: `commit --only` refuses paths git doesn't track yet, and a new run's files are untracked. `--only` keeps the user's other staged work out of the commit and leaves it staged (verified locally; the spike re-checks on your build). The fixed prefix makes these commits easy to squash or filter before a PR. Commits are throttled to at most one per milestone. Other values: `ignore` (excluded through `.git/info/exclude`) and, in Phase 2, `ref` (commit to `refs/taskmaster/<run>` with a temporary index, so the working branch history isn't touched).
- **`checkpointPush`:** `off` (default) or `milestone`. Commits survive a new session on the same clone. **In ephemeral containers (cloud sessions), the commits must also be pushed to survive**, so set `milestone` there, or rely on the session's own push.
- **First-commit notice (owner decision, 2026-11-03).** With `checkpointGit: commit`, before its first checkpoint commit in a repository whose remote is public, or whose visibility can't be determined, the mod asks once through `$.ui.ask`. The notice says that checkpoints hold the original request, decisions and commands, that secrets are redacted, and that the next `git push` publishes the rest. The user keeps committing or switches to `checkpointGit: ignore`; committing stays the default. Visibility comes from `$.process.run` (`gh repo view --json visibility`): no `gh`, or a host other than GitHub, counts as unknown, and the notice then says the remote "may be public". The answer is stored per repository in `$.store`, so it is asked again on a new machine. A repository with no remote, or a private one, gets no notice. A headless run has nobody to ask: it keeps the default and logs that the notice wasn't shown.

**F8.2 Contents**, enough to resume with no transcript:
- the run id, schema version, the sessions involved, and timestamps,
- **the goal**: the user's original request (from `prompt.submit` / `turn.start`) and any redirects,
- **the skill**: name, path, plugin, hash, and **the full contract embedded**, so a run can resume even if the skill file changed or is missing,
- **the ledger and coverage map**: tasks, steps, statuses, waivers, verify results,
- **the work trail**: files written (with a content hash at write time) and commands run (with error flag),
- **a workspace anchor**: git branch, `HEAD`, and a hash of the dirty-file list,
- **the narrative**: summary, decisions and their reasons, open questions, next action.

**F8.3 When the mod writes** (deterministic, throttled):
1. after every task transition,
2. every N write calls (default 10),
3. at `classic.PreCompact`,
4. at every `classic.Stop` (with `last_assistant_message`),
5. at `session.end`: the run is marked `paused` unless every mandatory step is satisfied or waived,
6. when context fill reaches `contextCheckpointPercent` (default 70%).

**F8.4 What Claude must write (enforced):**
- each G1 completion also needs a one-line `metadata.handoff` ("what changed / what's next"), which goes into `HANDOFF.md`. It's a claim, kept as narrative, never counted as evidence,
- `taskmaster_checkpoint` (F3) writes the narrative. **Freshness gate:** while mandatory steps are open, G3 also blocks when there has been no checkpoint call since the last write call, and asks for exactly one. This shares G3's loop limits and fails open.

**F8.5 Getting ahead of compaction:**
- At the context threshold, append a hidden user row asking Claude to call `taskmaster_checkpoint` *now*, while it still has full context.
- At `PreCompact`, if the narrative is stale, the mod drafts one with `$.model.fork`. That's acceptable here, because it's a summary, not an audit. It is main-thread only and misses the newest tail, so the deterministic ledger tail is appended to it and the draft is marked `auto-drafted`. On failure, the mod falls back to the deterministic sections.
- `session.compact`: add "preserve the run id, step ids, current step, and the `HANDOFF.md` path" to `instructions`.
- `PostCompact` / `SessionStart{compact}`: send `additionalContext` with the contract, coverage, and next action.

**F8.6 Cold-start resume** (`SessionStart` with `source` `startup` or `clear`):
- If `active.json` shows an unfinished run, send a short briefing as `additionalContext` (goal, skill, step states, next action, the `HANDOFF.md` path) and show a band entry: `Unfinished run: <skill> 4/7 · /taskmaster resume`.
- **Offered, not forced** (`resumePolicy`: `offer` (default), `auto`, or `off`).
- On resume, the Plan Gate requires three things first:
  1. **Reload the skill.** On a hash mismatch, show the difference in steps and ask the user which contract to keep, via `$.ui.ask`.
  2. **Rebuild the tasks.** The mod seeds them with `$.tool.call(TaskCreate)` from the checkpoint; the built-in list isn't relied on to persist.
  3. **Read `HANDOFF.md`.** The gate is satisfied once the mod sees a `Read` of that path.
- **Staleness:** compare the git anchor and the hashes of files the run wrote. Steps whose evidence changed drop to `needs re-verify`.
- `source: 'resume'` (the same transcript reopened): only a light reminder.

**F8.7 Integrity:** a lock with a heartbeat in `active.json` (`$.clock.every`), so a second live session gets a read-only briefing and needs `--force` to take over. Files are schema-versioned. A corrupt checkpoint is reported and `checkpoint.prev.json` kept. On load, `$.state` and the disk are reconciled, and the newer one wins.

### F9. Human control
- `/taskmaster` (status) · `off | advisory | enforce | strict` · `waive <step> <reason>` · `contract show|edit <skill>` · `checkpoint` · `runs` · `resume [run] [--force]` · `abandon [run]` · `report` · `exempt <skill>`.
- `/taskmaster frontmatter suggest|apply|check|list` (F16).
- Esc (`isAborted`) freezes every gate for that turn.

### F10. Multiple skills, subagents, teammates
- Step ids are namespaced `skill:S#`. At most **2–3 contracts are enforced** at once; older ones drop to advisory. Conflicts between skills are shown to the user, not resolved automatically.
- **Ownership by `agentId`:** the main loop's Stop doesn't block on tasks owned by a subagent that is still running. G4 holds subagents to their own tasks. (Subagents write to the session's shared task list.)

### F11. Visibility
- Status line `skill · 3/7 · 1 waived`, the band, and toasts on blocks. In Phase 2, a Pane: steps ✓ / ● / ○ / ⊘ / ↻, gate events, audit findings, cost.
- **Below every final answer** under an active contract (`turn.complete` text): steps satisfied, waived, and released unverified.

### F12. Configuration (`userConfig`)
- `strictness`: `observe` | `advisory` | `enforce` (default) | `strict`
- `maxStopBlocks` (2), `audit` (`off` | `advisory` | `blocking`), `auditModel` (haiku), `auditTimeoutMs` (8000)
- `exemptSkills`, `writeToolAllowlist`
- `checkpointDir` (`.taskmaster`), `checkpointGit` (`commit` | `ignore` | `ref`), `checkpointPush` (`off` | `milestone`), `checkpointEveryWrites` (10), `contextCheckpointPercent` (70), `resumePolicy` (`offer` | `auto` | `off`), `narrativeAutoDraft` (on)
- `metrics` (on), `metricsDir` (`.taskmaster/metrics`), `ratingSample` (1 in 3 runs, at most once per hour), `sentimentClassifier` (off; opt-in, because it reads the user's next prompt), `metricsWebhook` (off; optional `$.http.fetch` sink)
- `experiment` (`off` | `on`), `experimentWeights` (`baseline` / `generic` / `frontmatter`), `experimentBlind` (hide the arm label so ratings aren't biased)
- `rca` (`manual` | `auto` | `off`), `rcaModel`, `rcaDailyCap` (5), `circuitBreakerThreshold` (3 user friction signals per session)
- `frontmatterNudges` (on), `overrideDir` (`.taskmaster/overrides`), `overrideTrust` (`ask` | `default-branch`; F17.1)

### F13. Metrics and experiments: quantify results and user experience

A third-party mod can't send events to Anthropic's telemetry or to the user's OpenTelemetry collector; in this build both are reserved for the engine and built-in plugins. So the mod **owns its metrics files**. They live in the project next to the checkpoints, are committed with them (so they survive cloud containers and can be mined across clones), and are mirrored in `$.store`.

**F13.1 Event log:** `.taskmaster/metrics/events-<date>-<n>.jsonl`, schema-versioned.
- *Common fields:* `schema`, `mod_version`, the engine build (`$.session.version()`), `session_id`, `run_id`, `agent` (main or subagent), `skill_id` (name + hash), `skill_source`, **`contract_source`** (`frontmatter-authored` | `frontmatter-suggested` | `override-authored` | `override-suggested` | `llm` | `heuristic` | `none`; F16 records which ones it produced), `contract_confidence`, `strictness`, **`arm`**, and `ts`.
- *Event types:*
  - contract built (kind, step count, confidence, extraction latency and tokens),
  - task transition,
  - **gate decision** (gate, decision `allow` | `warn` | `deny` | `block` | `release`, reason code, step, hook latency in ms),
  - waiver (who: Claude or the user, plus the reason),
  - **user intervention** (Esc within 30 s of a block, `/taskmaster off|advisory|exempt`, contract edit, resume or abandon),
  - compaction, checkpoint, resume (with a redo count),
  - audit call (tokens, latency, findings),
  - turn summary (duration, `usage`),
  - rating, incident (F15).
- *Privacy:* no raw prompt, code, or file contents. Commands are stored as the normalized program plus a hash of the arguments, and paths are hashed relative to the repository root. Redaction runs before every write. The mod sends nothing off the machine unless `metricsWebhook` is set, but by default the files are committed with the checkpoints, so a push publishes them.

**F13.2 Run summary:** one row per run in `runs.jsonl`.
- **Steps:** declared, satisfied, waived (by Claude or the user), released, abandoned.
- **Silent skips:** steps with no evidence and no waiver when the run ended. This is measurable in the `baseline` arm too, so it is the core "did the mod help" number.
- **Blocks per gate:**
  - *effective blocks*: followed by ledger work that satisfies the step,
  - *friction blocks*: followed by a waiver, release, override, or `off`,
  - **saves**: a G1 deny after which the verify step ran and *failed* or led to new edits. That is a real problem caught.
- **Overhead:** total hook latency, extra turns caused by Stop blocks, audit and extraction tokens, and tokens spent in turns after a block.
- **Outcome:** `completed` | `paused` | `abandoned` | `resumed-completed`.
- **Continuity:** compactions survived, and resume correctness (satisfied steps redone).
- **Experience:** the rating, if one was given.

**F13.3 User-experience signals:**
- *Explicit, sampled (`ratingSample`):* when a run completes or is released, the band shows one row of buttons: `helpful` · `neutral` · `got in the way`, then `too strict` · `about right` · `too loose`. It takes one click, can be dismissed, and never appears more than once an hour.
- *Implicit:* the interventions in F13.1, and the circuit-breaker trips (F15.5).
- *Optional (`sentimentClassifier`):* `$.model.classify` labels the user's next prompt after a block as `frustrated`, `neutral`, `positive`, or **`reports-skip`** ("you skipped the tests"). Only the label is stored. `reports-skip` is the best available measure of **misses** (false negatives), which the other metrics can't see.

**F13.4 Experiment arms: comparing frontmatter against no frontmatter, and the mod against no mod.**
- `baseline`: observe only. Metrics and checkpoints run, with no footer and no gates. This measures the natural silent-skip rate.
- `generic`: enforce with the extracted contract, and the skill's `taskmaster:` frontmatter *ignored*.
- `frontmatter`: enforce with the skill's `taskmaster:` frontmatter. Only skills that have it are eligible.
- *Assignment* is per run, a deterministic hash of the `run_id` against `experimentWeights`, and is recorded on every event. `experiment: off` (the default outside evaluations) means everyone gets the configured strictness.
- **Paired design for the frontmatter question:** pick 5–10 evaluation skills and write `taskmaster:` frontmatter for each, so the *same* skill runs with and without it. Comparing skills that happen to have frontmatter against skills that don't would mix the effect of the frontmatter with the effect of the authors who bothered to write it.

**F13.5 Evaluation harness:** offline and reproducible.
- Each evaluation skill gets a task suite of 3–5 scripted tasks with deterministic graders: tests pass, required files exist, required commands ran, required sections are present.
- Add **trap tasks** built to tempt skipping (slow or failing tests, a tedious last step), to measure saves.
- Run headless with `claude -p --plugin-dir <taskmaster>` in fresh worktrees, N repeats per arm, and collect the metrics files.
- Headless runs have no user, so the harness measures effectiveness and overhead. **User experience comes from live dogfooding.**

**F13.6 Mining:**
- `/taskmaster metrics` gives an in-session summary for this project. `/taskmaster metrics export` writes one bundle (JSONL + CSV) with a data dictionary.
- A small offline analysis script, outside the mod (DuckDB or pandas), computes the go/no-go table (§10) per arm and per `contract_source`, with bootstrap 95% confidence intervals.

### F14. Quality and packaging
- `claude plugin validate` and `tsc -p` on every change. A `claude plugin test` suite for each gate, plus a compaction test and a cold-start test. Written test-first, with `npm run coverage` holding the mod to at least 95% line and function coverage (see `CLAUDE.md`).
- A startup self-check logs which events fired on this build, because the API is early access and changes between releases.
- Install with `/plugin install taskmaster --marketplace <owner>/<repo>`.

### F15. Self-improvement loop: canary → RCA → proposal → replay → human approval

The idea is sound, but **the loop must never let the mod loosen itself.** The cheapest way to cut friction is to stop enforcing, so any automated optimizer, LLM or not, drifts there unless every change is weighed against what the mod catches. The loop therefore *detects and diagnoses* on its own, and *changes* things only with evidence and a human's yes.

**F15.1 Canaries (deterministic tripwires).** Each trip writes an *incident* record with a slice of the journal around it.
- *Friction:*
  - a block followed by a waiver, release, or user override in the same turn,
  - Esc within 30 s of a block,
  - `/taskmaster off`, `advisory`, or `exempt`,
  - a `got in the way` or `too strict` rating,
  - a `frustrated` label,
  - a Stop block that hit the cap,
  - a skipped or failed hook,
  - a gate slower than its latency budget.
- *Misses (false negatives):*
  - `reports-skip`,
  - an audit finding the user confirms,
  - a resumed run that redoes a satisfied step,
  - a verify step that passed but the user then reports the work broken.
- *Contract health:*
  - low extraction confidence,
  - **the user edited a contract.** That edit is a free, correct label for an extraction error.

**F15.2 RCA with 5 whys:** generated independently, outside the user's turn.
- **Not the working Claude, mid-task.** It would spend the user's turn, and it is a biased witness: it will tend to blame the gate. Its own first-person signal is already captured cheaply in waiver reasons.
- Incidents queue to `.taskmaster/rca/queue/`. They're processed when the session is idle (a `$.clock.after` timer after `turn.complete`), or on demand with `/taskmaster retro`. The work is a `$.model.complete` call on `rcaModel`, capped at `rcaDailyCap`.
- **Input:** the incident, the redacted journal slice, the contract and the relevant section of the skill, the rule that fired, and the waiver reason or the user's words. All of it is treated as data, not instructions.
- **Output schema:**
  ```json
  { "summary": "...",
    "five_whys": [{ "why": "...", "answer": "...", "evidence": ["evt_123", "evt_130"] }],
    "category": "verify-spec-mismatch",
    "verdict": "false_positive",
    "proposed_fix": { "type": "contract_patch", "target": "skill:deploy@hash", "change": "...", "expected_effect": "..." },
    "confidence": 0.7 }
  ```
  - **Every "why" must cite journal event ids;** an uncited answer is dropped. The chain may branch and stops at 5.
  - `verdict` may be **`true_positive`**: the friction was the mod doing its job, because Claude really was skipping. Not all friction is bad, and the RCA has to be allowed to say so.
- **Fixed taxonomy**, so results can be counted and not just read:
  - *extraction:* a missing, extra, or wrong step, or a conditional step that didn't apply,
  - *verify-spec mismatch:* a different runner (`pnpm test` vs `npm test`), a flaky check, or an environment that can't run it,
  - wait misdetected · wrong agent attribution · gate bug · threshold too tight · ambiguous skill (an authoring issue) · user changed goal · model gaming · **true skip** · environment.
- **Deduplicated by signature** (gate + skill + category). After 3 RCAs with the same signature, stop generating new ones and just count.

**F15.3 Proposals.** They go to `.taskmaster/rca/proposals/` and are never applied automatically.
- A per-skill contract patch, applied as a per-skill override, or a suggested `taskmaster:` frontmatter block for the skill's author.
- Rule or threshold tuning, for example letting verify matching accept equivalent test runners.
- A mod bug report with a reproduction (the journal slice), formatted to paste as a GitHub issue.
- Skill-authoring feedback ("step 4 is ambiguous: it says 'verify' with no command").

**F15.4 Canary validation before anything changes:**
- **Offline replay.** The gates are deterministic functions of the ledger, so recorded journals can be replayed through a candidate rule set. The report shows the change in blocks, friction blocks, and **saves lost**. A change is promotable only if friction falls *and* saves don't fall beyond a set tolerance. This is the safeguard that keeps the loop from optimizing toward "enforce nothing."
- **Shadow mode.** The candidate rule runs live next to the current one, logging "would have blocked" decisions without acting, for N runs.
- **Staged rollout.** A new mod version runs as an experiment arm. It rolls back automatically if its friction rate, or any trapped session, exceeds the current version's.
- **Human approval.** `/taskmaster proposals` lists the proposals, each with its replay result. `accept <id>` applies per-skill overrides directly. Code changes become a patch or PR for the mod's developer.

**F15.5 Session circuit breaker** (the only automatic loosening, and safe):
- If **user** friction signals in one session reach `circuitBreakerThreshold` (3), the mod drops to advisory for the rest of that session, says so once, and files an incident. The signals are overrides, `off`, Esc after a block, and `got in the way`.
- Only the user's actions count. **Claude's own waivers never loosen the mod**, or Claude could negotiate its own leash.

**F15.6 Measure the loop itself:**
- incidents per 100 runs, by category, per mod version,
- the mix of RCA verdicts,
- proposals generated, accepted, and rejected,
- the friction trend after each accepted change.

If RCAs are mostly `unclear` or get rejected, scale the generator back to `manual`.

### F16. Frontmatter advisor: recommend `taskmaster:` frontmatter, then add it to this or any other skill

A user asks Claude to read a skill and recommend Taskmaster frontmatter for it. Claude drafts it with the mod's help, the user reviews it, and then chooses where it goes: that skill, a new skill, other skills, or an override file that leaves the skill untouched. This is also how the Phase 1.5 evaluation gets its frontmatter.

**F16.1 Entry points**
- **Plain request:** "recommend taskmaster frontmatter for the deploy skill." The plugin ships a skill, `taskmaster:frontmatter`, in its `skills/` folder. Its description triggers on requests like this, and it runs the workflow below. The skill carries its own `taskmaster:` frontmatter, so the mod enforces its own workflow. (The spike checks that a `skills/` folder loads beside the hooks module; the slash command is the fallback.)
- **Slash command:**
  - `/taskmaster frontmatter suggest <skill|path> [more ...]`
  - `/taskmaster frontmatter apply <suggestion-id> [--to <skill|path> ...] [--as file|override]`
  - `/taskmaster frontmatter check <skill|path>`: lint existing frontmatter or an override.
  - `/taskmaster frontmatter list`: every skill the mod knows, marked as having frontmatter, an override, or neither, with its run count and friction rate. It shows where frontmatter would pay off most.
- **Nudges** (band only, never blocking, at most one per skill per week; `frontmatterNudges`), when:
  - a new `SKILL.md` is written under a skills folder (seen through `tool.call` on `Write`/`Edit`),
  - a skill's contract ran `advisory` because extraction confidence was low,
  - a skill has repeated friction incidents (F15).

  Each nudge reads `Add taskmaster frontmatter to <skill>? /taskmaster frontmatter suggest <skill>`.

**F16.2 Finding the skill.** The mod's skill API only intercepts a skill as it loads; it can't list installed skills. So a target is resolved from:
1. the skills the mod has seen load (`skill.prompt` `path`, `source`, `pluginName`, kept in `$.store`),
2. a `$.fs.list` scan of the standard folders: the project's `.claude/skills/` and `.claude/commands/`, `~/.claude/skills/`, and the folders of installed plugins,
3. an explicit path. Claude can also use the skill list in its own context to match a name.

**F16.3 Tools the mod registers** (`isDeferred: false`):
- **`taskmaster_frontmatter_draft { target }`** returns everything Claude needs to write a good recommendation:
  - the skill's path, source, and current frontmatter,
  - **the compiler's draft** (F1.2 parse + F1.3 extraction, with confidence),
  - the schema and the authoring rules,
  - **the skill's history:** its runs, incident categories, RCA proposals, and any existing override, for example "verify-spec mismatch ×4: the repo uses `pnpm test`",
  - **repo facts for verify specs:** the test, lint, and build commands found in `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, and so on.
- **`taskmaster_frontmatter_validate { target, yaml }`** runs the deterministic lint (F16.7) and returns errors and warnings. A recommendation must pass it before it's shown.
- **`taskmaster_frontmatter_apply { suggestion_id, targets[], mode }`** records the decision.
  - `mode: override`: the mod writes the override itself, to the layer the person picks (F1.9): the personal layer by default, or `.taskmaster/overrides/<skill>.json` in F1.9's format and name.
  - `mode: file`: it returns the exact edit for Claude to make with the normal `Edit` tool. **The mod doesn't write skill files itself**, so the user's usual permission prompt and diff view apply.

**F16.4 Workflow**
1. **Resolve** the target to a path and its source.
2. **Draft.** Call `taskmaster_frontmatter_draft`.
3. **Read and refine.** Claude reads the skill file in full with `Read`, then refines the draft:
   - step titles reuse the skill's own wording,
   - conditional steps ("if…", "when…", "optionally") are made non-mandatory with a `when:` note,
   - verify specs use commands that actually exist in this repo,
   - irreversible steps (deploy, publish, push, delete, migrate) go in `confirm_before`,
   - `mode: enforce` only when the steps are unambiguous, otherwise `advisory`.
4. **Validate.** It must pass `taskmaster_frontmatter_validate`.
5. **Present the recommendation:**
   - the YAML,
   - a one-line reason for each step, quoting the skill line it came from,
   - **what changes in enforcement**, for example "today: advisory (confidence 0.55) → enforce; G1/G3 apply to 3 mandatory steps; `deploy` will ask you first",
   - a diff preview of the file change.
6. **The user chooses** (AskUserQuestion):
   - **Add to this skill's file**
   - **Save as an override only** (the skill file is untouched)
   - **Also apply to other skills** (a multi-select of known skills, including one just created)
   - **Edit first** (the user changes steps, and the flow returns to step 4)
   - **Discard**
7. **Apply**, then run the post-check (F16.6).

**F16.5 Applying to a new skill or any other skill**
- **Frontmatter is specific to its skill and is never copied verbatim.** For each other target, the flow runs steps 1–5 against *that* skill, using the approved suggestion as a template. The template carries over structure and conventions (the `confirm_before` pattern, the repo's verify commands, the strictness choice). Each step must then match something in the target's own text. Steps that don't match are dropped and listed, and each target gets its own review.
- **Batch:** `suggest a b c` produces one review per skill. The user approves each one, or all at once.
- **New skills:** when Claude is helping create a skill (including through a skill-creation skill), it offers to include the recommended frontmatter in the same write, so the skill is born with a contract.

**F16.6 Where it's written, and safe-edit guarantees**

| Skill source | Default target | Why |
| --- | --- | --- |
| `projectSettings` (the repo's `.claude/skills`) | the skill file | It's yours, versioned with the repo, and shared with the team |
| `userSettings` (`~/.claude/skills`) | the skill file | It's yours |
| A plugin you're developing (`--plugin-dir`, a folder marketplace) | its source file | It's yours |
| An installed plugin (a git or npm copy) | override | Edits are overwritten on update, and it's not yours. Also offer a ready-to-paste **upstream suggestion** (the snippet and issue text) for its author |
| `policySettings` (managed), `mcp`, `syncedSkills`, `built-in` (no file) | override only | It can't or shouldn't be edited |

- **Post-check after the `Edit`:**
  - the mod hashes the skill body and every other frontmatter key before and after. **Only the `taskmaster:` key may change.** Anything else triggers a hidden note asking Claude to revert it, and an incident is logged,
  - the YAML parses, the schema validates, and existing keys (`name`, `description`, `allowed-tools`, ...) keep their values and order,
  - replacing an existing `taskmaster:` block shows the old and new versions side by side first.
- **Not committed automatically.** It's the user's content, unlike checkpoints.
- **Active runs keep their current contract.** The new frontmatter takes effect the next time the skill loads (the hash changes, so the cached contract is dropped).
- If a skill has both frontmatter and an override, `check` warns about any difference between them. The order of precedence stays as in F1.4.

**F16.7 Lint rules** (for `validate` and `check`):
- **Schema:** known keys, `version`, unique step ids, correct types.
- **Grounding:** each step's title fuzzy-matches text in the skill body ("step `release` not found in the skill text").
- **Runnable verify specs:** the command exists, for example `npm test` needs a `test` script in `package.json` and `pytest` needs its config. Missing ones are warned about.
- **Reasonableness:** warn when:
  - there are more than 12 mandatory steps,
  - an irreversible-sounding step has no `confirm_before`,
  - every step is mandatory but none has a `verify` ("the gates can only check that work happened"),
  - `mode: enforce` is set but a mandatory step uses conditional language.

**F16.8 Provenance and measurement**
- Frontmatter written by the advisor carries `taskmaster.version: 1`, `taskmaster.origin: suggested`, and `suggested_by: taskmaster@<version>`. Hand-written frontmatter uses `origin: authored`. This feeds the `contract_source` split in F13.1.
- Events logged:
  - suggestion generated (steps, confidence),
  - **each step accepted, edited, or removed by the user,**
  - where it was applied and how,
  - the post-check result,
  - and, later, how runs perform for each origin.
- **The user's edits to a suggestion are free, correct labels for the compiler.** They're logged as `extraction` incidents and feed the F15 loop.

### F17. Tamper resistance: Claude can't loosen its own contract

The worry is Claude weakening what it's held to, to "game" the system: editing an override, a skill's `taskmaster:` block or the mod's settings so a step it skipped no longer counts.

**What can't be done.** The mod can't stop Claude, running as the same OS user, from editing these files, and it can't hide them.
- The personal layer is a plain JSON file, `~/.claude/plugins/store/<plugin>…json` (seen on 2.1.317).
- The mod's own source and docs can be read too.
- In a cloud container Claude runs as root, so file permissions don't help either.
- Claude can start a nested interactive `claude` from the shell and drive it, with `tmux` for example. It could type a `/taskmaster` command there, which arrives with origin `composer`, and answer that session's `$.ui.ask` itself. So the person-only channels below hold only while Claude doesn't do that. The guard sends a shell command that starts `claude` to a person, and the tripwire records it.

So F17 is a guard rail, not a security boundary, in the same way as this repository's own deny rules, and in line with §7: *visible* skipping, not perfect prevention.

**What is promised instead: an edit never loosens enforcement unless a person approves it, and the person always sees it.**

**The levers it covers:**
- the project override file and the personal layer,
- a project skill's own `taskmaster:` block,
- the mod's settings in `settings.json` (`strictness` and the rest),
- `/taskmaster off` and `waive`.

The mod's own code is covered by visibility only.

**The mechanisms, strongest first:**
1. **A run keeps the contract it started with**, as F16.6 already says for frontmatter.
2. **Loosening needs a person.** Loosening means: a lower `mode`, a mandatory step removed or made optional, a `verify` spec removed or changed, or `confirm_before` dropped.
   - A changed contract that loosens applies only after the person says yes in `$.ui.ask`, the engine's own dialog.
   - In a `-p` run `$.ui.ask` rejects (no one to ask), so an unapproved loosening never applies there.
   - A change that only tightens applies at once.
3. **Only person-driven channels write.**
   - The personal layer is written only by a typed `/taskmaster` command, followed by `$.ui.ask` for any loosening.
   - Seen live: the model can't run a plugin's registered command. The `Skill` tool refuses it ("Ask the user to run /gp-hello themselves").
   - F16's `taskmaster_frontmatter_apply` is a tool the model can call, so it puts the decision to the person itself, through `$.ui.ask`. F16.4's AskUserQuestion step is the model's own, so it doesn't count.
   - The command's `origin` isn't relied on. A command typed in the Claude app reads `composer`, and one typed in a `-p` run reads `sdk`. A nested `claude -p` that Claude starts from the shell would read `sdk` too, and a nested interactive one driven through `tmux` would read `composer`. The `$.ui.ask` step is what Claude can't answer from its own session.
4. **A guard in `tool.check`.** It answers `ask` for:
   - `Write`, `Edit` and `NotebookEdit` on a protected path,
   - non-read-only `Bash` whose command names one,
   - `Bash` that starts a nested `claude`, which could type a command and answer its dialog (best effort, like the rest of the `Bash` guard).

   A plugin's `ask` goes to a person.
   - Seen live on 2.1.317: in default and accept-edits modes, a `-p` run refused the write, and the file wasn't created.
   - Bypass mode is untested, because the cloud sandbox won't start one.
   - The Bash part is best effort: a command can name a path indirectly.
5. **A session copy of the personal layer in `$.state`.** `$.state` lives in the engine's memory, not on disk. A later read of `$.store` in the same session that differs from the mod's own last write is evidence of tampering: the mod ignores it and files an incident.
   - **This covers one session only.** A store edited through the shell in one session takes effect when the next session starts, and no copy is left to compare. Across sessions, only the guard (4) protects the personal layer.
6. **Visibility, the backstop for what the guard misses:**
   - The summary below each answer (F11) names the contract's source whenever it's an override, and flags a contract that is looser than what it replaced.
   - Any tool call that touches a protected path trips an F15.1 canary, with the RCA category *model gaming*.
   - Checkpoint commits leave `overrides/` out (F8.1), so the mod's own commit never turns an unapproved edit into history that looks reviewed.

**F17.1 Trusting the default branch: the override guard** (owner decision, 2026-11-04). In a fresh cloud container the store is empty, so each project file that loosens a contract would ask again. A repository can instead hold override changes when they're reviewed:
- **The CI check.** Taskmaster ships a workflow template that holds any pull request changing a file under `overrideDir`, or the workflow itself, until the owner approves it. It flags every change, tightening included. A loosening-only check, which would run the base branch's `contract.ts` on the files as data, is a later refinement.
- **Why an environment, not a PR review.** Claude opens pull requests under the owner's account, and GitHub doesn't let an author approve their own pull request, so neither a PR review nor a CODEOWNERS rule can hold them. The approval is a GitHub environment, `taskmaster-overrides`, with the owner as its required reviewer and *Prevent self-review* off. The owner approves in the run's *Review deployments* dialog, or with `gh api`. Environments with reviewers are available for public repositories on every plan, and for private ones on paid plans.
- **The mod's side,** with `overrideTrust: default-branch` (F12, opt-in). A project file whose content matches the default branch's version applies without asking: with the check required and no bypass, every change on that branch was approved. The mod fetches the default branch itself, so a moved local ref can't fake a match, and the guard (4) also watches `git remote set-url`, `git update-ref` and writes under `.git/`. The default, `ask`, is right for a repository without the check, because the mod can't tell whether one runs.
- **The residual.** The approval rests on the owner's GitHub account, and Claude works through credentials that act as that account. The GitHub tools in this cloud session have no method to approve a deployment (checked 2026-11-04), but a shell call to the API might succeed if the session's token allows it. So this approval is a guard rail like the rest of F17, not the outside authority below. To narrow it:
  - deny `gh api` calls on `pending_deployments` in `.claude/settings.json`, for example `"Bash(gh api *pending_deployments*)"`, and check the rule with `/permissions`,
  - check that the Claude GitHub App's repository permissions don't let it approve deployments.
- **The template** (P1.7c ships it as `taskmaster/templates/override-guard.yml`):

```yaml
# Holds a pull request that changes a taskmaster override file until the owner approves it
# (taskmaster plan F17.1). Copy it to .github/workflows/taskmaster-override-guard.yml.
#
# pull_request_target runs this file from the base branch, so a pull request can't edit the
# check for itself. It never checks out or runs pull request code: it reads only the list of
# changed file names.
#
# Setup, once:
# 1. Settings > Environments > New environment, named taskmaster-overrides. Add yourself as a
#    required reviewer. Leave "Prevent self-review" off: Claude opens pull requests under your
#    account, so with it on nobody could approve them.
# 2. Once this file is on the default branch, make both jobs, override-changes and
#    override-approval, required status checks. A required check can't report on the pull
#    request that adds it. Both are needed, because override-approval is skipped, which
#    counts as a pass, both when no override file changed and when override-changes fails.
# 3. If you changed taskmaster's overrideDir setting, change OVERRIDE_DIR below to match. If
#    you rename this file, change GUARD_FILE: a change to this workflow needs approval too,
#    or a pull request could switch the guard off before it next runs.
#
# Each new push, and each edit of the pull request, asks for approval again. Skipping the
# approval on an edit would let that skipped run count as a pass.
name: Taskmaster override guard

on:
  pull_request_target:
    # edited, because retargeting a pull request onto the default branch must run this too.
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: read

env:
  OVERRIDE_DIR: .taskmaster/overrides
  GUARD_FILE: .github/workflows/taskmaster-override-guard.yml

jobs:
  override-changes:
    name: override-changes
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      touched: ${{ steps.list.outputs.touched }}
    steps:
      - name: List the override files, and this guard, if the pull request changes them
        id: list
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          CHANGED_FILES: ${{ github.event.pull_request.changed_files }}
        run: |
          # GitHub lists at most 3000 files, so a longer list could hide an override file.
          if [ "$CHANGED_FILES" -ge 3000 ]; then
            echo "::error::This pull request changes too many files to check for override files."
            exit 1
          fi
          gh api "repos/$REPOSITORY/pulls/$PR_NUMBER/files" --paginate \
            --jq '.[] | .filename, (.previous_filename // empty)' > "$RUNNER_TEMP/changed.txt"
          touched=false
          while IFS= read -r path; do
            case "$path" in
              "$OVERRIDE_DIR"/* | "$GUARD_FILE")
                if [ "$touched" = false ]; then
                  printf '### Override files or the override guard this pull request changes\n\n' >> "$GITHUB_STEP_SUMMARY"
                fi
                touched=true
                # A file name comes from the pull request, so keep it inside a code span.
                printf -- '- `%s`\n' "${path//\`/}" >> "$GITHUB_STEP_SUMMARY"
                ;;
            esac
          done < "$RUNNER_TEMP/changed.txt"
          echo "touched=$touched" >> "$GITHUB_OUTPUT"

  override-approval:
    name: override-approval
    needs: override-changes
    if: needs.override-changes.outputs.touched == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: taskmaster-overrides
    steps:
      - name: Approved
        run: echo "The owner approved this pull request's override changes."
```

**Future work, for teams that need a real guarantee:** an authority outside the process.
- Managed settings owned by root, with permission deny rules on the protected paths, and Claude running as a non-root user.
- Approvals signed with a key only the person holds.

## 6. Strictness levels

| Level | Footer | Plan Gate | G1/G2 | G3/G4 Stop | Drift | Checkpoints | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| observe | no | log | log | log | log | mod-written | off |
| advisory | yes | warn | warn | note below answer | warn | + nudges | advisory |
| enforce (default) | yes | deny | deny | ≤2 blocks, fail-open | warn | + freshness gate, resume gates | advisory |
| strict | yes | deny | deny; waiver needs user's yes | ≤3 blocks | deny writes with no task | + re-verify stale steps | may block once |

Under `enforce`, only contracts that are themselves `enforce` (F1.4) are gated. Low-confidence contracts stay advisory whatever the strictness level.

## 7. Out of scope (stated openly)
- Measuring "effort" or quality. Semantic checks of non-code output.
- Correctly extracting conditional workflows ("if X, then...") from arbitrary prose, or deciding whether a step applies to this particular request.
- Turning LLM-extracted MUST/NEVER rules into tool denials. Phase 3 allows only frontmatter-declared guards, and those *ask* the user rather than deny.
- Content in files a skill loads later, beyond what is re-parsed.
- Workflow-tool or remote agents with no local loop. Plugins with no skill or command text (hooks only, MCP tools only, agent definitions only). **"Universal" honestly means any skill or command.**
- Learning across sessions beyond per-skill overrides and counters.
- Preventing every kind of gaming. The goal is *visible* skipping, not perfect prevention.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Stop-block loops | 2 blocks per contract per turn, re-block only after ledger progress, release with a visible note, never with background work, fail open |
| False blocks on legitimate waits | `await_user` tool + question detection; LLM-extracted contracts default to advisory; every deny explains how to waive |
| Checklist theater | Tasks tied to `[S#]` steps; evidence comes from the ledger, not task metadata; verify specs match command and error flag; deletes redirected to waive |
| Wrong contract from extraction | Confidence + agreement with the deterministic parse; first-run review and per-skill override; advisory when unsure |
| Cost and latency | Extraction once per skill version; audit only at Stop, on curated evidence; `timeoutMs`; no model call per tool call |
| Contract lost on compaction | Checkpoint before compaction; `instructions`; re-injection on `PostCompact` / `SessionStart{compact}` |
| Work lost in a cold session or new container | On-disk checkpoint + `HANDOFF.md`; `checkpointGit: commit` for ephemeral containers; resume gates |
| Stale checkpoint | Git anchor + file hashes → `needs re-verify` |
| Two sessions on one run | Lock with heartbeat; `--force` to take over |
| Secrets in checkpoints | Redaction before every write |
| Requests and decisions reach git history through checkpoints | Committed by default (owner decision, reconfirmed 2026-11-03). `checkpointPush` is off, but an ordinary `git push` includes them, so a first-commit notice warns on a public or unknown remote (F8.1); `checkpointGit: ignore` opts out |
| Mod bug traps the user | Stop gate fails open; `/taskmaster off` and Esc always win |
| API drift between builds | Pin the build; startup self-check; validate in CI |
| Self-improvement loop drifts toward "enforce nothing" | Proposals are never applied automatically; replay must show saves weren't lost; only user signals trip the circuit breaker; RCA may return `true_positive` |
| RCA invents plausible stories | Every "why" must cite journal events; fixed taxonomy; dedupe by signature; track the accept and reject rate and scale back if it's poor |
| Metrics leak code or prompts | No raw text stored; hashed paths and arguments; redaction. The mod sends them nowhere unless `metricsWebhook` is set, but by default they're committed with the checkpoints, so a push publishes them |
| Rating fatigue skews UX data | Sampled 1 in 3, at most once an hour, one click; weighted against implicit signals |
| Checkpoint commits clutter history | `--only` pathspec commits with a fixed prefix (easy to squash or filter); `ref` mode in Phase 2 |
| Comparing frontmatter vs none is confounded | Paired design: the same skills with and without frontmatter; arms assigned per run by hash |
| Suggested frontmatter over-enforces a skill | Must pass validation (grounding, runnable verify, conditional-language checks); user review required; `advisory` when unsure; performance tracked per origin |
| Advisor edits a file it shouldn't (another author's or managed) | Target chosen by skill source; installed and managed skills get an override plus an upstream suggestion |
| Claude edits its own contract, overrides or settings to loosen enforcement | F17: a run keeps its contract; loosening needs the person's yes in `$.ui.ask`; a `tool.check` guard sends writes to protected paths to a person; override sources and loosened contracts are shown; checkpoint commits leave `overrides/` out; with `overrideTrust: default-branch`, a CI check holds override changes until the owner approves them (F17.1) |
| Edit damages a skill | Edits go through the normal `Edit` tool with its permission prompt; post-check allows only the `taskmaster:` key to change; never committed automatically |

## 9. Build order

**Phase 0: spike (1–2 days). Built, then deleted after Gate A (P1.0b):** [`spike/taskmaster-spike/`](https://github.com/bankielewicz/CM/tree/d46b356/spike/taskmaster-spike) and its [runbook](https://github.com/bankielewicz/CM/blob/d46b356/spike/taskmaster-spike/RUNBOOK.md), kept in git history at `d46b356`. Observe-only: capture skills, record the ledger, log to the journal, with one-shot probes for the checks that need an action. **Confirm on your build** (answered in §10.1):
1. the order of `tool.check` and `tool.call`,
2. that `$.tool.call(TaskCreate)` seeds tasks Claude actually sees,
3. whether the built-in task list persists across sessions,
4. `SessionStart.source` after `/clear` and after auto-compaction,
5. that a `classic.Stop` block makes Claude continue,
6. how skills preloaded into subagents are attributed,
7. that `git add -- .taskmaster/` followed by `git commit --only -- .taskmaster/` leaves the user's staged work untouched,
8. that metrics files can be written and rolled over within the hook budget,
9. that a `skills/` folder in the plugin loads beside the hooks module (for the `taskmaster:frontmatter` skill).

**Learned while building the spike** (these constrain how the real mod is written):
- **`$` can't be passed around.** The validator refuses a module that passes, binds, or stores the engine handle; every call must be spelled `$.noun.method(...)` where it's made. The real mod therefore builds one table of engine calls (write, read, tool call, process run, state update) in `session.start`, each a closure spelled that way, and the gates, ledger, and checkpointer use that table. Hooks that fire before `session.start` buffer their data.
- **State references need literals.** `atom({ plugin, key })` must name the plugin and key as string literals, not constants.
- **Relative `$.fs` paths follow the session's *current* working directory, and a shell `cd` moves it** (seen live: one `cd` sent a journal write to `.taskmaster/spike/.taskmaster/spike/`). `$.session.root()` is not moved by a shell `cd`, so the real mod anchors every `.taskmaster/` path to it. Under `claude plugin test`, the working directory is the plugin folder.
- **`git commit --only` needs a prior `git add`** for new files (see F8.1).
- **A mod's own `tool.check` hook isn't run on its own `$.tool.check` query** (observed live in the loaded spike). So the Plan Gate can't ask "is this read-only?" from inside `tool.call`. Instead it decides in the real call's `tool.check`, which runs inside `tool.call` and carries `isReadOnly`, answering `{ decision: 'deny' }` there. Real calls do carry it: on 2.1.317, read-only Bash commands (`cat`, `grep`, `ls`) arrived with `isReadOnly`, and `python3 -c` didn't. The spike's `check-every-mode` check found a `tool.check` on every main-loop model call in auto (90/90), plan (59/59) and default (28/28) modes. Bypass is untested, because cloud sessions don't offer it (RUNBOOK §5). The one call without a check was refused by the engine before the permission step (`ExitPlanMode` outside plan mode), so it didn't run either.
- **The validator lists every "gating hook without .catch"** (tool.call, Stop, compaction, ...). An observer that throws is skipped, which fails open. That suits the real mod's Stop gate; only the `TaskUpdate` gate gets a `.catch`.
- **`session.compact` wraps a compaction** (seen live on 2.1.317). It starts before `classic.PreCompact`, and its `next()` returns after `classic.PostCompact`. In between come the summarizer's SubagentStop and then `SessionStart(compact)`, which fires *before* PostCompact. So the checkpointer writes at PreCompact (or before session.compact's `next()`), and the resume briefing can be built at `SessionStart(compact)`.
- **The engine's own helper agents raise SubagentStop.** On 2.1.317, 30 of 32 SubagentStop events came from agents with an empty `agent_type` that no Agent call started (the compaction summarizer and small helpers that run around each prompt). G4 must gate only agents whose `agentId` it saw from `agent.spawn`. Otherwise it would block those helpers, including the compaction summarizer.
- **A subagent's answer comes from `turn.complete`, not SubagentStop.** When a spawned agent reports through `SubagentHandback` (auto mode), its SubagentStop has an empty `last_assistant_message`. When it ends with a plain answer (plan and default modes), SubagentStop carries the text. After a block, the agent's next SubagentStop fires before its `turn.complete`, and in both cases `turn.complete` carries the whole report as `answer`, with `agentId`. G4's question detection and any check of a subagent's answer read it there.
- **Only auto-mode subagents report through `SubagentHandback`, and a SubagentStop block can't hold those** (seen live on 2.1.317). All 5 auto-mode subagents were told to hand back and did. The plan-mode and default-mode ones (1 each) ended with a plain answer. A hand-back delivers the report before SubagentStop fires, and the engine ends the agent whatever the hook answers. There's no second stop, and `turn.complete` follows (0 of 2 held). A plain-answer subagent is held by the block (1 of 1). A `tool.call` deny on `SubagentHandback` holds a hand-back subagent (2 of 2), but the subagent acted on the deny's text only once. The other time, it retried with the same report. So G4 uses both hooks, with a cap (§10.1).
- **Classic hook payloads carry `permission_mode`** (UserPromptSubmit, Stop, SessionStart, SubagentStop). The mod reads the mode a turn's calls run in from UserPromptSubmit. The cloud session's Accept edits mode arrives as `default`.
- **Learned planning F17** (checked live on 2.1.317, with a probe mod):
  - `$.store` is a plain JSON file, `~/.claude/plugins/store/<plugin>_<source>-<hash>.json`, which the same OS user can edit.
  - A plugin's `tool.check` `ask` goes to a person. A `-p` run, with no person, refused the write in default and accept-edits modes, and the file wasn't created. Bypass mode is untested.
  - The model can't run a plugin's registered command: the `Skill` tool refuses it.
  - A typed command in a `-p` run carries `origin: { kind: 'sdk' }`, not `composer`.
  - A command typed in the Claude app, in a cloud session, carries `origin: { kind: 'composer' }` (the `/tm-origin` probe, 2026-11-04). The app shows a command's text reply after the command's name (`tm-origin: <text>`), so a reply needn't repeat the name.
  - Pull requests Claude opens in this repository are authored by the owner's account, so the owner can't approve them in a PR review (F17.1).
  - The GitHub tools in this cloud session can run, re-run and cancel workflow runs, but have no method to approve a deployment.
- **Learned in P1.2.**
  - `skill.prompt`'s text is `"Base directory for this skill: <dir>\n\n"` + the body, with no YAML block. A typed command's arguments are appended as `"\n\n\nARGUMENTS: <args>"`. Checked live: the capture's hash matched that form, and `/notes some words here` showed the block.
  - So a hash of the whole text changes with the skill's folder and with every argument. Contract caches and resume checks key on the body alone.
  - The mod API has no YAML parser; only frontmatter arrives parsed. So override files (F1.9) are JSON (owner decision, 2026-11-04).
- **Learned in P1.1** (seen live on 2.1.317, with probe mods reading the events and the mod's `$.state`):
  - A **typed `/name`** expands inside `prompt.submit`'s `next(e)`, before the main `turn.start`, and `prompt.submit` carries `command: { name, args }`.
  - A **`Skill` tool call** expands while the call is open.
  - A skill **preloaded into a subagent** expands after `agent.spawn` has answered with the agent's id, before that agent's first tool call. It doesn't expand while the spawn is open.
  - So the loop comes from what is open when `skill.prompt` fires (P1.1's rules in `docs/phase-1-tasks.md`).
  - **`/clear`** (seen live on 2.1.318, in a terminal, with the [second check](probes/event-order.md#second-check-clear) in the probe runbook). `session.end` fires with `reason: 'clear'` and the old id, then `classic.SessionStart` with `source: 'clear'` and a new `$.session.id()`, both before the next `skill.prompt`. `$.state` has emptied by then, while module state lives on: the types say `session.start` fires "never `/clear`". So a held list outlives the conversation, and the next save wrote it back: after `/notes`, `/clear`, `/forked`, `taskmaster.skills` held `notes` and `forked`. The mod now starts its captures over at each `session.end`, and holds only `forked` there. A closure on `session.start`'s `$` went on working after the `/clear`.
- **Learned reviewing P1.1** (seen live on 2.1.318, headless, with a probe mod):
  - **A preload's full order, the same in 7 runs**, times from `agent.spawn` answering: the agent's `turn.start` (1–3 ms before), `classic.SubagentStart`, `skill.prompt` (+10–52 ms), its first `turn.step` (+20–51 ms), its first tool call (+2.8–9.5 s). So `turn.start` can't end a preload window, and the first `turn.step` can. `turn.step` fires as the engine is about to send a request, and a preload has to be in place before the first one. **After a Claude Code update, recheck this order with the [event-order probe](probes/event-order.md)**, which records the build it last passed on and the expected result.
  - **The self-check can't see a reordering.** It lists which events fired, and kit tests raise events in the order a test writes them. A build that sent the first request before the preload would leave preloads unattributed and unenforced while the record looks healthy. That's why the probe above exists.
  - **The engine waits for `skill.prompt`'s hooks.** Holding one for 400 ms moved the agent's first `turn.step` from about +20 ms to +435 ms. A hook's own time has a budget, with `$.clock.sleep` counting and an in-flight `$` call or `next` not: `turn.step hook skipped: ran past its 10s budget`, at which point what's beneath it runs.
  - **`$.state` didn't behave as "one moment" in any hook dispatch.** The docs say every `get` of one dispatch reads one moment, whatever is written meanwhile. In practice a dispatch saw its own write, and a still-open one saw another dispatch's. Six overlapping `update` calls all landed, and an `update` on a finished dispatch's `$` landed at once. The mod still avoids depending on this: it's the only writer of its captures, so it holds the list and writes it with a plain `$.state.set`. A plain set writes what it's given, so a shaped value is written as `{ shape, value }`, and `read` unwraps it and declines another shape. All of that worked from a closure after the hook answered.
  - **A typed command's arguments:** without `$ARGUMENTS` they're appended as `ARGUMENTS: <args>`. With it, they're substituted into the body and there's no suffix.
  - **A forked skill (`context: fork`)** runs in a loop of its own, type `general-purpose`, with no `agent.spawn`. Through the `Skill` tool, `skill.prompt` fires inside the caller's open call, and the skill's tool calls carry the new loop's id. Typed, `skill.prompt` fires with no `prompt.submit` before it.
  - **`prompt.submit` isn't only a person's prompt.** It also fires with `origin: { kind: 'peer' }` when an agent's report is delivered (rechecked live on 2.1.318, in a terminal, for a background agent). The types also list `task-notification`, "a background task's notification", among the other kinds, so don't key anything on `peer` alone.
- **Learned in P1.0.**
  - A hook passed to `on` must be a function literal, or a function's name. A call that returns a hook doesn't load.
  - A `userConfig` number with `min` or `max` makes the engine refuse to load the module when a stored value is outside them. So one typo in settings switches the mod off. The real mod declares no `min`/`max`, and clamps in `parseConfig`. A string outside its `options` arrives as unset, so the `/config` picker stays.
  - In the kit, when the hook beneath a mod's hook throws, `next(e)` rejects and so does the `$.session.start` call that raised the event, although the kit also reports the throwing hook as skipped. Code after `await next(e)` is then lost, so `session.start` starts the self-check in a `finally`. This is a kit result only: the plugin-authoring reference says a failed hook is skipped and the chain continues, and a rejecting `next(e)` hasn't been seen on a real engine.
  - A busy session applies a `--plugin-dir` edit when its turn ends (seen once on 2.1.317: edits at 20:58:29, turn end at 21:03:46.463, `hooks module … reloaded` 135 ms later), while an idle one on the same folder reloaded about 10 s after the edit. So a live check of an edit looks for `reloaded` later than the edit before it trusts the absence of failure lines.
  - A kit test can't read a file (tried on 2.1.317): importing `plugin.json` fails with "is not named like code", `node:fs` and dynamic `import()` are refused, the scope has no `process`, `require` or `Bun`, and a helper plugin's `$.fs.read` gets "no implementation for fs.read". The kit also passes undeclared `options` through, so setting a key doesn't show that `plugin.json` declares it. An option of the wrong type does stop the load, so setting a key catches one retyped there.
  - A `session.end` save can finish before the process exits (seen once on 2.1.317, on a normal exit: the hook settled, `$.store.set` followed 7 ms later, and the record kept the event). So the self-check doesn't wait on it. A hard kill wasn't tried.
- **A container restart fires `session.start` but no `classic.SessionStart`** (seen live on 2.1.317, in a cloud session). The mod started 11 times: on first loads, on container restarts that resumed the session, and on a hot reload. `classic.SessionStart` arrived only with `compact` and `clear`, never `startup` or `resume`. `/clear` starts a new session id with an empty task list, while a restart resumes the original id and its list. So F8.6's cold-start check also runs from `session.start` and must be safe to run twice. It must also find the checkpoint without relying on the session id.

→ **Gate A (technical go/no-go, §10.1).**

**Phase 1: MVP prototype (about 2 weeks; ~900–1,200 lines including checkpoints and metrics).**
- the deterministic parse, cached Haiku extraction, and frontmatter support (F1.1–F1.7),
- the protocol footer and task seeding,
- the ledger (F2) and the three tools (F3),
- G1–G3 with the F5 safety rules,
- checkpoints and resume (F8.1–F8.6, with checkpoints committed; no fork auto-draft yet),
- `/taskmaster`, the status line, and the summary below the answer,
- **metrics:** the event log, run summaries, and sampled ratings (F13.1–F13.3), plus **experiment arms** (F13.4),
- **canaries:** tripwires and incident records (F15.1), the circuit breaker (F15.5), and an on-demand `/taskmaster retro` that runs RCA over the queued incidents (F15.2, manual mode),
- **frontmatter advisor, single skill:** the `taskmaster:frontmatter` skill and `suggest` / `apply` / `check`, with the three tools, the workflow, the source-based targets, the post-check, the lint, and provenance (F16.1–F16.4, F16.6–F16.8). This is built last in Phase 1, because Phase 1.5 uses it.

**Phase 1.5: evaluation (about 2 weeks; this is the prototype trial).**
- Use the frontmatter advisor (F16) to create `taskmaster:` frontmatter for 5–10 evaluation skills, a mix of your own and third-party skills, with the third-party ones saved as overrides. Hand-write it for at least 3 of them (`origin: authored`), so suggested and hand-written frontmatter can be compared.
- Build the harness task suites and trap tasks (F13.5), and run them for each arm.
- Dogfood the mod live with `experiment: on` for at least 30 runs.
- Run `/taskmaster retro` weekly to rank the friction sources.

→ **Gate B (product go/no-go, §10.2).**

**Phase 2: hardening.** The Plan Gate, G4, Drift, the advisory audit, question detection, redirect handling, multiple skills and subagent ownership, the Pane, F8.5 auto-draft, F8.7 locking, the per-skill contract editor, `ref` checkpoint mode, the full test suite, and automatic RCA with proposals and **replay validation** (F15.2–F15.4). Plus the remaining **frontmatter advisor** features (F16.5 batch and template application, new-skill integration, nudges, upstream suggestions, and `frontmatter list`).

**Phase 3: judgment.** A blocking audit (one bite), the verifier subagent for semantic verify specs, frontmatter constraint guards that ask the user, shadow mode and staged rollout (F15.4), the metrics view, and loop metrics (F15.6).

**Phase 4: ship.** Marketplace packaging, docs, and an authoring guide for the `taskmaster:` frontmatter key (the advisor itself, F16, is built in Phases 1 and 2).

## 10. Go / no-go gates

Write the thresholds down before the evaluation runs and don't move them during it. They are sensible starting points for a small sample. Report each with a bootstrap 95% confidence interval, and treat heavily overlapping intervals as "no difference."

### 10.1 Gate A: after the Phase 0 spike (technical feasibility)

| Check | If it fails |
| --- | --- |
| A `classic.Stop` `block` reliably makes Claude continue | **No-go for enforcement.** Pivot to an advisory "report card" mod (checkpoints, metrics, and a summary below each answer). |
| `tool.call` `deny` on `TaskUpdate` and write tools is reliable on the main loop | **No-go for G1 and the Plan Gate.** Keep only Stop-based enforcement. |
| The same `deny` is reliable in subagents | Not a no-go: G1 and the Plan Gate cover the main loop only, and the subagent gap is documented. Phase 1 is main-loop only anyway; subagent ownership and G4 are Phase 2. |
| `$.tool.call(TaskCreate)` seeds tasks Claude sees | Fallback: the footer tells Claude to create them, and the Plan Gate enforces it. Not a no-go. |
| Whether the built-in task list persists across sessions | Expected not to; the checkpoint rebuilds it. Not a no-go. |
| `SessionStart.source` after `/clear` and after auto-compaction | Adapt the resume triggers. Not a no-go. |
| Checkpoint commit with `--only` leaves the user's staged work untouched | Fallback: `ignore` plus `ref` mode. Not a no-go. |

**Result: GO** (recorded 2026-11-03, Claude Code 2.1.317, in a cloud session). All three blocking checks passed (`stop-block`, `deny-write` and `deny-complete`), and all 18 spike checks are answered. The run covered three session ids: `9ea42fa8`, plus `119c2caf` and `a9a1ddbd`, each started by a `/clear`. The full log is the spike's [`GATE-A-TASKS.md`](https://github.com/bankielewicz/CM/blob/d46b356/spike/taskmaster-spike/GATE-A-TASKS.md), kept in git history at `d46b356` since the spike was deleted, because `.taskmaster/spike/` isn't committed.

| Check | Result | What was seen |
| --- | --- | --- |
| A Stop block makes Claude continue | pass | Claude continued, and the next stop had `stop_hook_active: true`. |
| `deny` on `TaskUpdate` and write tools, main loop | pass | A denied Write didn't run, and a denied `TaskUpdate(→ completed)` left the task `in_progress`. A `classic.TaskCompleted` block also vetoed a completion. |
| The same `deny` in subagents | pass | A subagent's denied Write didn't run, and the subagent acknowledged the deny. So the softer subagent rule above isn't needed. |
| `$.tool.call(TaskCreate)` seeds tasks | pass | Claude's own `TaskList` showed the seeded task. |
| Built-in task list across sessions | doesn't persist (as expected) | `/clear` starts a new session id with an empty list. A container restart resumed the original id, and its list came back. |
| `SessionStart.source` | `compact` and `clear` | Never `startup` or `resume` across 11 mod starts. A container restart fires only `session.start` (§9). |
| Checkpoint commit with `--only` | pass | `git add` then `commit --only` committed only `.taskmaster/`, and other staged work stayed staged (git 2.43.0). |
| `tool.check` on every call, in every mode | auto 90/90, plan 59/59, default 28/28 | Bypass is untested, because cloud sessions don't offer it. |
| Compaction events | pass | `session.compact` wraps PreCompact, SessionStart(compact) and PostCompact. |
| Skills: attribution, and the plugin's `skills/` folder | pass | Attributed through the `Skill` tool and `agent.spawn`. The `taskmaster:` frontmatter block arrived intact. |
| Journal budget | pass | p95 write 2 ms under stress, and 5 ms live. |

**Fallbacks switched on:**
- The checkpoint rebuilds the task list, as planned.
- The Plan Gate reads `isReadOnly` from the real call's `tool.check`, because a `$.tool.check` query can't read it.
- G4 adds a `SubagentHandback` deny, described next.

**G4 settled (still Phase 2): two mechanisms, one for each way a subagent ends.**

| The subagent ends with | Seen in | A SubagentStop block holds it | A `SubagentHandback` deny holds it | It did what the hook's text asked |
| --- | --- | --- | --- | --- |
| A plain answer | plan, default | yes (1 of 1) | n/a | yes (1 of 1) |
| `SubagentHandback` | auto | no (0 of 2) | yes (2 of 2) | 1 of 2 |

- **Plain-answer subagents:** G4 blocks `classic.SubagentStop`, as designed.
- **Hand-back subagents:** G4 denies the `SubagentHandback` call while that subagent's steps are open. It re-checks on every attempt and lets the call through with a `released: ...` note after `maxStopBlocks`, like G3 (F5). A refusal holds the subagent but doesn't guarantee it acts on the refusal (one of the two retried with the same report). So the cap is what prevents a loop, and the deny names the open step.
- **Open:** bypass mode. Run `check-every-mode` and both subagent probes from a terminal session in bypass mode before the Plan Gate or G4 claim to cover it. The probes went with the spike, so run them from a checkout of `d46b356`.

### 10.2 Gate B: after the Phase 1.5 prototype trial (product value)

**Sample:** 5–10 skills, at least 3 harness runs per task per arm, and at least 30 live dogfood runs over 2 weeks or more.

| Group | Metric | Threshold |
| --- | --- | --- |
| **Safety: all must pass** | Trapped sessions (more than `maxStopBlocks` blocks, or a gate stuck on with no way out) | **0** |
| | Compaction tests passing | **100%** |
| | Cold-start resumes that pick up at the right step with no satisfied step redone | **≥ 90%** |
| | Checkpoint or work loss incidents | **0** |
| **Effectiveness: at least 3 of 4** | Fewer silent skips than `baseline` (`generic` and `frontmatter` arms) | **≥ 50% reduction** |
| | Effective blocks (followed by work that satisfies the step) | **≥ 60% of blocks** |
| | Friction blocks (followed by a waiver, release, override, or `off`) | **≤ 25% of blocks** |
| | Saves (real problems caught by G1) | **≥ 1 per 10 runs** |
| **Cost and experience: all must pass** | Median wall-clock overhead vs `baseline` | **≤ 20%** |
| | Median token overhead vs `baseline` | **≤ 15%** |
| | p95 latency of deterministic hooks | **≤ 100 ms** |
| | Live sessions where the user ran `/taskmaster off` | **≤ 10%** |
| | Ratings `helpful` / `too strict` | **≥ 60%** / **≤ 25%** |

**Universality reading** (sets direction rather than pass/fail): compare the `generic` arm with the `frontmatter` arm on the same skills.
- If `generic` gets **≥ 70% of `frontmatter`'s reduction in silent skips**, with a friction rate no more than **10 points higher**, the universal approach is validated.
- If it doesn't, **pivot to frontmatter-first:** enforce only skills that have frontmatter or a user-approved override, keep generic contracts advisory, and make the **frontmatter advisor (F16)** the main way into the product instead of improving extraction.
- **Advisor reading:** if suggested frontmatter comes within **10 points** of hand-written frontmatter on both friction rate and silent-skip reduction, the advisor is a sound replacement for hand-writing. If it doesn't, tighten its lint and review steps before Phase 2.

**Decision:**
- **GO** to Phase 2: all safety, at least 3 of 4 effectiveness, and all cost and experience criteria pass.
- **ITERATE:** safety passes but other criteria fall short. Run at most **2 one-week cycles**, each fixing the top 3 friction sources from `/taskmaster retro`, then re-run Gate B.
- **NO-GO or pivot:** any of the following.
  - Safety still fails after one fix cycle.
  - Effective blocks are below **40%**.
  - Friction blocks are above **40%**.
  - `off` appears in more than **25%** of live sessions.
  - Overhead is above **35%**.
  - The pivots are the advisory report card, or frontmatter-only enforcement.

## 11. Definition of done for the MVP prototype
1. Load any skill with a numbered procedure. Its steps appear in the status line with no configuration, as `enforce` or `advisory` depending on confidence.
2. Claude can't complete a step's task with no recorded work, or without meeting its `verify` spec, and can't delete a step's task. Each deny explains how to waive.
3. Claude can't end its turn with open mandatory steps more than twice. After that, the stop goes through with a visible `released: ...` note.
4. `await_user`, waivers, Esc, and `/taskmaster off` always win. Reference skills cause no blocks.
5. **Compaction test:** force `/compact` mid-run. The next turn continues on the correct step without re-planning, and the checkpoint was written before compaction.
6. **Cold-start test:** run `/clear`, or open a brand-new session on a working tree with a committed checkpoint. The session gets the briefing, and after `/taskmaster resume` it reloads the skill, rebuilds the tasks, reads `HANDOFF.md`, and finishes only the remaining or stale steps.
7. **Checkpoints are committed:** each milestone produces one `taskmaster: checkpoint ...` commit that contains only `.taskmaster/`. With a public or unknown remote, the first-commit notice (F8.1) appears once before the first of them.
8. **Metrics are complete:** every gate decision, intervention, and run end produces a schema-valid event tagged with `arm` and `contract_source`. `/taskmaster metrics export` produces a bundle the analysis script turns into the §10.2 table.
9. **Canaries work:** each tripwire in F15.1 creates an incident, and `/taskmaster retro` turns queued incidents into RCAs with evidence citations and a taxonomy category. The circuit breaker trips on 3 user friction signals and never on Claude's own waivers.
10. **The frontmatter advisor works:** asking "recommend taskmaster frontmatter for `<skill>`" produces a recommendation that passes validation, with a reason for each step and a preview of how enforcement changes.
    - Choosing **add to file** changes only the `taskmaster:` key, which the post-check confirms.
    - Choosing **override** leaves the skill file byte-for-byte unchanged.
    - The next time that skill loads, the mod uses the new contract, tagged `frontmatter-suggested` or `override-suggested`.

## Appendix: changes made after the advisor review
- Reframed the promise from "works harder" to "never silently skips, never claims done without evidence, never loses its place."
- Evidence is the mod's own ledger only; task metadata is narrative. Added G2 (no silent deletes) and `verify` specs matched on command and error flag.
- Added the `waive` and `await_user` tools; the Stop gate fails open and allows legitimate waits.
- Auditor: `$.model.complete` (Haiku, `timeoutMs`) on curated evidence, advisory first, replacing `$.model.fork`. Verifier subagents run at task completion, not at Stop.
- `skill.prompt` has no `agentId`, so the loop is attributed through the `Skill` tool's `tool.call` or `agent.spawn`.
- LLM extraction moved into the MVP, with confidence and an advisory default; a per-skill override was added.
- Multiple contracts are capped and namespaced, ownership is tracked by `agentId`, and `isAborted` freezes the gates.
- Added the go/no-go metric (share of blocks followed by real work) as the MVP exit criterion.
- Scope made honest: "universal" means any skill or command, not hooks-only or MCP-only plugins.

## Appendix: changes made after the second review (user)
- Checkpoints are committed by default, via `--only` pathspec commits with a fixed prefix. Pushing is opt-in, and required in ephemeral containers.
- F13 rewritten: the mod owns its metrics files (third-party mods can't emit to Anthropic telemetry or the OpenTelemetry collector). Events and run summaries are tagged with `arm` and `contract_source`. UX signals are explicit (sampled ratings) and implicit (interventions, optional sentiment and `reports-skip` labels). The frontmatter-vs-none question uses a paired, per-run-randomized design, plus an offline harness with trap tasks.
- F15 added: the self-improvement loop. Canary tripwires feed incidents, then an evidence-cited RCA with 5 whys (outside the user's turn, by a separate model call), then proposals, then replay, shadow, and staged validation, then human approval. A user-only circuit breaker is the single automatic adaptation.
- §10 added: Gate A (technical) after the spike, and Gate B (product) after a two-week prototype trial, with pre-registered thresholds, a universality reading, and GO / ITERATE / NO-GO rules.

## Appendix: changes made after the third review (user)
- F16 added: the frontmatter advisor. The user asks Claude to read a skill and recommend `taskmaster:` frontmatter. Claude drafts it with the mod's compiler draft, the skill's history, and the repo's real commands. It's validated, presented with reasons and an enforcement preview, then applied to that skill, a new skill, or other skills (re-fitted to each one), or saved as an override.
- Writes go through the normal `Edit` tool and a post-check that only the `taskmaster:` key changed. Installed and managed skills get an override and an upstream suggestion instead.
- Overrides moved into the project (`.taskmaster/overrides/`, committed). `contract_source` now distinguishes suggested from hand-written frontmatter. Gate B gains an advisor reading. The advisor's core moved into Phase 1, because the evaluation uses it.
