import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  THRESHOLD,
  aggregate,
  findMods,
  instrumentSource,
  mergeDumps,
  verdict,
  wrapTestFile,
} from './mod-coverage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'mod-coverage.mjs')

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

// A minimal mod: two branches in a hook, so a test can reach one or both.
function mod(root, name, tests, extra = {}) {
  const dir = join(root, name)
  write(dir, {
    '.claude-plugin/plugin.json': JSON.stringify({ name, version: '0.1.0', description: 'fixture' }),
    'hooks/hooks.json': '{ "modules": ["./register.ts"] }',
    'hooks/register.ts': `
export const register = (on: any) => {
  on('tool.call', (_: any, e: any, next: any) => {
    if (e.tool === 'Write') {
      return { deny: 'no writes' }
    }
    return next(e)
  })
}
`,
    ...(tests ? { 'tests/a.test.ts': tests } : {}),
    ...extra,
  })
  return dir
}

const CALL_WRITE = `
test('denies a write', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Write', file_path: '/a', content: 'x' })
  expect(r.deny).toBe('no writes')
})
`
const CALL_READ = `
test('passes a read', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(r.deny).toBeUndefined()
})
`
const KIT = `import { expect, test } from 'claude-code/testing'\n`

function runCli(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

const scratch = () => mkdtempSync(join(tmpdir(), 'mod-coverage-test-'))

test('the bar is the 95 in the GitHub rule', () => {
  assert.equal(THRESHOLD, 95)
})

const ALL_FUNCTIONS = { total: 20, covered: 20 }
const ALL_LINES = { total: 100, covered: 100 }

test('verdict passes exactly at the bar and fails just under it', () => {
  assert.equal(verdict({ lines: { total: 100, covered: 95, pct: 95 }, functions: ALL_FUNCTIONS }).ok, true)
  assert.equal(verdict({ lines: { total: 10000, covered: 9499, pct: 94.99 }, functions: ALL_FUNCTIONS }).ok, false)
})

test('verdict holds functions to the same bar as lines', () => {
  assert.equal(verdict({ lines: ALL_LINES, functions: { total: 20, covered: 19 } }).ok, true)
  const low = verdict({ lines: ALL_LINES, functions: { total: 10000, covered: 9499 } })
  assert.equal(low.ok, false)
  assert.match(low.reason, /function coverage below 95/)
})

test('verdict names both when lines and functions are under the bar', () => {
  const low = verdict({ lines: { total: 100, covered: 50 }, functions: { total: 20, covered: 10 } })
  assert.equal(low.ok, false)
  assert.match(low.reason, /line and function coverage below 95/)
})

test('a mod with no functions is judged on its lines', () => {
  assert.equal(verdict({ lines: ALL_LINES, functions: { total: 0, covered: 0 } }).ok, true)
})

test('verdict fails when there are no lines to measure, rather than passing on nothing', () => {
  const v = verdict({ lines: { total: 0, covered: 0, pct: 100 }, functions: { total: 0, covered: 0 } })
  assert.equal(v.ok, false)
  assert.match(v.reason, /no lines/i)
})

test('wrapTestFile aliases the kit test and leaves type imports alone', () => {
  const out = wrapTestFile(
    `import { expect, mock, test } from 'claude-code/testing'\nimport type { Engine } from 'claude-code/testing'\ntest('x', () => {})\n`,
  )
  assert.match(out, /test as __modCoverageTest/)
  assert.match(out, /import type \{ Engine \} from 'claude-code\/testing'/)
  assert.match(out, /const test\b/)
})

test('wrapTestFile leaves a file that never imports the kit test unchanged', () => {
  const src = `import type { Engine } from 'claude-code/testing'\nexport const helper = 1\n`
  assert.equal(wrapTestFile(src), src)
})

test('instrumentSource keeps state declarations readable to the engine and out of the count', () => {
  const { code, coverage } = instrumentSource(
    `import { atom } from 'claude-code'\nconst a = atom({ plugin: 'p', key: 'k' } as const, 0)\nexport const f = () => 1\n`,
    'hooks/a.ts',
  )
  assert.doesNotMatch(code, /\+\+,\s*atom\(/)
  const lines = Object.values(coverage.statementMap).map(s => s.start.line)
  assert.equal(lines.includes(2), false)
  assert.equal(lines.includes(3), true)
})

test('an istanbul ignore comment does not take code out of the count', () => {
  const plain = instrumentSource(`export const f = (x: number) => {\n  if (x) return 1\n  return 2\n}\n`, 'hooks/a.ts')
  const hinted = instrumentSource(
    `export const f = (x: number) => {\n  /* istanbul ignore if */\n  if (x) return 1\n  /* istanbul ignore next */\n  return 2\n}\n`,
    'hooks/a.ts',
  )
  assert.equal(Object.keys(hinted.coverage.statementMap).length, Object.keys(plain.coverage.statementMap).length)
  assert.equal(Object.keys(hinted.coverage.branchMap).length, Object.keys(plain.coverage.branchMap).length)
})

test('line comments and file-level hints do not take code out of the count either', () => {
  const plain = `export const f = (x: number) => {\n  if (x) return 1\n  return 2\n}\n`
  const expected = Object.keys(instrumentSource(plain, 'hooks/a.ts').coverage.statementMap).length
  const lineHint = `export const f = (x: number) => {\n  // istanbul ignore if\n  if (x) return 1\n  return 2\n}\n`
  const fileHint = `/* istanbul ignore file */\n${plain}`
  assert.equal(Object.keys(instrumentSource(lineHint, 'hooks/a.ts').coverage.statementMap).length, expected)
  assert.equal(Object.keys(instrumentSource(fileHint, 'hooks/a.ts').coverage.statementMap).length, expected)
})

test('a hook that mentions istanbul ignore outside a comment keeps that text', () => {
  const source = [
    `export const a = () => 'istanbul ignore next'`,
    'export const b = () => `istanbul ignore next`',
    `export const c = (s: string) => /istanbul ignore next/.test(s)`,
    '',
  ].join('\n')
  const { code } = instrumentSource(source, 'hooks/a.ts')
  assert.equal(code.match(/istanbul ignore next/g)?.length, 3)
})

test('a hook whose output mentions istanbul ignore behaves the same under the gate', () => {
  const root = scratch()
  const tests = `${KIT}test('denies with the exact text', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Write', file_path: '/a', content: 'x' })
  expect(r.deny).toBe('istanbul ignore next')
})\n`
  const dir = mod(root, 'm', tests, {
    'hooks/register.ts': `export const register = (on: any) => {
  on('tool.call', () => ({ deny: 'istanbul ignore next' }))
}
`,
  })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 0, out)
  assert.match(out, /PASS/)
})

test('instrumentSource handles TSX', () => {
  const { coverage } = instrumentSource(`export const v = (x: number) => <Text>{x}</Text>\n`, 'hooks/a.tsx')
  assert.ok(Object.keys(coverage.statementMap).length > 0)
})

test('mergeDumps counts a file no test loaded as uncovered', () => {
  const seed = {
    'hooks/a.ts': instrumentSource(`export const a = () => 1\n`, 'hooks/a.ts').coverage,
    'hooks/b.ts': instrumentSource(`export const b = () => 2\n`, 'hooks/b.ts').coverage,
  }
  const counters = { s: { 0: 1, 1: 1 }, f: { 0: 1 }, b: {} }
  const output = `noise\n__MOD_COV__${JSON.stringify({ 'hooks/a.ts': counters })}__MOD_COV_END__\nmore noise\n`
  const { map, dumps } = mergeDumps(seed, output)
  assert.equal(dumps, 1)
  assert.equal(map.fileCoverageFor('hooks/a.ts').toSummary().data.lines.pct, 100)
  assert.equal(map.fileCoverageFor('hooks/b.ts').toSummary().data.lines.pct, 0)
})

test('mergeDumps ignores counters for a file it did not instrument', () => {
  const seed = { 'hooks/a.ts': instrumentSource(`export const a = () => 1\n`, 'hooks/a.ts').coverage }
  const output = `__MOD_COV__${JSON.stringify({ 'hooks/other.ts': { s: {}, f: {}, b: {} } })}__MOD_COV_END__`
  const { map } = mergeDumps(seed, output)
  assert.deepEqual(map.files(), ['hooks/a.ts'])
})

test('findMods finds mods with a hooks module and skips the rest', () => {
  const root = scratch()
  spawnSync('git', ['init', '-q', root])
  mod(root, 'mods/one', KIT + CALL_WRITE)
  write(join(root, 'mods/skills-only'), {
    '.claude-plugin/plugin.json': '{ "name": "skills-only", "version": "0.1.0", "description": "x" }',
  })
  spawnSync('git', ['-C', root, 'add', '.'])
  assert.deepEqual(findMods(root), ['mods/one'])
})

test('aggregate totals line counts across mods', () => {
  const sum = aggregate([
    { lines: { total: 10, covered: 10 } },
    { lines: { total: 10, covered: 5 } },
  ])
  assert.deepEqual(sum.lines, { total: 20, covered: 15, pct: 75 })
})

test('a mod below the bar fails, names its percentage and still writes the report', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_READ)
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /FAIL/)
  assert.match(out, /below 95/)
  assert.ok(existsSync(join(root, 'cov/cobertura-coverage.xml')))
})

test('a mod whose tests reach every line passes and reports it in Cobertura', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ)
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 0, out)
  assert.match(out, /PASS/)
  assert.match(readFileSync(join(root, 'cov/cobertura-coverage.xml'), 'utf8'), /register\.ts/)
})

test('a hook file no test imports pulls the mod below the bar', () => {
  const root = scratch()
  const padding = Array.from({ length: 40 }, (_, i) => `export const v${i} = () => ${i}`).join('\n')
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ, { 'hooks/unused.ts': padding + '\n' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /unused\.ts/)
})

// Each body is on its own line, so importing a file doesn't count as covering it.
const PADDING = Array.from({ length: 40 }, (_, i) => `export const v${i} = (x: number) => {\n  return x + ${i}\n}\n`).join('')

test('code outside hooks/ counts when a hook imports it', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ, {
    'lib/logic.ts': PADDING,
    'hooks/register.ts': `import { v0 } from '../lib/logic'
export const first = v0(1)
export const register = (on: any) => {
  on('tool.call', (_: any, e: any, next: any) => {
    if (e.tool === 'Write') {
      return { deny: 'no writes' }
    }
    return next(e)
  })
}
`,
  })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /lib\/logic\.ts/)
})

test('uncalled one-line functions fail the gate, though loading their file reaches every line', () => {
  const root = scratch()
  const oneLiners = `${Array.from({ length: 40 }, (_, i) => `export const v${i} = () => ${i}`).join('\n')}\n`
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ, {
    'lib/logic.ts': oneLiners,
    'hooks/register.ts': `import { v0 } from '../lib/logic'
export const first = v0()
export const register = (on: any) => {
  on('tool.call', (_: any, e: any, next: any) => {
    if (e.tool === 'Write') {
      return { deny: 'no writes' }
    }
    return next(e)
  })
}
`,
  })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /function coverage below 95/)
  assert.match(out, /\d+\/\d+ functions/)
})

test('every JavaScript and TypeScript file in a mod counts, whatever its extension or folder', () => {
  const root = scratch()
  const files = ['hooks/helper.mjs', 'lib/other.cjs', 'lib/typed.mts', 'lib/typed.cts', 'types/logic.ts']
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ, Object.fromEntries(files.map(file => [file, PADDING])))
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  for (const file of files) assert.match(out, new RegExp(file.replace('.', '\\.')))
})

test('tests and their helpers, type declarations and the manifest folder do not count', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ, {
    'tests/helper.ts': PADDING,
    'types/index.d.ts': 'export type T = string\n',
    '.claude-plugin/extra.ts': PADDING,
    'skills/s/SKILL.md': '# A skill\n',
  })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 0, out)
  assert.doesNotMatch(out, /helper\.ts|index\.d\.ts|extra\.ts|SKILL\.md/)
})

test('a failing test fails the gate even with full coverage', () => {
  const root = scratch()
  const failing = `test('wrong', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(1).toBe(2)
})\n`
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ + failing)
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /tests failed/i)
})

test('a mod with no tests fails', () => {
  const root = scratch()
  const dir = mod(root, 'm', null)
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
})

test('no mods at all is a failure, not a pass', () => {
  const root = scratch()
  spawnSync('git', ['init', '-q', root])
  const { status, out } = runCli(root, '--out', join(root, 'cov'))
  assert.equal(status, 1, out)
  assert.match(out, /no mods/i)
})

const exempt = (root, entries) => writeFileSync(join(root, 'coverage-exempt.json'), JSON.stringify(entries))
const FAILING = `test('wrong', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(1).toBe(2)
})\n`

test('an exempt mod under the bar passes, says why and shows its real number', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_READ)
  exempt(root, { m: 'throwaway spike' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 0, out)
  assert.match(out, /EXEMPT m: \d/)
  assert.match(out, /throwaway spike/)
})

test('an exempt mod stays out of the report GitHub reads', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_READ)
  exempt(root, { m: 'throwaway spike' })
  const { out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(existsSync(join(root, 'cov/cobertura-coverage.xml')), false)
  assert.match(out, /no coverage report/i)
})

test('a report left by an earlier run does not survive having nothing to report', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_READ)
  exempt(root, { m: 'throwaway spike' })
  write(root, { 'cov/cobertura-coverage.xml': '<coverage/>' })
  runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(existsSync(join(root, 'cov/cobertura-coverage.xml')), false)
})

test('an exempt mod with a failing test still fails', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ + FAILING)
  exempt(root, { m: 'throwaway spike' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /FAIL m/)
  assert.match(out, /tests failed/i)
})

test('an exemption with no reason fails', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ)
  exempt(root, { m: ' ' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(status, 1, out)
  assert.match(out, /reason/i)
})

test('a mod beside an exempt one is still held to the bar, and is all the report holds', () => {
  const root = scratch()
  const a = mod(root, 'a', KIT + CALL_READ)
  const b = mod(root, 'b', KIT + CALL_READ)
  exempt(root, { a: 'throwaway spike' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'), a, b)
  assert.equal(status, 1, out)
  assert.match(out, /EXEMPT a/)
  assert.match(out, /FAIL b/)
  const xml = readFileSync(join(root, 'cov/cobertura-coverage.xml'), 'utf8')
  assert.match(xml, /filename="b\//)
  assert.doesNotMatch(xml, /filename="a\//)
})

test('the default run over a repository whose only mod is exempt passes', () => {
  const root = scratch()
  spawnSync('git', ['init', '-q', root])
  mod(root, 'mods/one', KIT + CALL_READ)
  exempt(root, { 'mods/one': 'throwaway spike' })
  const { status, out } = runCli(root, '--out', join(root, 'cov'))
  assert.equal(status, 0, out)
  assert.match(out, /EXEMPT mods\/one/)
})

test('the mod under test is copied, never changed', () => {
  const root = scratch()
  const dir = mod(root, 'm', KIT + CALL_WRITE + CALL_READ)
  const before = readFileSync(join(dir, 'hooks/register.ts'), 'utf8')
  runCli(root, '--out', join(root, 'cov'), dir)
  assert.equal(readFileSync(join(dir, 'hooks/register.ts'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'hooks/__mod_coverage_entry.ts')), false)
  assert.equal(resolve(dir).startsWith(root), true)
})
