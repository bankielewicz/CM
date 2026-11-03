#!/usr/bin/env node
// Line coverage for Claude Code mods, measured under the real test kit.
//
// `claude plugin test` has no coverage option and ignores flags it doesn't know,
// so this instruments a temporary copy of each mod and runs the kit on the copy:
//
// - Hooks run in their own scope, which a test can't read. A generated entry
//   module adds a private command that hands the counters back to the test.
// - Each test is wrapped to ask for those counters and print them when it ends.
// - The engine's scan has to read `atom(...)` declarations, so they stay
//   uninstrumented and out of the count.
//
// Exits 1 if any mod is under THRESHOLD, if its tests fail, or if there is
// nothing to measure. A mod listed in coverage-exempt.json, with a reason, is
// excused from the percentage only: it's still measured and printed, its tests
// must still pass, and it stays out of the report GitHub reads.
// Usage: mod-coverage.mjs [--out <dir>] [<mod folder>...]

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import libCoverage from 'istanbul-lib-coverage'
import { createInstrumenter } from 'istanbul-lib-instrument'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'

import { findMods } from './find-mods.mjs'

export { findMods }

/** The minimum line coverage, the same number as the GitHub ruleset's. */
export const THRESHOLD = 95

const DUMP_COMMAND = '__mod_coverage__'
const OPEN = '__MOD_COV__'
const CLOSE = '__MOD_COV_END__'
const ENTRY = '__mod_coverage_entry.ts'
const EXEMPT_FILE = 'coverage-exempt.json'
const REPORT = 'cobertura-coverage.xml'
const SOURCE = /\.(ts|tsx|js|jsx)$/
const NOT_CODE = /(\.d\.ts|\.test\.tsx?)$/
const TEST = /\.test\.tsx?$/
const SKIPPED_DIRS = new Set(['.claude', '.git', 'node_modules'])

// Takes only the counters: the maps are known from instrumenting.
const COUNTERS = `(cov: any) => Object.fromEntries(Object.entries(cov ?? {}).map(([path, c]: any) => [path, { s: c.s, f: c.f, b: c.b }]))`

/** Instruments one source file, and returns its code and its zeroed coverage. */
export function instrumentSource(source, path) {
  const instrumenter = createInstrumenter({
    esModules: true,
    compact: false,
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
    parserPlugins: /x$/.test(extname(path)) ? ['typescript', 'jsx'] : ['typescript'],
  })
  // An `istanbul ignore` comment would drop code from the count, so it doesn't work here.
  const instrumented = instrumenter.instrumentSync(source.replace(/\bistanbul\s+ignore\b/g, 'not-ignored'), path)
  const coverage = instrumenter.lastFileCoverage()
  const code = instrumented.replace(
    /\(cov_\w+\(\)\.s\[(\d+)\]\+\+,\s*(atom|memberOf|derive)\(/g,
    (_, id, call) => {
      delete coverage.statementMap[id]
      delete coverage.s[id]
      return `(${call}(`
    },
  )
  return { code, coverage }
}

/** Makes a test file report its counters as each test ends. */
export function wrapTestFile(source) {
  const shim = `
const test: any = (name: string, ...rest: any[]) => {
  const body = rest.pop()
  const counters = ${COUNTERS}
  const emit = (value: unknown) => console.log('${OPEN}' + JSON.stringify(value) + '${CLOSE}')
  return (__modCoverageTest as any)(name, ...rest, async ($: any, ...more: any[]) => {
    try {
      return await body($, ...more)
    } finally {
      emit(counters((globalThis as any).__coverage__))
      try {
        const reply = await $.command.run({
          command: '${DUMP_COMMAND}',
          args: '',
          origin: { kind: 'composer' },
          presentation: { isFullscreen: false, columns: 100 },
        })
        emit(JSON.parse(reply.text))
      } catch {}
    }
  })
}
`
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"])claude-code\/testing\2/g,
    (statement, names, quote) => {
      if (!/\btest\b/.test(names)) return statement
      const renamed = names.replace(/\btest\b/, 'test as __modCoverageTest')
      return `import {${renamed}} from ${quote}claude-code/testing${quote}\n${shim}`
    },
  )
}

function entryModule(moduleFile) {
  const inner = moduleFile.replace(SOURCE, '')
  return `import { register as inner } from '${inner}'

export const register = (on: any, options: any) => {
  const counters = ${COUNTERS}
  on('command.run', ($: any, e: any, next: any) => {
    if (e.command !== '${DUMP_COMMAND}') return next(e)
    return { text: JSON.stringify(counters((globalThis as any).__coverage__)) }
  })
  return (inner as any)(on, options)
}
`
}

/** Adds the counters printed in a test run to a map holding every seeded file. */
export function mergeDumps(seed, output) {
  const map = libCoverage.createCoverageMap({})
  for (const coverage of Object.values(seed)) map.addFileCoverage(structuredClone(coverage))

  let dumps = 0
  const dump = new RegExp(`${OPEN}(.*?)${CLOSE}`, 'gs')
  for (const [, json] of output.matchAll(dump)) {
    dumps += 1
    for (const [path, counters] of Object.entries(JSON.parse(json))) {
      const base = seed[path]
      if (!base) continue
      const pick = (known, seen) =>
        Object.fromEntries(Object.keys(known).map(id => [id, seen?.[id] ?? known[id]]))
      map.merge({
        [path]: {
          ...base,
          s: pick(base.s, counters.s),
          f: pick(base.f, counters.f),
          b: pick(base.b, counters.b),
        },
      })
    }
  }
  return { map, dumps }
}

/** Whether a summary clears the bar. Uses the counts, so rounding can't lift 94.996 to 95. */
export function verdict(summary) {
  const { total, covered } = summary.lines
  if (total === 0) return { ok: false, reason: 'no lines to measure' }
  if (covered * 100 < THRESHOLD * total) return { ok: false, reason: `below ${THRESHOLD}%` }
  return { ok: true, reason: '' }
}

/** Line totals across several mods. */
export function aggregate(summaries) {
  const total = summaries.reduce((sum, s) => sum + s.lines.total, 0)
  const covered = summaries.reduce((sum, s) => sum + s.lines.covered, 0)
  const pct = total === 0 ? 0 : Math.floor((covered * 10000) / total) / 100
  return { lines: { total, covered, pct } }
}

/** The mods excused from the percentage, each with its reason. */
function readExemptions(root) {
  const path = join(root, EXEMPT_FILE)
  if (!existsSync(path)) return {}
  const entries = JSON.parse(readFileSync(path, 'utf8'))
  for (const [mod, reason] of Object.entries(entries)) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`${EXEMPT_FILE}: ${mod} needs a reason`)
  }
  return entries
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIPPED_DIRS.has(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function measureMod(mod, root) {
  const absolute = resolve(root, mod)
  const work = mkdtempSync(join(tmpdir(), 'mod-coverage-'))
  try {
    const copy = join(work, basename(absolute))
    cpSync(absolute, copy, {
      recursive: true,
      filter: source => !relative(absolute, source).split(sep).some(part => SKIPPED_DIRS.has(part)),
    })

    const hooksDir = join(copy, 'hooks')
    const { modules } = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8'))
    if (modules?.length !== 1) throw new Error(`hooks.json must name one module, found ${modules?.length ?? 0}`)

    const seed = {}
    for (const file of walk(hooksDir)) {
      if (!SOURCE.test(file) || NOT_CODE.test(file)) continue
      const key = relative(root, join(absolute, relative(copy, file)))
      const { code, coverage } = instrumentSource(readFileSync(file, 'utf8'), key)
      writeFileSync(file, code)
      seed[key] = coverage
    }

    writeFileSync(join(hooksDir, ENTRY), entryModule(modules[0]))
    writeFileSync(join(hooksDir, 'hooks.json'), JSON.stringify({ modules: [`./${ENTRY}`] }))
    for (const file of walk(copy)) {
      if (TEST.test(file)) writeFileSync(file, wrapTestFile(readFileSync(file, 'utf8')))
    }

    const run = spawnSync('claude', ['plugin', 'test', copy], {
      cwd: copy,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      timeout: 300_000,
    })
    if (run.error) throw run.error
    const output = `${run.stdout}${run.stderr}`
    const failures = output
      .split('\n')
      .filter(line => /^\(fail\)|hooks module did not load|no hooks module/.test(line))
      .map(line => line.replace(/\s*\[[\d.]+m?s\]$/, ''))
    return { ...mergeDumps(seed, output), testsPassed: run.status === 0, failures }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function ranges(lines) {
  const out = []
  for (const line of lines) {
    const last = out.at(-1)
    if (last && last[1] === line - 1) last[1] = line
    else out.push([line, line])
  }
  const text = out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
  return text.length > 8 ? `${text.slice(0, 8).join(', ')}, …` : text.join(', ')
}

function printMod(mod, result, exemptReason) {
  const { map, testsPassed, failures } = result
  const summary = map.getCoverageSummary().toJSON()
  const check = verdict(summary)
  const ok = testsPassed && (Boolean(exemptReason) || check.ok)
  const problems = [exemptReason ? '' : check.reason, testsPassed ? '' : 'tests failed'].filter(Boolean).join('; ')
  const label = !ok ? 'FAIL' : exemptReason ? 'EXEMPT' : 'PASS'
  const counts = `${summary.lines.covered}/${summary.lines.total} lines`
  const note = problems ? `, ${problems}` : exemptReason ? `; ${exemptReason}` : ''
  console.log(`${label} ${mod}: ${summary.lines.pct}% (${counts})${note}`)
  for (const failure of failures) console.log(`  ${failure}`)
  for (const file of map.files()) {
    const coverage = map.fileCoverageFor(file)
    const { lines, branches, functions } = coverage.toSummary().toJSON()
    const missed = ranges(coverage.getUncoveredLines().map(Number))
    console.log(
      `  ${relative(mod, file)}: lines ${lines.pct}%, branches ${branches.pct}%, functions ${functions.pct}%` +
        (missed ? `; uncovered lines ${missed}` : ''),
    )
  }
  return { ok, summary }
}

function writeCobertura(map, out, root) {
  const context = libReport.createContext({ dir: out, coverageMap: map, defaultSummarizer: 'flat' })
  reports.create('cobertura', { file: REPORT, projectRoot: root }).execute(context)
}

function main(argv) {
  const root = process.cwd()
  const args = [...argv]
  let out = join(root, 'coverage')
  const outFlag = args.indexOf('--out')
  if (outFlag !== -1) [, out] = args.splice(outFlag, 2)

  const mods = args.length > 0 ? args.map(mod => relative(root, resolve(root, mod))) : findMods(root)
  if (mods.length === 0) {
    console.log('FAIL: no mods found to measure (a mod has .claude-plugin/plugin.json and hooks/hooks.json)')
    return 1
  }

  let exemptions
  try {
    exemptions = readExemptions(root)
  } catch (error) {
    console.log(`FAIL: ${error.message}`)
    return 1
  }

  const combined = libCoverage.createCoverageMap({})
  const summaries = []
  let allOk = true
  for (const mod of mods) {
    const result = measureMod(mod, root)
    const { ok, summary } = printMod(mod, result, exemptions[mod])
    allOk &&= ok
    if (exemptions[mod]) continue
    summaries.push(summary)
    combined.merge(result.map)
  }
  if (summaries.length > 1) console.log(`Total: ${aggregate(summaries).lines.pct}% of lines`)

  rmSync(join(out, REPORT), { force: true })
  if (summaries.length > 0) writeCobertura(combined, out, root)
  else console.log('No coverage report: every mod measured here is exempt.')

  if (!allOk) console.log(`Every mod needs passing tests and, unless exempt, at least ${THRESHOLD}% line coverage.`)
  return allOk ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
