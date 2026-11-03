# Taskmaster: a universal adherence guardrail mod for Claude Code

Status: design plan, revised after advisor review (no code yet) · Target: Claude Code function-hooks mod API (early access; checked against build 2.1.317's `claude-code.d.ts`)

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
| Seed the task list from the contract | `$.tool.call({ tool: 'TaskCreate', ... })` | Hard (needs a spike to confirm Claude sees the seeded tasks) |
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
```

## 5. Features and functionality (the build list)

### F1. Contract Compiler: skill → contract (universal)
- **F1.1 Capture** `skill`, `text`, `frontmatter`, `source`, `pluginName`, `path`, and a content hash. Attribute the skill to a loop: the `Skill` tool's `tool.call.agentId`, `agent.spawn` for preloaded skills, or the main loop for a typed `/name`.
- **F1.2 Deterministic parse (no LLM):** name, description, and frontmatter (`allowed-tools`, `context: fork`, `disable-model-invocation`); numbered or ordered lists, "Step N" headings, `- [ ]` checklists; MUST/NEVER/ALWAYS lines; shell commands in code fences that look like test, lint, or build (these become candidate `verify` commands).
- **F1.3 One cheap model call (Haiku, cached):** classify the skill as `workflow`, `reference`, or `persona`; produce step ids and titles, required versus optional, user-confirmation points, candidate verify commands, and a **confidence** score. The output is JSON, validated against a schema, and cached in `$.store` by `path + hash`, so each skill version is extracted once. If the call fails, use the F1.2 result.
- **F1.4 Enforcement level of the contract:**
  - `enforce`: the skill's own frontmatter, the user's per-skill override, or high LLM confidence where the deterministic parse agrees on the steps,
  - `advisory`: anything else (Claude is reminded, gates warn instead of deny),
  - `none`: `reference` and `persona` skills, and anything in `exemptSkills`.
- **F1.5 Protocol footer**, about 10 lines appended to the skill text: the step ids (namespaced `skill:S#`), "tag each task `[S#]`", "one task in progress at a time", "call `taskmaster_waive` to skip a step, with a reason", "call `taskmaster_await_user` when you need the user's input", and "call `taskmaster_checkpoint` at milestones". The skill's own text stays primary and is never replaced.
- **F1.6 Seed the tasks** from the contract with `$.tool.call(TaskCreate)`, once the spike confirms Claude sees them. Otherwise the footer tells Claude to create them, and the Plan Gate enforces it.
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
- **F1.8 Per-skill user override (for third-party skills):** the first time a skill runs, the Pane shows the extracted contract. `/taskmaster contract edit <skill>` lets the user fix it and saves it to `$.store`. That contract is then `enforce` for that skill version.

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
- **G4: subagent stop (`classic.SubagentStop`)** does the same, scoped to the tasks that subagent owns.
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
- `$.store` holds only a mirror and an index (it's per user and per machine).
- Secrets are redacted before every write.
- `checkpointGit`: `ignore` (default; the mod adds `.taskmaster/` to `.git/info/exclude`) or `commit`. **In ephemeral containers (cloud sessions), only committed and pushed checkpoints survive, so use `commit` there.** The mod never pushes by itself.

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
- `checkpointDir` (`.taskmaster`), `checkpointGit` (`ignore` | `commit`), `checkpointEveryWrites` (10), `contextCheckpointPercent` (70), `resumePolicy` (`offer` | `auto` | `off`), `narrativeAutoDraft` (on)

### F13. Metrics: the go/no-go signal
- Log every block, waiver, release, and audit finding to `$.store`, per skill.
- **Key metric:** the *share of Stop and G1 blocks that were followed by real work*, meaning new ledger entries that satisfy the step, rather than a waiver, a release, or the user turning the mod off. If that share is low on real skills, the gates are annoying rather than helpful: stop and rethink before building more.
- An A/B harness compares the same tasks at `observe` and at `enforce`: skipped steps, premature stops, user corrections, and token/time overhead.

### F14. Quality and packaging
- `claude plugin validate` and `tsc -p` on every change. A `claude plugin test` suite for each gate, plus a compaction test and a cold-start test.
- A startup self-check logs which events fired on this build, because the API is early access and changes between releases.
- Install with `/plugin install taskmaster --marketplace <owner>/<repo>`.

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
| Secrets in checkpoints | Redaction; excluded from git by default |
| Mod bug traps the user | Stop gate fails open; `/taskmaster off` and Esc always win |
| API drift between builds | Pin the build; startup self-check; validate in CI |

## 9. Build order

**Phase 0: spike (1–2 days).** Observe-only: capture skills, record the ledger, log to the journal. **Confirm on your build:**
1. the order of `tool.check` and `tool.call`,
2. that `$.tool.call(TaskCreate)` seeds tasks Claude actually sees,
3. whether the built-in task list persists across sessions,
4. `SessionStart.source` after `/clear` and after auto-compaction,
5. that a `classic.Stop` block makes Claude continue,
6. how skills preloaded into subagents are attributed.

**Phase 1: MVP (about 1–2 weeks; ~600–900 lines including checkpoints).**
- the deterministic parse, cached Haiku extraction, and frontmatter support (F1.1–F1.7),
- the protocol footer and task seeding,
- the ledger (F2) and the three tools (F3),
- G1–G3 with the F5 safety rules,
- checkpoints and resume (F8.1–F8.6, without the fork auto-draft),
- `/taskmaster`, the status line, the summary below the answer, and F13 logging.

*Exit:* on 5–10 real skills, the share of blocks that led to real work is high, there's never more than 2 blocks per turn, and the compaction test and cold-start test both pass.

**Phase 2: hardening.** The Plan Gate, G4, Drift, the advisory audit, question detection, redirect handling, multiple skills and subagent ownership, the Pane, F8.5 auto-draft, F8.7 locking, the per-skill contract editor, and the full test suite.

**Phase 3: judgment.** A blocking audit (one bite), the verifier subagent for semantic verify specs, frontmatter constraint guards that ask the user, and the metrics view and A/B harness.

**Phase 4: ship.** Marketplace packaging, docs, and an authoring guide for the `taskmaster:` frontmatter key.

## 10. Definition of done for the MVP
1. Load any skill with a numbered procedure. Its steps appear in the status line with no configuration, as `enforce` or `advisory` depending on confidence.
2. Claude can't complete a step's task with no recorded work, or without meeting its `verify` spec, and can't delete a step's task. Each deny explains how to waive.
3. Claude can't end its turn with open mandatory steps more than twice. After that, the stop goes through with a visible `released: ...` note.
4. `await_user`, waivers, Esc, and `/taskmaster off` always win. Reference skills cause no blocks.
5. **Compaction test:** force `/compact` mid-run. The next turn continues on the correct step without re-planning, and the checkpoint was written before compaction.
6. **Cold-start test:** run `/clear`, or open a brand-new session on a working tree with a committed checkpoint. The session gets the briefing, and after `/taskmaster resume` it reloads the skill, rebuilds the tasks, reads `HANDOFF.md`, and finishes only the remaining or stale steps.
7. **Go/no-go:** the F13 metric is reported for the 5–10 test skills.

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
