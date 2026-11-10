// P1.4: what a skill's extraction is cached under (plan F1.3). skill.prompt's text holds the skill's folder and, for a
// typed command, the person's words, so its hash moves with both. The key is a hash of the skill's own words alone.
// The file at `path` comes first: a body with $ARGUMENTS has the typed words substituted in where nothing can strip them,
// and a file with no final newline gets its ARGUMENTS block where the frame can't tell it from the body (2.1.322).

import type { DeclaredContract, Extraction } from '../types'
import { validateDeclared } from './contract'
import { contentHash } from './skills'

/** A frontmatter block: it opens the file, and a line of three dashes closes it. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

/** The skill's own words in its SKILL.md: what follows the frontmatter block, or the whole file where it has none. */
export function fileBody(file: string): string {
  const block = FRONTMATTER.exec(file)
  return block ? file.slice(block[0].length) : file
}

/** The key of a skill's body, from `fileBody` or `promptBody`: its hash, whatever its line endings and the blank lines around it. */
export function bodyKey(body: string): Promise<string> {
  return contentHash(body.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd())
}

const KINDS = ['workflow', 'reference', 'persona'] as const
const REPLY_KEYS = new Set(['kind', 'confidence', 'steps', 'confirm_before'])
/** A reply that is one code fence and nothing else: models often wrap JSON in one. */
const FENCED = /^\s*```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```\s*$/

/**
 * The extraction a model's reply holds (plan F1.3), or why it can't be used. Strict and all-or-nothing, like a declared
 * contract: `steps` and `confirm_before` are a declared block's, checked by the same rules. The reply names no mode,
 * version or origin, because the level is decided from the tier and the parse (F1.4), never by the model.
 */
export function validateExtraction(reply: string): { extraction?: Extraction; problems: string[] } {
  let value: unknown
  try {
    value = JSON.parse(FENCED.exec(reply)?.[1] ?? reply)
  } catch (error) {
    return { problems: [`the reply is not JSON: ${(error as Error).message}`] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problems: ['the reply must be an object of keys'] }
  const raw = value as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(raw)) if (!REPLY_KEYS.has(key)) problems.push(`unknown key "${key}"`)
  const kind = KINDS.find(known => known === raw.kind)
  if (kind === undefined) problems.push(`kind must be one of ${KINDS.join(', ')}`)
  const confidence = raw.confidence
  if (!(typeof confidence === 'number' && confidence >= 0 && confidence <= 1)) problems.push('confidence must be a number from 0 to 1')

  // Only a workflow has steps to hold Claude to.
  const steps = raw.steps === undefined && kind !== 'workflow' ? [] : raw.steps
  const declared = validateDeclared({ steps, ...(raw.confirm_before === undefined ? {} : { confirm_before: raw.confirm_before }) })
  problems.push(...declared.problems)
  if (kind === 'workflow' && Array.isArray(steps) && steps.length === 0) problems.push('a workflow needs at least one step')

  if (problems.length > 0) return { problems }
  const contract = declared.contract as DeclaredContract
  return { extraction: { kind: kind as Extraction['kind'], confidence: confidence as number, steps: contract.steps, confirmBefore: contract.confirmBefore }, problems: [] }
}
