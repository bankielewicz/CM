# Taskmaster: a universal adherence guardrail mod for Claude Code

Status: design plan (no code yet) · Target: Claude Code function-hooks mod API (early access, build 2.1.317 checked)

## 1. Short answer

**Yes, with one correction.** A forced task list on its own does not make Claude "work harder." It produces *checklist theater*: tasks get created to satisfy the gate and then marked done without the work. What works is a task list that is:

1. **derived from the skill**, so the tasks are the skill's own steps and not ones Claude made up,
2. **gated by deterministic hooks on things the engine can see** (tool calls, task status changes, the attempt to stop), and
3. **checked against evidence the mod recorded itself** (which tools ran and which files changed while each task was in progress), not against what Claude says it did.

Claude's failures are mostly premature stopping, skipped steps, and drifting off the workflow, not "laziness" in a human sense. The mod can't make Claude reason better. It *can* make skipping a step visible, costly, and hard to hide, and that is the realistic goal.

## 2. What the mod API actually gives us (verified in the type declarations)

| Need | Mechanism | Hard / soft |
| --- | --- | --- |
| Know a skill was loaded, read its full text, frontmatter, path, plugin | `skill.prompt` event (fires for `/name`, the Skill tool, and skills preloaded into subagents) | Hard |
| Add the contract to the skill text Claude reads | `skill.prompt` rewrite of `text` (before the row is sent, so the prompt cache stays intact) | Hard (delivery), soft (compliance) |
| Block a tool call / rewrite its input | `tool.call` → `{ deny }` | Hard |
| Know if a call is a read or a write | `tool.check` input `isReadOnly` (engine's own classification; absent = treat as write) | Hard |
| See task creation / status changes | `tool.call` on `TaskCreate`, `TaskUpdate`, `TaskList`, legacy `TodoWrite`; `classic.TaskCreated`, `classic.TaskCompleted` | Hard |
| Veto marking a task complete | `tool.call` deny on `TaskUpdate{status:'completed'}`; `classic.TaskCompleted` → `{ block }` as backstop | Hard |
| Stop Claude from ending the turn early | `classic.Stop` / `classic.SubagentStop` → `{ block: reason }` (Claude continues with the reason) | Hard |
| Inject a reminder without breaking the cache | `$.session.append({ message: { type: 'user', ... } })` | Hard (delivery) |
| Survive context compaction | `classic.PreCompact` (checkpoint before), `session.compact` → rewrite `instructions`, `classic.PostCompact` (gives `compact_summary`) → re-append contract | Hard |
| Get ahead of auto-compaction | `session.measure` → `context.percent` | Hard (trigger), soft (narrative quality) |
| Brief a brand-new session | `classic.SessionStart` (`source`: `startup` / `resume` / `clear` / `compact` / `fork`) → `additionalContext`; `session.start` | Hard (delivery) |
| Durable checkpoint files | `$.fs.read` / `write` / `list` / `exists` / `stat` (whole-file writes, no append), `$.process.run` for `git` anchors | Hard |
| A tool Claude calls to save its narrative | `$.tool.register` (`mcp__taskmaster__checkpoint`, `isDeferred: false`) | Hard (validation), soft (content) |
| Independent judgment | `$.model.classify` (cheap label), `$.model.complete`, `$.model.fork` (question over the transcript, served from the prompt cache), `$.agent.spawn` (read-only auditor subagent) | Soft |
| Session / cross-session memory | `$.state` (survives hot reload), `$.store` (across sessions), `$.fs` (log files) | Hard |
| UI | `$.ui.open` Pane, `AbovePrompt` band, `$.ui.status`, `$.ui.toast`, `$.command.register` | Hard |

**Not available or not reliable:** changing the system prompt mid-thread (busts the cache and loses thinking; avoid), knowing *semantically* whether code is correct, and stopping a determined model from writing fake evidence text. The mitigation for that last one is cross-checking evidence against the mod's own ledger.

## 3. Design principles

1. **Universal by default, stricter by opt-in.** Works with any skill and no configuration. A skill author *may* add a `taskmaster:` frontmatter block for exact steps and evidence; the mod never requires one.
2. **Deterministic first, LLM second.** Every hard gate runs on facts the hooks observed. LLM judgment is used only for (a) extracting steps from prose, cached once per skill version, and (b) an optional audit at checkpoints. It is never the only thing standing between Claude and a block.
3. **Every block tells Claude exactly what to do next.** A deny message names the missing step, task, or evidence. No vague "follow the skill."
4. **Every gate has a loop breaker and a human override.** No gate can trap a session. Overrides are logged.
5. **Proportional.** Purely informational skills (references, style guides) get observe-only treatment and no gates.
6. **Fail closed for guards, fail open for helpers.** Gates use `.catch` to deny on internal error (with an override path). The UI, logging, and auditor fail open.

## 4. Architecture

```
skill.prompt ──► Contract Compiler ──► Contract (steps, rules, evidence reqs, strictness)
                       │                         │
                       ▼                         ▼
              text rewrite: append       $.state: active contracts (stack)
              "Taskmaster contract"              │
                                                 ▼
TaskCreate/TaskUpdate/TodoWrite ──► Task Ledger ◄── tool.call observer (every call, per agentId)
                                         │
     ┌───────────────┬───────────────────┼─────────────────┬──────────────────┐
     ▼               ▼                   ▼                 ▼                  ▼
 Plan Gate      Completion Gate      Stop Gate        Drift Monitor     Checkpointer
 (tool.call)    (TaskUpdate /        (classic.Stop,   (tool.call)       (task transitions, PreCompact,
                 TaskCompleted)       SubagentStop,                      Stop, session.end, context %)
                                      freshness)                               │
                                         │                                     ▼
                                         ▼                       .taskmaster/runs/<id>/ on disk
                                 Auditor (optional, budgeted)    checkpoint.json · HANDOFF.md · journal
                                         │                                     │
                                         ▼                                     ▼
                       Pane / band / status · /taskmaster commands   Resumer (SessionStart: compact /
                                                                     startup / clear → briefing + gates)
```

## 5. Features and functionality (the build list)

### F1. Contract Compiler: skill → contract (universal)
- **F1.1 Capture.** Hook `skill.prompt` and record `skill`, `text`, `frontmatter`, `source`, `pluginName`, `path`, and a content hash.
- **F1.2 Classify the skill** as `workflow` (has an ordered procedure) or `reference` (knowledge only). Order of precedence: frontmatter `taskmaster.mode`, then heuristics (numbered or ordered lists, "Step N" headings, checklists, imperative verbs, MUST/NEVER/ALWAYS), then `$.model.classify` when the heuristics can't decide. `reference` skills are observe-only.
- **F1.3 Extract steps** into `{ id, title, required: bool, evidence: [kinds], order }`.
  - Tier A: the explicit frontmatter `taskmaster.steps`. Exact, author-controlled.
  - Tier B: deterministic markdown parse (ordered lists, `## Step`, `- [ ]` checklists).
  - Tier C: a `$.model.complete` extraction prompt with JSON output, validated against a schema.
  - Cache the result in `$.store` keyed by `skill + hash`, so each skill version is extracted once.
- **F1.4 Extract rules.** Collect MUST/NEVER/ALWAYS sentences into a rule list. Rules are surfaced to Claude and shown to the auditor; they are not hard-enforced, because arbitrary prose rules can't be checked deterministically.
- **F1.5 Inject the contract.** Rewrite the skill `text` to append a short, fixed "Taskmaster contract" block: the extracted steps with ids, plus the protocol (create one task per step with `metadata.step = <id>`, one `in_progress` at a time, close each task with evidence, waive a step only by asking the user). The block is appended to the skill's own text, never replacing it, so the skill's workflow stays primary.
- **F1.6 Optional frontmatter schema** that skill authors can opt into:
  ```yaml
  taskmaster:
    mode: workflow | reference | off
    strictness: observe | guide | enforce | strict
    steps:
      - id: tests
        title: Run the test suite
        evidence: [command]      # command | file_change | tool:<name> | note
        required: true
    stop_requires: all_required  # all_required | none
  ```

### F2. Task Ledger: the single source of truth
- **F2.1** Observe `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, and legacy `TodoWrite`, per `agentId`. Store each task's id, subject, status history, `metadata.step`, owner, and timestamps in `$.state`.
- **F2.2 Work attribution.** Every `tool.call` made while a task is `in_progress` is recorded against that task: tool, `tool_use_id`, read or write, files touched, the Bash command and whether it errored.
- **F2.3 Coverage map.** Contract step id → task(s) → status. A step is *covered* once a task references it, and *satisfied* once that task completed with valid evidence.
- **F2.4 Persistence.** The ledger lives in `$.state` and is written to the on-disk checkpoint (F8), so it never depends on the context window.

### F3. Plan Gate: no plan, no writes
- **F3.1** While a `workflow` contract is active at `enforce` or above, deny write calls (`Edit`, `Write`, `NotebookEdit`, non-read-only `Bash`, non-read-only MCP tools) until every required step is covered by a task.
- **F3.2** Read-only calls are always allowed, so Claude can explore before planning. Classification comes from `tool.check`'s `isReadOnly`; a missing value counts as a write.
- **F3.3** The deny message lists the uncovered step ids and the exact `TaskCreate` shape to use.
- **F3.4** Exempt the mod's own tools, task tools, `AskUserQuestion`, and anything in a user-configured allowlist.

### F4. Completion Gate: no evidence, no "done"
- **F4.1** Intercept `TaskUpdate{status:'completed'}`. Require `metadata.evidence` (a short summary plus references).
- **F4.2 Deterministic cross-check against the ledger:**
  - the task saw at least one non-trivial tool call while `in_progress`; otherwise "completed with no recorded work",
  - every evidence kind the step requires was actually observed: `command` means a Bash call ran while the task was in progress (and for test-like steps, did not error), `file_change` means an `Edit`/`Write` happened, and `tool:<name>` means that tool ran,
  - any file paths cited as evidence appear in the ledger.
- **F4.3** Backstop via `classic.TaskCompleted` → `{ block }` for completions that route around `TaskUpdate` (teammates, subagents).
- **F4.4** Deny messages say exactly what's missing ("step `tests` requires a command run; none was recorded while task #4 was in progress").

### F5. Stop Gate: no quitting with open work
- **F5.1** On `classic.Stop`, if an active `workflow` contract has required steps that are uncovered, pending, or in progress, return `{ block }` naming them.
- **F5.2 Loop breaker (mandatory):**
  - at most N blocks per user turn (default 2),
  - no-progress detection: if the ledger hasn't changed since the last block, allow the stop and flag the contract `abandoned`,
  - honor `stop_hook_active`, user interrupts (`turn.complete` with `reason: 'aborted'`), and `background_tasks` (paused, not done).
- **F5.3 Legitimate exits:** a step is waived by the user (F9), or Claude asks the user a question with `AskUserQuestion` (waiting on a human is not quitting).
- **F5.4** The same logic on `classic.SubagentStop` for subagents that own tasks.

### F6. Drift Monitor: stay on the workflow
- **F6.1** Write calls made while no task is `in_progress`: warn at `guide`, deny at `strict`.
- **F6.2** More than one task `in_progress`: warn.
- **F6.3** Steps done out of the contract's order, when the skill declares an order: warn, never block. Order in prose is often advisory.
- **F6.4** Warnings go to Claude as a hidden user row (`$.session.append`), batched at most once per turn to avoid noise.

### F7. Auditor: optional, budgeted, soft judgment
- **F7.1 Modes:** `off` · `final` (once, when all steps are satisfied and Claude tries to stop) · `critical` (steps marked critical) · `sampled`.
- **F7.2 Mechanism:** `$.model.fork` asks one question over the transcript, served from the prompt cache, so it's cheap. For heavy audits, `$.agent.spawn` runs a registered read-only auditor subagent. The input is the contract, rules, ledger, and evidence; the output is `PASS` or `FAIL` plus specific findings (JSON).
- **F7.3** `FAIL` → one Stop block carrying the findings. After that, the result is reported to the user and never blocks again (the auditor gets one bite).
- **F7.4 Budgets:** maximum audits per session, maximum tokens; cost is tracked from `usage` and shown in the pane.

### F8. Checkpoints that survive compaction and a cold start (MVP-critical)

The rule: **the context window is not storage.** Anything the next session needs must already be on disk before it's needed, so the mod writes checkpoints itself, on events it observes. It never depends on Claude remembering to save. Claude supplies only what the mod can't know (intent, decisions, next action), and gates enforce that too.

**F8.1 Checkpoint store (on disk, in the project):**
```
.taskmaster/
  active.json                 # pointer: open run ids, owning session, lock heartbeat
  runs/<run-id>/
    checkpoint.json           # machine state (schema-versioned, see F8.2)
    HANDOFF.md                # narrative briefing a cold session reads first
    journal.jsonl             # event log (gates, transitions, tool calls)
```
- Lives in the working tree because that is what a new session, a new machine, or a new cloud container sees. `$.store` (per user, per machine) holds only a mirror and an index.
- `$.fs` has `read`/`write`/`list`/`exists`/`stat` but no append or rename, so each file is rewritten whole, and the journal rolls over into numbered chunks.
- Secret redaction (known key and token patterns) runs before every write, because commands and paths can hold credentials.
- `checkpointGit` option: `ignore` (default: add `.taskmaster/` to `.git/info/exclude`) or `commit`. **In ephemeral environments, such as a Claude Code cloud container, only committed and pushed checkpoints survive**, so this must be `commit` there. The mod never pushes on its own; the push stays the user's or the skill's call.

**F8.2 What a checkpoint holds**, enough to resume with zero transcript:
- the run id, schema version, the session ids that touched it, and timestamps,
- **the goal**: the user's original request text (captured at `prompt.submit`/`turn.start`) and any later redirects,
- **the skill**: name, `path`, `pluginName`, content hash, *and the full extracted contract embedded* (steps, rules, evidence requirements), so the run can be resumed even if the skill file changed or is missing,
- **the ledger**: every task with its step id, status history, evidence, and handoff note; waivers; strictness,
- **the work trail**: files written (with a content hash at write time), commands run (with error flag), and the last gate events,
- **a workspace anchor**: git branch, `HEAD`, and a hash of the dirty-file list (via `$.process.run git ...`), used for staleness checks on resume,
- **the narrative**: summary so far, decisions made and why, open questions, and the next action (from F8.4).

**F8.3 When the mod checkpoints** (deterministic, throttled to at most one write per few seconds):
1. after every task transition (create, `in_progress`, `completed`, `deleted`), once `next(e)` resolves,
2. every N write calls (default 10) while a run is active,
3. at `classic.PreCompact` (manual or auto), before history is summarized,
4. at every `classic.Stop`, whether or not it's blocked, keeping `last_assistant_message`,
5. at `session.end` (exit, `/clear`, logout): the run is marked `paused` unless every required step is satisfied,
6. when context fill crosses the threshold (`session.measure` → `context.percent`, default 70%; see F8.5).

**F8.4 What Claude must write (enforced):**
- **Per step:** the Completion Gate (F4) also requires `metadata.handoff`, one line saying what changed and what's next. It goes into `HANDOFF.md`.
- **Narrative checkpoint tool:** the mod registers `mcp__taskmaster__checkpoint` (`$.tool.register`, `isDeferred: false`) with `{ summary, decisions[], open_questions[], next_action, current_step }`. The mod validates it (fields non-empty, step ids exist) and writes `HANDOFF.md`.
- **Freshness gate:** while required steps are open, the Stop Gate also blocks if the narrative is *stale*, meaning no `checkpoint` call since the last write call. The block message asks for exactly one `checkpoint` call. That makes "leave a handoff before you stop" deterministic.

**F8.5 Getting ahead of compaction:**
- When `session.measure` reports context fill ≥ threshold, append a hidden user row asking Claude to call `checkpoint` now. The narrative is then written by Claude, while it still has full context.
- At `classic.PreCompact`, Claude can't act (no model turn happens there). If the narrative is stale, the mod drafts one with `$.model.fork` (one question over the transcript as last sent, served from the prompt cache), marked `auto-drafted`. If the fork fails or the budget is spent, it falls back to the deterministic sections only.
- `session.compact`: append to `instructions` so the summary keeps the run id, current step, and the `HANDOFF.md` path.
- `classic.PostCompact` and `classic.SessionStart{source:'compact'}`: re-append a compact "contract + ledger + next action" user row so Claude continues on the right step.

**F8.6 Cold-start resume** (`classic.SessionStart` with `source` `startup` or `clear`, or `session.start`):
- Read `.taskmaster/active.json`. If an unfinished run exists, return `additionalContext` with a short resume briefing (goal, skill, steps ✓/●/○, next action, the `HANDOFF.md` path) and show a band entry: `Unfinished run: <skill> 4/7 · /taskmaster resume`.
- **Offered, not forced** (`resumePolicy`: `offer` (default) | `auto` | `off`). A cold session may be about something else. The run turns active when the user runs `/taskmaster resume` or says to continue; `/taskmaster abandon` closes it.
- On resume, the Plan Gate requires, before any write:
  1. **reload the skill** with the Skill tool. The mod compares the skill's hash with the checkpoint's; if the steps changed, it shows the difference and asks the user which contract to keep,
  2. **rebuild the task list** from the checkpoint. The built-in task list isn't relied on to persist across sessions, so the mod's checkpoint is the source of truth. The mod recreates tasks itself with `$.tool.call({ tool: 'TaskCreate', ... })` if the spike confirms that works; otherwise the deny message gives Claude the exact `TaskCreate` calls,
  3. **read `HANDOFF.md`**: the gate is satisfied once the mod sees a `Read` of that path.
- **Staleness check:** compare the git anchor and the hashes of the files the run wrote. Where the workspace changed since the checkpoint, the briefing says so, and steps whose evidence files changed drop to `needs re-verify`. They must be re-satisfied (for example, by re-running tests) before the final Stop.
- `source: 'resume'` (the same transcript reopened): only a light reminder, since the history is already there.

**F8.7 Concurrency and integrity:**
- `active.json` holds a lock: the owning session id and a heartbeat, refreshed with `$.clock.every`. A second live session gets a read-only briefing and can take over only with `/taskmaster resume --force`.
- Every file carries a schema version. An unreadable or corrupt checkpoint is reported, never silently replaced: the last good copy is kept as `checkpoint.prev.json`.
- `$.state` keeps the in-memory ledger across hot reloads; on load the mod reconciles it with the disk checkpoint, and the newer timestamp wins.

### F9. Human control and overrides
- **F9.1 Slash commands:** `/taskmaster` (status), `/taskmaster off|observe|guide|enforce|strict`, `/taskmaster waive <step> <reason>`, `/taskmaster checkpoint` (write now), `/taskmaster resume [run] [--force]`, `/taskmaster abandon [run]`, `/taskmaster runs` (list open and paused runs), `/taskmaster reset`, `/taskmaster report`, `/taskmaster exempt <skill>`.
- **F9.2** Waivers are logged with the reason and shown in the report. Claude can *request* a waiver with `AskUserQuestion`; only the user grants one.
- **F9.3 Redirect handling.** When the user submits a new prompt while a contract is active (`prompt.submit`), add a hidden note telling Claude to reconcile tasks: mark obsolete ones `deleted` with a reason rather than silently abandoning them. Do not block the user.

### F10. Multiple skills, subagents, teammates
- **F10.1 Contract stack.** A newly loaded skill becomes active. Earlier contracts must be completed or explicitly suspended; the Stop Gate considers every unsuspended contract.
- **F10.2 Nested skills** (a skill that invokes another skill) get child contracts linked to the parent step.
- **F10.3 Subagents.** `skill.prompt` fires for skills preloaded into subagents, and `tool.call` carries `agentId`, so each loop gets its own contract and ledger scope. Subagent task updates land in the session's task list.

### F11. Visibility
- **F11.1 Pane** (sidebar): contract steps with ✓ satisfied / ● in progress / ○ pending / ⊘ waived, gate events, audit verdicts, cost.
- **F11.2 Band above the prompt:** `skill-x · 3/7 steps · #4 in progress · next gate: tests`.
- **F11.3** A status line entry and a toast on each block.
- **F11.4 End-of-session report** (`/taskmaster report` and on `session.end`): steps satisfied / waived / abandoned, blocks issued, overrides, auditor results.

### F12. Configuration (`userConfig` in `plugin.json`)
- `strictness` (picker): `observe` | `guide` | `enforce` (default) | `strict`
- `maxStopBlocks` (default 2), `auditor` (`off` | `final` | `critical` | `sampled`), `auditorModel`, `auditBudgetTokens`
- `exemptSkills` (list), `writeToolAllowlist` (list)
- `checkpointDir` (default `.taskmaster`), `checkpointGit` (`ignore` | `commit`), `checkpointEveryWrites` (default 10), `contextCheckpointPercent` (default 70), `resumePolicy` (`offer` | `auto` | `off`), `narrativeAutoDraft` (on/off: the `$.model.fork` fallback at PreCompact)

### F13. Metrics and tuning
- `$.store` keeps per-skill counters (blocks, false-positive overrides, waivers, audit fails, average overhead). This tells you which gates help and which only annoy.
- An A/B harness: run the same tasks with the mod at `observe` and at `enforce`, and compare skipped steps, premature stops, user corrections, and token/time overhead.

### F14. Quality and packaging
- `claude plugin validate` and `tsc -p` on every change; `claude plugin test` suites for each gate (seed the ledger, raise `tool.call` / `classic.Stop`, assert deny or allow).
- Version-pin to the API build. The API is early access and moves between releases, so add a startup self-check that logs which events fired.
- Ship through a `.claude-plugin/marketplace.json` so it installs with `/plugin install taskmaster --marketplace <owner>/<repo>`.

## 6. Strictness levels (what each one does)

| Level | Contract injected | Plan Gate | Completion Gate | Stop Gate | Drift | Checkpoints | Auditor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| observe | no | log only | log only | log only | log only | mod-written only | off |
| guide | yes | warn | warn | 1 block | warn | mod-written + nudge for narrative | off |
| enforce (default) | yes | deny | deny | ≤2 blocks | warn | + freshness gate on Stop, resume gates | `final` if enabled |
| strict | yes | deny | deny + evidence kinds | ≤3 blocks | deny writes without an in-progress task | + re-verify stale steps on resume | `critical` |

At every level, including `observe`, the mod writes checkpoints. Saving state costs nothing and doesn't depend on Claude.

## 7. Explicitly out of scope (aspirational, so not promised)
- Guaranteeing the *quality* or *correctness* of the work. The mod enforces process and observable evidence, not truth.
- Making Claude "try harder" in its reasoning. Gates change behavior at decision points; they don't raise capability.
- Perfect understanding of arbitrary prose skills. Tier C extraction is best effort, so the skill author's frontmatter is the reliable path.
- Preventing all gaming. Fabricated evidence text is caught only where it contradicts the ledger.
- Enforcement where hooks don't run: settings hooks disabled, an organization policy plugin above it, or work done inside an MCP server's own process.
- Rewriting a thread's system prompt mid-session.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Infinite Stop-block loops | Per-turn cap, no-progress detection, `stop_hook_active`, user interrupt honored |
| False positives frustrate the user | Default `enforce` gates only on *required* steps; one-command overrides; per-skill exemption; metrics to tune |
| Checklist theater | Evidence checked against the mod's own ledger; tasks tied to contract step ids, not free text |
| Token/latency overhead | Deterministic gates are free; extraction cached per skill hash; auditor off by default and budgeted when on |
| Contract lost on compaction | Checkpoint written *before* compaction (PreCompact + context-% nudge), `session.compact` instructions, re-injection on `PostCompact` / `SessionStart{compact}` |
| Work lost in a cold session or a new container | On-disk checkpoint + `HANDOFF.md` in the working tree; `checkpointGit: commit` where the container is ephemeral; resume briefing + resume gates |
| Stale checkpoint misleads the resumed session | Git anchor + file hashes; changed evidence drops steps to `needs re-verify` |
| Two sessions fight over one run | Lock with heartbeat in `active.json`; takeover only with `--force` |
| Secrets written to checkpoint files | Redaction before every write; `.taskmaster/` excluded from git by default |
| Narrative checkpoint is empty boilerplate | Schema validation; freshness tied to write activity; the auditor (if on) reviews `HANDOFF.md` at the final stop |
| Informational skills get gated | Classified `reference` → observe-only |
| API drift between Claude Code builds | Pin the build, startup self-check, `claude plugin validate` in CI |
| Mod bug blocks all work | Gates fail closed *with* an override; `/taskmaster off` always works; a crash in a non-gate feature fails open |

## 9. Build order

**Phase 0: spike (1–2 days).** Observe-only mod: `skill.prompt` capture, task-tool observation, Pane, JSONL log. *Exit:* on your build, confirm which events fire, in what order (`tool.check` vs `tool.call`), and for which loops (main vs subagent); whether `$.tool.call` can create tasks; whether the built-in task list persists across sessions; what `SessionStart.source` reads after `/clear` and after auto-compaction.

**Phase 1: MVP (about 1–2 weeks).** F1.1–F1.3 (Tiers A and B only), F1.5, F2, F4 (deterministic), F5 with the loop breaker, **F8.1–F8.6 checkpoints and resume** (without the `$.model.fork` auto-draft), F9.1–F9.2, the band and status line. *Exit:* a workflow skill run at `enforce` can't end with uncovered required steps or evidence-free completions, never loops more than 2 blocks, and **a fresh session started after `/clear`, or on a new clone of a committed checkpoint, resumes at the right step with no transcript.**

**Phase 2: hardening.** F3 Plan Gate, F6 Drift, F8.5 auto-draft, F8.7 locking, F10 multi-skill and subagents, F12 config, tests for each gate, including a compaction test and a cold-start test.

**Phase 3: judgment.** F1.3 Tier C LLM extraction (cached), F1.4 rules, F7 Auditor with budgets.

**Phase 4: measure and ship.** F11.4 report, F13 metrics and A/B harness, F14 marketplace packaging.

## 10. Definition of done for the MVP
1. Load any skill with a numbered procedure. The mod shows its steps in the band with no configuration.
2. Claude cannot mark a step's task `completed` with zero recorded work, or without the required evidence kind.
3. Claude cannot end its turn with an uncovered or open required step more than `maxStopBlocks` times; after that, the stop is allowed and the contract is reported as abandoned.
4. `/taskmaster waive`, `/taskmaster off`, and the user's Esc interrupt always win.
5. Reference skills cause zero blocks.
6. **Compaction test:** force `/compact` mid-run. The next turn continues on the correct step without re-planning, and `checkpoint.json` was written before the compaction.
7. **Cold-start test:** `/clear` (or open a brand-new session on the same working tree) mid-run. The session gets the resume briefing, and after `/taskmaster resume` it rebuilds the task list, re-reads `HANDOFF.md`, and finishes the remaining steps. Steps already satisfied aren't redone unless their evidence went stale.
