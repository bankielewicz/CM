# Event-order probe

This checks the order of events that P1.1's skill attribution relies on. Run it after a Claude Code update, before trusting `agent-preload` on the new build. A [second check](#second-check-clear), on the same probe, covers what the captures do across a `/clear`.

**Last passed:** 2.1.318, on 2026-11-04. Update this line and [Results](#results) after each run.

## Why it exists

`skill.prompt` has no `agentId`, so a preloaded skill goes to an agent only while that agent's preload window is open. The window ends at the agent's first `turn.step` (`taskmaster/hooks/register.tsx`, plan §9). That's right only while the preload comes first.

Nothing else checks this:
- The startup self-check shows that `turn.step` fired, not when.
- Kit tests raise events in the order a test writes them.

If a build sends the first model request before the preload, preloaded skills stay unattributed and unenforced. Nothing fails, and the self-check record looks healthy.

## Where to build it

**Build it outside the repo, or in a gitignored folder, and never commit it.** `scripts/find-mods.mjs` lists untracked folders as well as tracked ones. So a probe under the working tree is measured as a mod, and it can trip the Stop hook. It skips gitignored folders, including anything in `.git/info/exclude`.

These steps build it in `~/tm-event-order-probe`, with `mod/` for the probe mod and `project/` as the folder to run from. Change the probe's skills through `/plugin-dev:skill-development`, the owner's rule for skill files.

## The files

**`mod/.claude-plugin/plugin.json`**

```json
{ "name": "tmprobe", "version": "0.1.0", "description": "Throwaway probe of the event order P1.1 relies on." }
```

**`mod/hooks/hooks.json`**

```json
{ "modules": ["./register.tsx"] }
```

**`mod/hooks/register.tsx`**

```tsx
// Logs the events P1.1's attribution relies on to probe.jsonl in the session's
// root. seq is taken on entry, so it's the order the module saw. Every hook passes
// its event on unchanged.

import type { Register } from 'claude-code'

type Capture = { skill: string; loop: unknown; via: string }

export const register: Register = on => {
  let seq = 0
  const lines: string[] = []
  const firsts = new Set<string>()
  let write: ((text: string) => Promise<void>) | undefined
  let chain: Promise<unknown> = Promise.resolve()

  const note = (event: string, data: Record<string, unknown> = {}): void => {
    seq += 1
    lines.push(JSON.stringify({ seq, t: Date.now(), event, ...data }))
    chain = chain
      .then(async () => {
        if (write) await write(`${lines.join('\n')}\n`)
      })
      .catch(() => undefined)
  }
  const noteFirst = (key: string, event: string, data: Record<string, unknown>): void => {
    if (firsts.has(key)) return
    firsts.add(key)
    note(event, data)
  }

  // What taskmaster.skills holds, as the skill names, or null when it's unset.
  const names = (state: unknown): string[] | null =>
    (state as { value?: { value?: Capture[] } }).value?.value?.map(capture => capture.skill) ?? null

  on('session.start', async ($, e, next) => {
    const root = (await $.session.root()).replace(/\/+$/, '')
    write = text => $.fs.write(`${root}/probe.jsonl`, text)
    note('session.start', { version: (await $.session.version()).version })
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    note('session.end', { reason: e.reason, sessionId: e.sessionId, id: await $.session.id(), captures: names(await $.state.get({ plugin: 'taskmaster', key: 'skills' } as never)) })
    await chain
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    note('classic.SessionStart', { source: e.source, id: await $.session.id(), captures: names(await $.state.get({ plugin: 'taskmaster', key: 'skills' } as never)) })
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    note('prompt.submit', { origin: e.origin.kind, command: e.command?.name ?? null, id: await $.session.id(), captures: names(await $.state.get({ plugin: 'taskmaster', key: 'skills' } as never)) })
    return next(e)
  })
  on('agent.spawn', async (_, e, next) => {
    const answer = await next(e)
    note('agent.spawn:answered', { agentId: answer.agentId ?? null })
    return answer
  })
  on('turn.start', (_, e, next) => {
    if (e.agentId) note('turn.start', { agentId: e.agentId })
    return next(e)
  })
  on('skill.prompt', (_, e, next) => {
    note('skill.prompt', { skill: e.skill })
    return next(e)
  })
  on('turn.step', async function* (_, e, next) {
    if (e.agentId) noteFirst(`step:${e.agentId}`, 'turn.step:first', { agentId: e.agentId })
    return yield* next(e)
  })
  on('tool.call', (_, e, next) => {
    if (e.agentId) noteFirst(`tool:${e.agentId}`, 'tool.call:first', { agentId: e.agentId, tool: e.tool })
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    if (!e.agentId) {
      const state = (await $.state.get({ plugin: 'taskmaster', key: 'skills' } as never)) as { value?: { value?: Capture[] } }
      const captures = (state.value?.value ?? []).map(({ skill, loop, via }) => ({ skill, loop, via }))
      note('taskmaster.skills', { captures })
    }
    return answer
  })
}
```

**`project/README.txt`**

```text
alpha line of the probe README
```

**`project/.claude/skills/notes/SKILL.md`**

```markdown
---
name: notes
description: This skill should be used when the user asks to "write a note" or "take notes". Probe skill with plain numbered steps.
---

1. Write the note.
2. Report that the note is written.
```

**`project/.claude/skills/forked/SKILL.md`**

```markdown
---
name: forked
description: This skill should be used when the user asks to "run the forked probe". Probe skill that runs in a forked context.
context: fork
---

1. Read README.txt.
2. Reply with its first word.
```

**`project/.claude/agents/notes-writer.md`**

```markdown
---
name: notes-writer
description: Probe agent with one preloaded skill.
model: haiku
tools: Read
skills:
  - notes
---

Read the file the task names, then reply with its first word.
```

## Run it

Run each prompt below from `project/`, and read the log after each one. Point the first `--plugin-dir` at this repo's `taskmaster`. From inside a Claude Code session, put `env -u CLAUDECODE` in front of `claude`.

```sh
cd ~/tm-event-order-probe/project
claude -p "<prompt>" --model haiku --allowedTools "Agent,Skill,Read" \
  --plugin-dir /path/to/CM/taskmaster --plugin-dir ~/tm-event-order-probe/mod
cat probe.jsonl
```

| Run | Prompt | Expected capture in `taskmaster.skills` |
| --- | --- | --- |
| Preload, foreground | `Use the Agent tool with subagent_type notes-writer, in the foreground, with the prompt: Read README.txt. Then reply with the single word done.` | `notes`, the agent's id, `agent-preload` |
| Preload, background | `Use the Agent tool with subagent_type notes-writer and run_in_background true, with the prompt: Read README.txt. Wait for its result, then reply with the single word done.` | `notes`, the agent's id, `agent-preload` |
| Typed | `/notes` | `notes`, `main`, `typed` |
| `Skill` tool | `Use the Skill tool to load the skill named notes. Then reply with the single word done.` | `notes`, `main`, `skill-tool` |
| Forked | `Use the Skill tool to load the skill named forked. Then reply with the single word done.` | `forked`, `unknown`, `unattributed`. The log's `tool.call:first` names an agent nothing spawned |

A model sometimes loads a skill again on its own, so an extra capture after the expected one is fine.

## Expected result

**It passes when, in both preload runs, `skill.prompt` comes before `turn.step:first`**, and every run's capture matches the table. In a preload run the events come in this order, with the times seen on 2.1.318 relative to `agent.spawn:answered`:

| Event | Time |
| --- | --- |
| `turn.start`, with the agent's id | 1–3 ms before |
| `agent.spawn:answered` | 0 |
| `skill.prompt` | +10–52 ms |
| `turn.step:first` | +20–51 ms |
| `tool.call:first` | +2.8–9.5 s |

In a background run, `taskmaster.skills` can come before `tool.call:first`, because the main loop's turn ends first.

**A capture in `taskmaster.skills` also shows that the capture landed.** The save runs from a closure on `skill.prompt`'s `$` after that hook has answered, and a failed save leaves only a debug line. So a build that stopped honouring `$` there would show up here as a missing capture, with no failed hook.

## If it fails

**`turn.step:first` before `skill.prompt`, on any run:** the window now closes too early, so preloads stay unattributed. Tell the owner before changing anything. The fix reopens a decision the owner made: without this close the window is seconds wide (the first tool call), and the plan's D2 options for a wide window are a known wrong-loop path or main-loop skills unattributed for seconds after each spawn. See `docs/taskmaster-plan.md` §9 and P1.1's status in `docs/phase-1-tasks.md`.

**A capture that differs from the table:** attribution has moved for that path. Compare the log's order with `taskmaster/hooks/skills.ts`'s header.

**No `taskmaster.skills` line:** the main loop's turn didn't complete, or the mod didn't load. Rerun with `--debug-file probe.log`, and look for `taskmaster` or `tmprobe` lines saying a hook failed or was skipped.

**A `taskmaster.skills` line with no capture:** the save didn't land. Rerun with `--debug-file probe.log` and look for `taskmaster: couldn't record skill`.

## Second check: `/clear`

**Last passed:** 2.1.318, on 2026-11-04. Update this line and [Results](#results) after each run.

A `/clear` ends the conversation and the process goes on under a new session id: `register()` doesn't run again, and no `session.start` fires. So the mod starts its captures over at `session.end` (`taskmaster/hooks/register.tsx`). That's right only while `session.end` comes before the next `skill.prompt`. Kit tests raise events in the order a test writes them, so nothing else checks this.

`claude -p` has no `/clear`, so this runs in an interactive terminal, with the same files. The first run in the folder asks you to trust it.

```sh
cd ~/tm-event-order-probe/project
claude --model haiku --allowedTools "Agent,Skill,Read" \
  --plugin-dir /path/to/CM/taskmaster --plugin-dir ~/tm-event-order-probe/mod
```

Enter these in turn, each after the last has answered, then read `probe.jsonl`:

```text
/notes
/clear
/forked
/exit
```

**It passes when the log shows these, in this order:**

| Line | Expected |
| --- | --- |
| `taskmaster.skills` | `notes`, `main`, `typed` |
| `session.end` | `reason: "clear"`, with `sessionId` and `id` the first session's |
| `classic.SessionStart` | `source: "clear"`, a new `id`, and `captures: null`, because `$.state` has emptied |
| `skill.prompt` | `forked` |
| the last `taskmaster.skills` | only `forked`, `unknown`, `unattributed`. No `notes` |

The first `session.end` line's own `captures` can be the old list or `[]`, depending on whether the reset has run yet. Exiting adds a last `session.end` with `reason: "prompt_input_exit"`.

**`session.end` missing, or after the next `skill.prompt`:** the reset no longer comes first, so old captures can reach the new conversation. Tell the owner before changing anything.

**`notes` in the last `taskmaster.skills`:** the reset isn't working. Before the fix, 2.1.318 logged `notes` and `forked` here, the next save having written the old capture back.

**`captures` not `null` at `classic.SessionStart`:** `$.state` no longer empties on `/clear`. The mod copes, because its reset also writes an empty list, so `[]` still passes. Record it in plan §9.

## Results

Add a line after each run, and record what's new in plan §9.

| Build | Date | Runs | Result |
| --- | --- | --- | --- |
| 2.1.318 | 2026-11-04 | `/clear`, in a terminal driven through tmux, before and after P1.1's reset | Before: `notes` and `forked` held after `/clear`, the defect this check was added for. After: only `forked`. Passed |
| 2.1.318 | 2026-11-04 | 7 preload runs (4 foreground, 3 background), by an earlier version of this probe; then the five runs above, from this document | Passed |
