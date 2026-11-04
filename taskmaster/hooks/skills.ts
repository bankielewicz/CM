// P1.1: capture each skill as it loads, and work out which loop it belongs to
// (plan F1.1). skill.prompt carries no agentId, so the loop comes from what is
// open when it fires. These orders were seen live on 2.1.317:
// - a Skill tool call: skill.prompt fires while the call is open, in the loop
//   that made the call (main, or the subagent named by its agentId);
// - a typed /name: skill.prompt fires inside prompt.submit, before the main
//   turn starts, and prompt.submit carries the command's name;
// - a skill preloaded into a subagent: skill.prompt fires after agent.spawn
//   has answered with the new agent's id, before that agent's first tool call.
// When none of these fits, or two loops could claim the skill, it stays
// unattributed: a wrong loop would hold the wrong agent to its steps.

import type { SkillCapture, SkillLoop, SkillVia } from '../types'

/** How many captures `$.state` keeps, newest last. */
export const MAX_SKILLS = 20

/** SHA-256 of the text, as hex. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The same skill: the same name, or a plugin-qualified name (`acme:notes`) against the bare one. */
export function sameSkill(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`)
}

/** The list with `capture` added last, cut to the newest MAX_SKILLS. */
export function keepLatest(list: readonly SkillCapture[], capture: SkillCapture): SkillCapture[] {
  return [...list, capture].slice(-MAX_SKILLS)
}

export type Attribution = { loop: SkillLoop; via: SkillVia }

const MAIN: SkillLoop = { kind: 'main' }
const UNATTRIBUTED: Attribution = { loop: { kind: 'unknown' }, via: 'unattributed' }

const loopOf = (agentId: string | undefined): SkillLoop => (agentId ? { kind: 'agent', agentId } : MAIN)
const loopKey = (loop: SkillLoop): string => (loop.kind === 'agent' ? `agent:${loop.agentId}` : loop.kind)

/** What is open right now that could claim a skill as it loads. */
export class SkillTracker {
  private readonly skillCalls = new Map<string, { skill: string; loop: SkillLoop }>()
  private readonly typed = new Map<number, string>()
  private typedCount = 0
  // Spawned agents that haven't acted yet: a preloaded skill loads in this window.
  private readonly starting = new Set<string>()

  skillCallOpened(id: string, skill: string, agentId: string | undefined): void {
    this.skillCalls.set(id, { skill, loop: loopOf(agentId) })
  }

  skillCallClosed(id: string): void {
    this.skillCalls.delete(id)
  }

  /** A typed command is being submitted. The returned key closes it. */
  typedOpened(name: string): number {
    this.typedCount += 1
    this.typed.set(this.typedCount, name)
    return this.typedCount
  }

  typedClosed(key: number): void {
    this.typed.delete(key)
  }

  /** agent.spawn answered with this agent: it's starting. */
  spawned(agentId: string): void {
    this.starting.add(agentId)
  }

  /** The agent made a tool call or ended its turn: it's no longer starting. Main (undefined) is ignored. */
  acted(agentId: string | undefined): void {
    if (agentId) this.starting.delete(agentId)
  }

  attribute(skill: string): Attribution {
    const calls = [...this.skillCalls.values()].filter(call => sameSkill(call.skill, skill))
    if (calls.length > 0) {
      const loops = new Set(calls.map(call => loopKey(call.loop)))
      return loops.size === 1 && calls[0] ? { loop: calls[0].loop, via: 'skill-tool' } : UNATTRIBUTED
    }
    if ([...this.typed.values()].some(name => sameSkill(name, skill))) return { loop: MAIN, via: 'typed' }
    if (this.starting.size === 1) {
      const [agentId] = this.starting
      if (agentId) return { loop: { kind: 'agent', agentId }, via: 'agent-preload' }
    }
    return UNATTRIBUTED
  }
}
