// P1.2: the deterministic parse (plan F1.2). No model, the same answer every
// time: P1.4 sets it beside the Haiku extraction, and a contract is enforced
// only where the two agree. So it is conservative, and decides nothing itself.
//
// The text arrives as skill.prompt gives it on 2.1.317: "Base directory for
// this skill: <dir>", a blank line, then the body, with a typed command's
// arguments appended as "ARGUMENTS: <args>" after two blank lines. There's no
// YAML block: the frontmatter comes apart, already parsed.

import type { ParsedRule, ParsedSkill, ParsedStep, VerifyCandidate } from '../types'

const HEADER = 'Base directory for this skill: '
const ARGUMENTS = 'ARGUMENTS: '
const TITLE_MAX = 120
const SHELLS = new Set(['', 'bash', 'sh', 'shell', 'console', 'zsh'])

/** Test, lint, build and typecheck commands, matched against one command segment. */
const VERIFY: readonly RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|check|typecheck|type-check)\b/,
  /^npx\s+(jest|vitest|eslint|tsc|prettier\s+--check|playwright\s+test)\b/,
  /^(python3?\s+-m\s+)?pytest\b/,
  /^(ruff|mypy|eslint|tsc|jest|vitest|flake8)\b/,
  /^cargo\s+(test|build|clippy|check)\b/,
  /^go\s+(test|build|vet)\b/,
  /^make\s+(test|lint|build|check)\b/,
  /^(\.\/)?gradlew?\s+(test|build|check)\b/,
  /^mvn\s+(test|verify|package)\b/,
]

type Line = { text: string; number: number; code?: { lang: string } }

/** A step and the lines that belong to it, for placing commands under steps. */
type Span = { step: ParsedStep; end: number }

export function parseSkill(text: string, frontmatter: Readonly<Record<string, unknown>>): ParsedSkill {
  const lines = classify(body(text))
  const spans = headingSteps(lines) ?? listSteps(lines, ORDERED, 'numbered') ?? listSteps(lines, CHECKLIST, 'checklist') ?? []
  return {
    ...meta(frontmatter),
    steps: spans.map(span => span.step),
    rules: rules(lines),
    verifyCandidates: commands(lines, spans),
  }
}

// ---------------------------------------------------------------- the frame

/** The body's lines with their 1-based numbers in the full text: header, YAML block and ARGUMENTS left out. */
function body(text: string): { text: string; number: number }[] {
  const all = text.split('\n').map((line, index) => ({ text: line, number: index + 1 }))
  let start = 0
  if (all[0]?.text.startsWith(HEADER)) start = 1
  while (all[start]?.text.trim() === '') start += 1
  if (all[start]?.text.trim() === '---') {
    const close = all.findIndex((line, index) => index > start && line.text.trim() === '---')
    if (close !== -1) start = close + 1
  }
  let end = all.length
  for (let index = all.length - 1; index >= 2; index -= 1) {
    if (all[index]?.text.startsWith(ARGUMENTS) && all[index - 1]?.text === '' && all[index - 2]?.text === '') {
      end = index
      break
    }
  }
  return all.slice(start, end)
}

/** Marks each line inside a fenced code block, whatever the fence's indent, with the block's language. */
function classify(lines: { text: string; number: number }[]): Line[] {
  let fence: { marker: string; lang: string } | undefined
  return lines.map(line => {
    const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line.text)
    if (!fence) {
      if (open?.[1]) {
        fence = { marker: open[1], lang: (open[2] ?? '').toLowerCase() }
        return { ...line, code: { lang: '' } }
      }
      return line
    }
    const current = fence
    const trimmed = line.text.trim()
    if (trimmed.startsWith(current.marker[0] ?? '`') && /^(`{3,}|~{3,})$/.test(trimmed) && trimmed.length >= current.marker.length) {
      fence = undefined
      return { ...line, code: { lang: '' } }
    }
    return { ...line, code: { lang: current.lang } }
  })
}

// ---------------------------------------------------------------- steps

const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/
const CHECKLIST = /^(\s*)[-*+]\s+\[[ xX]\]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

function title(raw: string): string {
  const plain = raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, '$1$2')
    .trim()
  return plain.slice(0, TITLE_MAX)
}

/** "Step N" and numbered headings. Each runs until the next heading at its level or above. */
function headingSteps(lines: Line[]): Span[] | undefined {
  const found: { title: string; level: number; index: number }[] = []
  const headings: { level: number; index: number }[] = []
  lines.forEach((line, index) => {
    if (line.code) return
    const heading = HEADING.exec(line.text)
    if (!heading?.[1]) return
    const level = heading[1].length
    headings.push({ level, index })
    const text = heading[2] ?? ''
    const step = /^step\s+(\d+)\b[\s:.)–—-]*(.*)$/i.exec(text)
    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(text)
    if (step) found.push({ title: step[2] ? title(step[2]) : `Step ${step[1]}`, level, index })
    else if (numbered?.[2]) found.push({ title: title(numbered[2]), level, index })
  })
  if (found.length === 0) return undefined
  return found.map((heading, n) => {
    const next = headings.find(other => other.index > heading.index && other.level <= heading.level)
    return {
      step: { id: `S${n + 1}`, title: heading.title, kind: 'heading', line: (lines[heading.index] as Line).number },
      end: next ? (lines[next.index] as Line).number : Number.POSITIVE_INFINITY,
    }
  })
}

/**
 * The first top-level list of this kind. It runs across blank lines, indented
 * lines and code blocks, and ends at the first other line at column 0.
 */
function listSteps(lines: Line[], item: RegExp, kind: ParsedStep['kind']): Span[] | undefined {
  const isItem = (line: Line): RegExpExecArray | null => {
    const match = line.code ? null : item.exec(line.text)
    return match && (match[1] ?? '').length < 2 ? match : null
  }
  const first = lines.findIndex(line => isItem(line) !== null)
  if (first === -1) return undefined
  const items: { title: string; index: number }[] = []
  let last = lines.length
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index] as Line
    const match = isItem(line)
    if (match) items.push({ title: title(match[2] ?? ''), index })
    else if (!line.code && line.text.trim() !== '' && !/^\s/.test(line.text)) {
      last = index
      break
    }
  }
  const endOfList = lines[last]?.number ?? Number.POSITIVE_INFINITY
  return items.map((entry, n) => ({
    step: { id: `S${n + 1}`, title: entry.title, kind, line: (lines[entry.index] as Line).number },
    end: items[n + 1] ? (lines[(items[n + 1] as { index: number }).index] as Line).number : endOfList,
  }))
}

// ---------------------------------------------------------------- rules and commands

function rules(lines: Line[]): ParsedRule[] {
  const found: ParsedRule[] = []
  for (const line of lines) {
    if (line.code) continue
    const match = /\b(MUST|NEVER|ALWAYS)\b/.exec(line.text)
    if (match) found.push({ kind: match[1] as ParsedRule['kind'], text: line.text.trim(), line: line.number })
  }
  return found
}

function commands(lines: Line[], spans: Span[]): VerifyCandidate[] {
  const found: VerifyCandidate[] = []
  const seen = new Set<string>()
  let pending: { text: string; line: number } | undefined
  for (const line of lines) {
    if (!line.code || !SHELLS.has(line.code.lang) || /^\s*(`{3,}|~{3,})/.test(line.text)) continue
    const text = line.text.trim().replace(/^\$\s+/, '')
    const joined = pending ? `${pending.text} ${text}` : text
    const at = pending?.line ?? line.number
    if (joined.endsWith('\\')) {
      pending = { text: joined.slice(0, -1).trim(), line: at }
      continue
    }
    pending = undefined
    for (const segment of joined.split(/&&|\|\||;/)) {
      const command = segment.trim().replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
      if (!VERIFY.some(pattern => pattern.test(command)) || seen.has(command)) continue
      seen.add(command)
      const span = spans.find(candidate => candidate.step.line <= at && at < candidate.end)
      found.push(span ? { command, line: at, step: span.step.id } : { command, line: at })
    }
  }
  return found
}

// ---------------------------------------------------------------- frontmatter

function meta(frontmatter: Readonly<Record<string, unknown>>): Pick<ParsedSkill, 'name' | 'description' | 'allowedTools' | 'forked' | 'modelInvocable'> {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const name = text(frontmatter.name)
  const description = text(frontmatter.description)
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    allowedTools: tools(frontmatter['allowed-tools']),
    forked: frontmatter.context === 'fork',
    modelInvocable: !(frontmatter['disable-model-invocation'] === true || frontmatter['disable-model-invocation'] === 'true'),
  }
}

/** A comma or space-separated string, or a list. Spaces inside parentheses, as in `Bash(git commit:*)`, don't split. */
function tools(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(/,|\s+(?![^()]*\))/) : Array.isArray(value) ? value : []
  const names = raw.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean)
  return [...new Set(names)]
}
