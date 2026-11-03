import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROTECTED, protectedChanges } from './gate-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CLI = join(HERE, 'gate-guard.mjs')

const runCli = input => {
  const r = spawnSync(process.execPath, [CLI], { input, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('every file that can switch off the gate counts as protected', () => {
  const gateFiles = [
    'coverage-exempt.json',
    'package.json',
    'package-lock.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'scripts/mod-coverage.mjs',
    'scripts/nested/new-file.mjs',
    '.github/workflows/mod-coverage.yml',
    '.github/workflows/gate-guard.yml',
  ]
  assert.deepEqual(protectedChanges(gateFiles), gateFiles)
})

test('ordinary work does not', () => {
  assert.deepEqual(
    protectedChanges([
      'README.md',
      'docs/taskmaster-plan.md',
      'spike/taskmaster-spike/hooks/register.tsx',
      'spike/taskmaster-spike/package.json',
      'scripts.md',
      'my-scripts/run.mjs',
      '.github/CODEOWNERS',
      '.claude/agents/helper.md',
    ]),
    [],
  )
})

test('a pull request that leaves the gate alone passes', () => {
  const { status, out } = runCli('README.md\ndocs/taskmaster-plan.md\n')
  assert.equal(status, 0, out)
})

test('a pull request that changes the gate fails, names the files and says what to do', () => {
  const { status, out } = runCli('README.md\ncoverage-exempt.json\nscripts/mod-coverage.mjs\n')
  assert.equal(status, 1, out)
  assert.match(out, /::error.*coverage-exempt\.json/)
  assert.match(out, /::error.*scripts\/mod-coverage\.mjs/)
  assert.doesNotMatch(out, /::error.*README\.md/)
  assert.match(out, /ruleset/)
})

test('a file name cannot form a workflow command', () => {
  const { status, out } = runCli('scripts/a%0A::notice::b.mjs\n')
  assert.equal(status, 1, out)
  assert.match(out, /scripts\/a%250A::notice::b\.mjs/)
})

test('an empty file list fails, because it means the list could not be read', () => {
  for (const input of ['', '\n\n']) {
    const { status, out } = runCli(input)
    assert.equal(status, 1, out)
    assert.match(out, /no changed files/i)
  }
})

test('the workflow runs from the base branch and never runs pull request code', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/gate-guard.yml'), 'utf8')
  assert.match(yml, /^\s*pull_request_target:/m)
  assert.match(yml, /^\s*name: gate-guard$/m)
  assert.match(yml, /persist-credentials: false/)
  assert.doesNotMatch(yml, /^\s*ref:/m)
  assert.doesNotMatch(yml, /pull_request\.head/)
  assert.doesNotMatch(yml, /pull_request\.(title|body)/)
  assert.doesNotMatch(yml, /\bnpm\b/)
})

test('the workflow can only read, and fails when the file list could be cut short', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/gate-guard.yml'), 'utf8')
  assert.match(yml, /pull-requests: read/)
  assert.match(yml, /contents: read/)
  assert.doesNotMatch(yml, /: write\b/)
  assert.match(yml, /previous_filename/)
  assert.match(yml, /--paginate/)
  assert.match(yml, /-ge 3000/)
})

test('Claude Code denies edits to every protected path', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'))
  const deny = settings.permissions.deny
  for (const entry of PROTECTED) {
    const rule = entry.endsWith('/') ? `Edit(/${entry}**)` : `Edit(/${entry})`
    assert.ok(deny.includes(rule), `missing deny rule ${rule}`)
  }
})

test('Claude Code denies merging, and the Stop hook is still in place', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'))
  assert.ok(settings.permissions.deny.includes('Bash(gh pr merge *)'))
  assert.match(settings.hooks.Stop[0].hooks[0].command, /coverage-stop-hook\.mjs/)
})
