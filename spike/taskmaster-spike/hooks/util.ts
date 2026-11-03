// Small helpers shared by the spike's hooks: redaction, clipping, hashing,
// and the marker words probes ask Claude to say back.

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi,
  /(Authorization:\s*Bearer\s+)\S+/gi,
]

export function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_match: string, keep: unknown) =>
      typeof keep === 'string' ? `${keep}[REDACTED]` : '[REDACTED]',
    )
  }
  return out
}

export function clip(text: string, max = 120): string {
  const flat = redact(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export const MARK = {
  continued: 'SPIKE-CONTINUED',
  subContinued: 'SPIKE-SUB-CONTINUED',
  denied: 'SPIKE-DENIED-SEEN',
  preload: 'SPIKE-PRELOAD-OK',
  skill: 'SPIKE-SKILL-OK',
} as const

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
