import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { touchesModCode } from './coverage-stop-hook.mjs'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'coverage-stop-hook.mjs')

test('code and tests of a mod count as a change', () => {
  const mods = ['spike/taskmaster-spike']
  assert.equal(touchesModCode(['spike/taskmaster-spike/hooks/register.tsx'], mods), true)
  assert.equal(touchesModCode(['spike/taskmaster-spike/tests/spike.test.ts'], mods), true)
  assert.equal(touchesModCode(['spike/taskmaster-spike/hooks/hooks.json'], mods), true)
  assert.equal(touchesModCode(['spike/taskmaster-spike/lib/logic.ts'], mods), true)
  assert.equal(touchesModCode(['spike/taskmaster-spike/helper.mjs'], mods), true)
})

test('a mod\'s notes and other folders do not', () => {
  const mods = ['spike/taskmaster-spike']
  assert.equal(touchesModCode(['spike/taskmaster-spike/GATE-A-TASKS.md'], mods), false)
  assert.equal(touchesModCode(['spike/taskmaster-spike/skills/spike-probe/SKILL.md'], mods), false)
  assert.equal(touchesModCode(['docs/taskmaster-plan.md', 'CLAUDE.md'], mods), false)
  assert.equal(touchesModCode(['spike/taskmaster-spike-old/hooks/a.ts'], mods), false)
})

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
}

// A committed mod whose one test reaches only half of its hook.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'mod-hook-test-'))
  const files = {
    'mods/m/.claude-plugin/plugin.json': '{ "name": "m", "version": "0.1.0", "description": "fixture" }',
    'mods/m/hooks/hooks.json': '{ "modules": ["./register.ts"] }',
    'mods/m/hooks/register.ts': `export const register = (on: any) => {
  on('tool.call', (_: any, e: any, next: any) => {
    if (e.tool === 'Write') {
      return { deny: 'no' }
    }
    return next(e)
  })
}
`,
    'mods/m/tests/a.test.ts': `import { expect, test } from 'claude-code/testing'
test('read', async ($: any, on: any) => {
  on('tool.call', () => ({ result: {} }))
  const r = await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(r.deny).toBeUndefined()
})
`,
    'mods/m/NOTES.md': 'notes\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  spawnSync('git', ['init', '-q', root])
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

function runHook(root) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  return { status: r.status, err: r.stderr }
}

test('with no mod code changed the hook lets the stop through without measuring', () => {
  const root = repo()
  writeFileSync(join(root, 'mods/m/NOTES.md'), 'edited\n')
  assert.equal(runHook(root).status, 0)
})

test('an uncommitted hook change below the bar blocks the stop and says why', () => {
  const root = repo()
  writeFileSync(join(root, 'mods/m/hooks/register.ts'), `export const register = (on: any) => {
  on('tool.call', (_: any, e: any, next: any) => {
    if (e.tool === 'Write') {
      return { deny: 'still no' }
    }
    return next(e)
  })
}
`)
  const { status, err } = runHook(root)
  assert.equal(status, 2, err)
  assert.match(err, /95/)
  assert.match(err, /mods\/m/)
})

test('an edit to an exempt mod under the bar lets the stop through', () => {
  const root = repo()
  writeFileSync(join(root, 'coverage-exempt.json'), JSON.stringify({ 'mods/m': 'throwaway spike' }))
  writeFileSync(join(root, 'mods/m/hooks/extra.ts'), 'export const extra = () => 1\n')
  const { status, err } = runHook(root)
  assert.equal(status, 0, err)
})

test('a failing test in an exempt mod still blocks the stop', () => {
  const root = repo()
  writeFileSync(join(root, 'coverage-exempt.json'), JSON.stringify({ 'mods/m': 'throwaway spike' }))
  appendFileSync(join(root, 'mods/m/tests/a.test.ts'), `test('wrong', () => { expect(1).toBe(2) })\n`)
  const { status, err } = runHook(root)
  assert.equal(status, 2, err)
  assert.match(err, /tests failed/i)
})

test('changed mod code with the tools missing blocks the stop and says to run npm ci', () => {
  const root = repo()
  const scripts = join(root, 'scripts')
  cpSync(dirname(HOOK), scripts, { recursive: true })
  writeFileSync(join(root, 'mods/m/hooks/extra.ts'), 'export const extra = () => 1\n')
  const r = spawnSync(process.execPath, [join(scripts, 'coverage-stop-hook.mjs')], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /npm ci/)
})

test('a commit that has not been pushed still counts as a change', () => {
  const root = repo()
  const bare = mkdtempSync(join(tmpdir(), 'mod-hook-remote-'))
  spawnSync('git', ['init', '-q', '--bare', bare])
  git(root, 'remote', 'add', 'origin', bare)
  git(root, 'push', '-q', '-u', 'origin', 'HEAD')
  writeFileSync(join(root, 'mods/m/hooks/extra.ts'), 'export const extra = () => 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'more')
  assert.equal(runHook(root).status, 2)
})
