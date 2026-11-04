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

/**
 * `fence`: the line is a code fence itself. `indent`: the fence's, on the lines
 * inside it. `inList`: a list was open when this line began. `afterText`: the line
 * before it was text, not blank or code.
 */
type Line = { text: string; number: number; code?: { lang: string; fence?: true; indent?: number }; inList?: boolean; afterText?: boolean }

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
 * rules count. A list keeps its own indent, and ends as `endsList` says.
 */
function classify(lines: { text: string; number: number }[]): Line[] {
  let fence: { marker: string; lang: string; indent: number } | undefined
  let listIndent: number | undefined
  let codeMayStart = true
  let afterText = false
  return lines.map(line => {
    if (!fence) {
      const open = /^\s*(`{3,}|~{3,})\s*([\w+-]*)(.*)$/.exec(line.text)
      // A backtick fence's opening line can't hold another backtick: that's inline code.
      if (open?.[1] && !(open[1].startsWith('`') && open[3]?.includes('`'))) {
        fence = { marker: open[1], lang: (open[2] ?? '').toLowerCase(), indent: line.text.search(/\S/) }
        codeMayStart = false
        afterText = false
        return { ...line, code: { lang: '', fence: true } }
      }
      const blank = line.text.trim() === ''
      if (!blank && listIndent === undefined && codeMayStart && /^(?: {4}|\t)/.test(line.text)) return { ...line, code: { lang: INDENTED } }
      codeMayStart = blank
      const marked: Line = { ...line, ...(listIndent === undefined ? {} : { inList: true }), ...(afterText ? { afterText } : {}) }
      afterText = !blank
      if (LIST_ITEM.test(line.text)) listIndent = Math.min(listIndent ?? Number.POSITIVE_INFINITY, line.text.search(/\S/))
      else if (listIndent !== undefined && endsList(marked, listIndent)) listIndent = undefined
      return marked
    }
    const current = fence
    const trimmed = line.text.trim()
    if (trimmed.startsWith(current.marker[0] ?? '`') && /^(`{3,}|~{3,})$/.test(trimmed) && trimmed.length >= current.marker.length) {
      fence = undefined
      return { ...line, code: { lang: '', fence: true } }
    }
    return { ...line, code: { lang: current.lang, indent: current.indent } }
  })
}

// ---------------------------------------------------------------- steps

const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/
const CHECKLIST = /^(\s*)[-*+]\s+\[[ xX]\]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/**
 * Whether a line that isn't a list item ends a list at this indent. It has to sit
 * at that indent or further out. Text straight after other text is a lazy
 * continuation and belongs to the item, unless it's a heading or a thematic break.
 */
function endsList(line: Line, listIndent: number): boolean {
  const indent = line.text.search(/\S/)
  if (indent === -1 || indent > listIndent) return false
  return !line.afterText || HEADING.test(line.text) || THEMATIC_BREAK.test(line.text)
}

/** A paired run of backticks, of any length, around a code span. */
const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g

/** A title without its Markdown marks. Code spans are held aside first, so their contents stay literal. */
function title(raw: string): string {
  const spans: string[] = []
  const plain = raw
    .replace(CODE_SPAN, (_span, _run, code: string) => `\0${spans.push(code) - 1}\0`)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\0(\d+)\0/g, (held, index: string) => spans[Number(index)] ?? held)
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
 * The list runs across blank lines, deeper lines and code blocks, and ends at a
 * marker of another kind at its top level or further out, or as `endsList` says.
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
    else if (!line.code && (LIST_ITEM.test(line.text) ? line.text.search(/\S/) <= top : endsList(line, top))) {
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

/** A heredoc's terminator. `stripTabs`: opened with `<<-`, so leading tabs don't count. */
type Heredoc = { word: string; stripTabs: boolean }

/**
 * Reads the heredoc opened by the `<<` at `at`: the whole delimiter word, with its
 * quotes and backslashes removed. No word, or an unclosed quote, opens nothing.
 * That covers a here-string too, since `<` can't start a word.
 */
function readHeredoc(text: string, at: number): Heredoc | undefined {
  const stripTabs = text[at + 2] === '-'
  let cursor = at + (stripTabs ? 3 : 2)
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
  let word = ''
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor] as string
    if (/[\s;&|<>()]/.test(char)) break
    if (char === '\\') {
      cursor += 1
      word += text[cursor] ?? ''
    } else if (char === "'" || char === '"') {
      const close = text.indexOf(char, cursor + 1)
      if (close === -1) return undefined
      word += text.slice(cursor + 1, close)
      cursor = close
    } else word += char
  }
  return word ? { word, stripTabs } : undefined
}

/** Leading `VAR=value` words, whose values may hold quoted spaces. An unclosed quote matches nothing. */
const ENV_PREFIX = /^(?:[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*\s+)+/

/**
 * One shell line's `&&`, `||` and `;` segments, and the terminators of any
 * heredocs it opens. It reads quotes, comments and arithmetic, and little else:
 * this is not a shell parser. `arithmetic` is the depth still open from the lines
 * before, and it returns the depth open after this one.
 */
function readShell(text: string, arithmetic: number): { segments: string[]; heredocs: Heredoc[]; arithmetic: number } {
  const segments: string[] = []
  const heredocs: Heredoc[] = []
  let quote = ''
  let start = 0
  let end = text.length
  for (let at = 0; at < end; at += 1) {
    const char = text[at]
    if (char === '\\' && quote !== "'") at += 1
    else if (quote) quote = char === quote ? '' : quote
    else if (char === '"' || char === "'") quote = char
    else if (arithmetic > 0) arithmetic += char === '(' ? 1 : char === ')' ? -1 : 0
    else if (text.startsWith('((', at)) {
      // Inside $((…)) or ((…)), << is a shift, so nothing there can open a heredoc.
      arithmetic = 2
      at += 1
    } else if (char === '#' && (at === 0 || /\s/.test(text[at - 1] as string))) end = at
    else if (char === ';' || text.startsWith('&&', at) || text.startsWith('||', at)) {
      segments.push(text.slice(start, at))
      start = at + (char === ';' ? 1 : 2)
      at = start - 1
    } else if (text.startsWith('<<', at)) {
      const heredoc = readHeredoc(text, at)
      if (heredoc) heredocs.push(heredoc)
      at += 1
    }
  }
  segments.push(text.slice(start, end))
  return { segments, heredocs, arithmetic }
}

function commands(lines: Line[], spans: Span[]): VerifyCandidate[] {
  const found: VerifyCandidate[] = []
  const seen = new Set<string>()
  let pending: { text: string; line: number } | undefined
  let heredocs: Heredoc[] = []
  let arithmetic = 0
  for (const line of lines) {
    const fence = line.code?.fence === true
    if (fence) {
      // A code block's end ends whatever was still open in it.
      pending = undefined
      heredocs = []
      arithmetic = 0
    }
    if (!line.code || !SHELLS.has(line.code.lang) || fence) continue
    const heredoc = heredocs[0]
    if (heredoc) {
      // The whole line, once the block's own indent is off: a block inside a list item indents its terminator too.
      const inBlock = line.text.replace(/^\s+/, leading => leading.slice(line.code?.indent))
      if ((heredoc.stripTabs ? inBlock.replace(/^\t+/, '') : inBlock) === heredoc.word) heredocs.shift()
      continue
    }
    const text = line.text.trim().replace(/^\$\s+/, '')
    const joined = pending ? `${pending.text} ${text}` : text
    const at = pending?.line ?? line.number
    // An even run is literal backslashes, so only an odd one continues the line.
    if ((/\\*$/.exec(joined) as RegExpExecArray)[0].length % 2 === 1) {
      pending = { text: joined.slice(0, -1).trim(), line: at }
      continue
    }
    pending = undefined
    const shell = readShell(joined, arithmetic)
    heredocs = shell.heredocs
    arithmetic = shell.arithmetic
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
