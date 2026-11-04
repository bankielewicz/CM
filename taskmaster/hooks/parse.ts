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

/** An indented code block's language: it has none, and isn't read for commands, which come from fences. */
const INDENTED = 'indented'
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/

/** `inList`: a list was open when this line began. */
type Line = { text: string; number: number; code?: { lang: string }; inList?: boolean }

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

/** The body's lines with their 1-based numbers in the full text: header and ARGUMENTS left out. */
function body(text: string): { text: string; number: number }[] {
  const all = text.split('\n').map((line, index) => ({ text: line.replace(/\r$/, ''), number: index + 1 }))
  let start = 0
  if (all[0]?.text.startsWith(HEADER)) start = 1
  while (all[start]?.text.trim() === '') start += 1
  // The first ARGUMENTS block, not the last: typed text can repeat the pattern,
  // and must never become skill rules. The cost is that a body holding this exact
  // pattern loses its tail, which drops requirements rather than inventing them.
  const end = all.findIndex(
    (line, index) => line.text.startsWith(ARGUMENTS) && all[index - 1]?.text === '' && all[index - 2]?.text === '',
  )
  return all.slice(start, end === -1 ? all.length : end)
}

/**
 * Marks each line inside a code block: fenced, whatever the fence's indent, with
 * the block's language, or indented four spaces after a blank line. Inside a list
 * those indented lines are the item's own paragraphs, so they stay text and their
 * rules count. A list ends at the first other line at column 0, as in listSteps.
 */
function classify(lines: { text: string; number: number }[]): Line[] {
  let fence: { marker: string; lang: string } | undefined
  let inList = false
  let codeMayStart = true
  return lines.map(line => {
    const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line.text)
    if (!fence) {
      if (open?.[1]) {
        fence = { marker: open[1], lang: (open[2] ?? '').toLowerCase() }
        codeMayStart = false
        return { ...line, code: { lang: '' } }
      }
      const blank = line.text.trim() === ''
      if (!blank && !inList && codeMayStart && /^(?: {4}|\t)/.test(line.text)) return { ...line, code: { lang: INDENTED } }
      codeMayStart = blank
      const marked = inList ? { ...line, inList } : line
      if (LIST_ITEM.test(line.text)) inList = true
      else if (!blank && !/^\s/.test(line.text)) inList = false
      return marked
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
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/

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
 * The first top-level list of this kind, whose first item's indent, up to 3
 * spaces, is the top level. An indented item inside another list is nested in it.
 * The list runs across blank lines, deeper lines and code blocks, and ends at the
 * first other line at its top level or further out.
 */
function listSteps(lines: Line[], item: RegExp, kind: ParsedStep['kind']): Span[] | undefined {
  const itemIn = (line: Line): { indent: number; text: string } | undefined => {
    const match = line.code ? null : item.exec(line.text)
    return match ? { indent: (match[1] ?? '').length, text: match[2] ?? '' } : undefined
  }
  const startsList = (found: { indent: number }, line: Line): boolean => found.indent < 2 || (found.indent <= 3 && !line.inList)
  const first = lines.findIndex(line => {
    const found = itemIn(line)
    return found !== undefined && startsList(found, line)
  })
  if (first === -1) return undefined
  const top = (itemIn(lines[first] as Line) as { indent: number }).indent
  const items: { title: string; index: number }[] = []
  let last = lines.length
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index] as Line
    const found = itemIn(line)
    if (found && found.indent < top + 2) items.push({ title: title(found.text), index })
    else if (kind === 'checklist' && /^\s*[-*+]\s/.test(line.text)) continue // a plain bullet among the boxes
    else if (!line.code && line.text.trim() !== '' && line.text.search(/\S/) <= top) {
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

const HEREDOC = /^<<-?\s*(?:\\|['"])?([A-Za-z_]\w*)/
/** Leading `VAR=value` words, whose values may hold quoted spaces. An unclosed quote matches nothing. */
const ENV_PREFIX = /^(?:[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*\s+)+/

/**
 * One shell line's `&&`, `||` and `;` segments, and the terminators of any
 * heredocs it opens. It reads quotes and comments, and little else: this is not
 * a shell parser.
 */
function readShell(text: string): { segments: string[]; heredocs: string[] } {
  const segments: string[] = []
  const heredocs: string[] = []
  let quote = ''
  let start = 0
  let end = text.length
  for (let at = 0; at < end; at += 1) {
    const char = text[at]
    if (char === '\\' && quote !== "'") at += 1
    else if (quote) quote = char === quote ? '' : quote
    else if (char === '"' || char === "'") quote = char
    else if (char === '#' && (at === 0 || /\s/.test(text[at - 1] as string))) end = at
    else if (char === ';' || text.startsWith('&&', at) || text.startsWith('||', at)) {
      segments.push(text.slice(start, at))
      start = at + (char === ';' ? 1 : 2)
      at = start - 1
    } else if (char === '<' && text[at - 1] !== '<') {
      const terminator = HEREDOC.exec(text.slice(at))?.[1]
      if (terminator) heredocs.push(terminator)
    }
  }
  segments.push(text.slice(start, end))
  return { segments, heredocs }
}

function commands(lines: Line[], spans: Span[]): VerifyCandidate[] {
  const found: VerifyCandidate[] = []
  const seen = new Set<string>()
  let pending: { text: string; line: number } | undefined
  let heredocs: string[] = []
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.test(line.text)
    if (fence) {
      // A code block's end ends whatever was still open in it.
      pending = undefined
      heredocs = []
    }
    if (!line.code || !SHELLS.has(line.code.lang) || fence) continue
    if (heredocs.length > 0) {
      // Trimmed, not exact: a block inside a list item indents its terminator too.
      if (line.text.trim() === heredocs[0]) heredocs.shift()
      continue
    }
    const text = line.text.trim().replace(/^\$\s+/, '')
    const joined = pending ? `${pending.text} ${text}` : text
    const at = pending?.line ?? line.number
    if (joined.endsWith('\\')) {
      pending = { text: joined.slice(0, -1).trim(), line: at }
      continue
    }
    pending = undefined
    const shell = readShell(joined)
    heredocs = shell.heredocs
    for (const segment of shell.segments) {
      const command = segment.trim().replace(ENV_PREFIX, '')
      if (!VERIFY.some(pattern => pattern.test(command))) continue
      // Spans are in text order, so the last that contains the line is the innermost.
      const span = spans.filter(candidate => candidate.step.line <= at && at < candidate.end).pop()
      // Once per step: a later step that runs the same command keeps its own verify spec.
      const key = `${span?.step.id ?? ''}\n${command}`
      if (seen.has(key)) continue
      seen.add(key)
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

/** A comma or space-separated string, or a list. */
function tools(value: unknown): string[] {
  const raw = typeof value === 'string' ? splitTools(value) : Array.isArray(value) ? value : []
  const names = raw.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean)
  return [...new Set(names)]
}

/** Splits only outside parentheses, so `Bash(sed -n 1,20p:*)` stays whole. */
function splitTools(value: string): string[] {
  const names: string[] = []
  let current = ''
  let depth = 0
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /[,\s]/.test(char)) {
      names.push(current)
      current = ''
    } else current += char
  }
  names.push(current)
  return names
}
