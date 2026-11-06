// P1.3: the declared contract tiers (plan F1.7, F1.9). A person declares a
// contract in the skill's `taskmaster:` frontmatter block, or in an override
// file: `.taskmaster/overrides/<skill>.json`, JSON holding the same object
// (owner decision, 2026-11-04: the mod API has no YAML parser).
//
// Validation is strict and all-or-nothing: an invalid contract is set aside
// whole, with its reasons, and the next tier is tried. Principle 1's order is
// frontmatter, then override, then the model's extraction (P1.4), then the
// deterministic parse (P1.2).

import type { ContractProblem, DeclaredContract, DeclaredResolution, DeclaredStep, VerifySpec } from '../types'

export type Tier = { contract?: DeclaredContract; problems: ContractProblem[] }
export type ContractTier = 'frontmatter' | 'override' | 'llm' | 'heuristic' | 'none'

const TOP_KEYS = new Set(['version', 'mode', 'steps', 'confirm_before', 'origin', 'suggested_by'])
const STEP_KEYS = new Set(['id', 'title', 'mandatory', 'verify', 'when'])
const MODES = ['off', 'advisory', 'enforce'] as const
const ORIGINS = ['authored', 'suggested'] as const
const STEP_ID = /^[A-Za-z0-9][\w-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** The contract a block declares, or why it can't be used. */
export function validateDeclared(value: unknown): { contract?: DeclaredContract; problems: string[] } {
  const problems: string[] = []
  if (!isRecord(value)) return { problems: ['the contract must be an object of keys'] }
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) problems.push(`unknown key "${key}"`)

  if (value.version !== undefined && value.version !== 1) {
    problems.push(`version ${String(value.version)} is written for a newer taskmaster; this one reads version 1`)
  }
  // Left out, it's enforce. Blank, as YAML reads `mode:` with nothing after it, it's invalid like any other blank key.
  const mode = value.mode === undefined ? 'enforce' : value.mode
  if (!MODES.includes(mode as (typeof MODES)[number])) problems.push(`mode must be one of ${MODES.join(', ')}`)
  const origin = value.origin
  if (origin !== undefined && !ORIGINS.includes(origin as (typeof ORIGINS)[number])) problems.push(`origin must be authored or suggested`)
  if (value.suggested_by !== undefined && text(value.suggested_by) === undefined) problems.push('suggested_by must be text')

  const steps: DeclaredStep[] = []
  if (!Array.isArray(value.steps)) problems.push('steps must be a list')
  else value.steps.forEach((raw, index) => {
    const step = readStep(raw, index + 1, problems)
    if (!step) return
    if (steps.some(other => other.id === step.id)) problems.push(`step id "${step.id}" is repeated`)
    steps.push(step)
  })

  const confirmBefore: string[] = []
  if (value.confirm_before !== undefined) {
    if (!Array.isArray(value.confirm_before)) problems.push('confirm_before must be a list of step ids')
    else for (const id of value.confirm_before) {
      if (typeof id === 'string' && steps.some(step => step.id === id)) confirmBefore.push(id)
      else problems.push(`confirm_before names "${String(id)}", which is no step`)
    }
  }

  if (problems.length > 0) return { problems }
  const contract: DeclaredContract = { version: 1, mode: mode as DeclaredContract['mode'], steps, confirmBefore }
  if (origin !== undefined) contract.origin = origin as DeclaredContract['origin']
  const suggestedBy = text(value.suggested_by)
  if (suggestedBy !== undefined) contract.suggestedBy = suggestedBy
  return { contract, problems: [] }
}

function readStep(raw: unknown, n: number, problems: string[]): DeclaredStep | undefined {
  if (!isRecord(raw)) {
    problems.push(`step ${n} must be an object`)
    return undefined
  }
  const before = problems.length
  for (const key of Object.keys(raw)) if (!STEP_KEYS.has(key)) problems.push(`step ${n} has an unknown key "${key}"`)
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!STEP_ID.test(id)) problems.push(`step ${n} needs an id of letters, digits, - or _`)
  const title = text(raw.title)
  if (title === undefined) problems.push(`step ${n} needs a title`)
  if (raw.mandatory !== undefined && typeof raw.mandatory !== 'boolean') problems.push(`step ${n}'s mandatory must be true or false`)
  if (raw.when !== undefined && text(raw.when) === undefined) problems.push(`step ${n}'s when must be text`)
  const verify = raw.verify === undefined ? undefined : readVerify(raw.verify, n, problems)
  if (problems.length > before || title === undefined) return undefined
  const step: DeclaredStep = { id, title, mandatory: raw.mandatory !== false }
  if (verify) step.verify = verify
  const when = text(raw.when)
  if (when !== undefined) step.when = when
  return step
}

/** Exactly one of `{ bash, exit? }`, `{ edits }` or `{ tool }`. */
function readVerify(raw: unknown, n: number, problems: string[]): VerifySpec | undefined {
  const kinds = isRecord(raw) ? (['bash', 'edits', 'tool'] as const).filter(kind => kind in raw) : []
  const kind = kinds[0]
  if (!isRecord(raw) || kinds.length !== 1 || !kind) {
    problems.push(`step ${n}'s verify must have exactly one of bash, edits or tool`)
    return undefined
  }
  const allowed = kind === 'bash' ? ['bash', 'exit'] : [kind]
  const extra = Object.keys(raw).filter(key => !allowed.includes(key))
  const value = text(raw[kind])
  if (extra.length > 0 || value === undefined) {
    problems.push(`step ${n}'s verify has ${value === undefined ? `an empty ${kind}` : `unknown keys ${extra.join(', ')}`}`)
    return undefined
  }
  if (kind !== 'bash') return kind === 'edits' ? { edits: value } : { tool: value }
  // An exit status is what a process can return: 0 to 255.
  if (raw.exit !== undefined && !(Number.isInteger(raw.exit) && (raw.exit as number) >= 0 && (raw.exit as number) <= 255)) {
    problems.push(`step ${n}'s verify exit must be a whole number from 0 to 255`)
    return undefined
  }
  return { bash: value, exit: (raw.exit as number | undefined) ?? 0 }
}

const problemsAt = (where: ContractProblem['where'], messages: string[]): ContractProblem[] => messages.map(message => ({ where, message }))

/**
 * The frontmatter tier: the `taskmaster:` block. Where the engine set
 * `frontmatterProblem`, part of the frontmatter was dropped, so the block
 * can't be trusted (skill.prompt's own docs leave refusing it to the hook).
 */
export function fromFrontmatter(frontmatter: Readonly<Record<string, unknown>>, frontmatterProblem?: string): Tier {
  if (frontmatterProblem !== undefined) {
    return { problems: [{ where: 'frontmatter', message: `the engine flagged this skill's frontmatter: ${frontmatterProblem}` }] }
  }
  if (!('taskmaster' in frontmatter)) return { problems: [] }
  const { contract, problems } = validateDeclared(frontmatter.taskmaster)
  return contract ? { contract, problems: [] } : { problems: problemsAt('frontmatter', problems) }
}

/** The override tier: the override file's text, undefined when there is no file, and why a file that's there couldn't be read. */
export function fromOverride(fileText: string | undefined, readError?: string): Tier {
  if (readError !== undefined) return { problems: [{ where: 'override', message: `the override file couldn't be read: ${readError}` }] }
  if (fileText === undefined) return { problems: [] }
  let value: unknown
  try {
    value = JSON.parse(fileText)
  } catch (error) {
    return { problems: [{ where: 'override', message: `the override file is not JSON: ${(error as Error).message}` }] }
  }
  const { contract, problems } = validateDeclared(value)
  return contract ? { contract, problems: [] } : { problems: problemsAt('override', problems) }
}

/** Frontmatter beats an override. The reasons any contract was set aside are kept. */
export function resolveDeclared(frontmatter: Tier, override?: Tier): DeclaredResolution {
  const problems = [...frontmatter.problems, ...(override?.problems ?? [])]
  if (frontmatter.contract) return { source: 'frontmatter', contract: frontmatter.contract, problems }
  if (override?.contract) return { source: 'override', contract: override.contract, problems }
  return { source: 'none', problems }
}

/** The override file for a skill: its name with anything but letters, digits, `.`, `-` and `_` made `_`. */
export function overrideFile(skill: string): string {
  return `${skill.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

/**
 * Principle 1's order of contract sources. P1.3 fills the declared tiers;
 * P1.4 supplies the model's extraction (`llm`) and decides the level.
 */
export function pickTier(input: { declared: DeclaredResolution; llm: boolean; heuristic: boolean }): ContractTier {
  if (input.declared.source !== 'none') return input.declared.source
  if (input.llm) return 'llm'
  return input.heuristic ? 'heuristic' : 'none'
}
