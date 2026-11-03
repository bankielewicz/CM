#!/usr/bin/env node
// Claude Code Stop hook: Claude can't finish a turn with changed mod code that
// is under the coverage bar. Exit 2 sends the reason on stderr back to Claude.
//
// It measures only mods whose code or tests differ from what's pushed, so turns
// that don't touch mod code stay fast and aren't blocked. CI measures all.

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findMods } from './find-mods.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

const isModCode = (path, mod) =>
  path.startsWith(`${mod}/`) &&
  (SOURCE.test(path) || path.startsWith(`${mod}/hooks/`) || path.startsWith(`${mod}/tests/`))

/** Whether any of the paths is code or tests of one of the mods. */
export function touchesModCode(paths, mods) {
  return paths.some(path => mods.some(mod => isModCode(path, mod)))
}

function git(root, ...args) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  return run.status === 0 ? run.stdout : undefined
}

function changedPaths(root) {
  const status = git(root, 'status', '--porcelain', '-z', '-uall', '--no-renames') ?? ''
  const uncommitted = status.split('\0').filter(Boolean).map(entry => entry.slice(3))
  const base = ['@{upstream}', 'origin/HEAD'].find(ref => git(root, 'rev-parse', '--verify', '--quiet', ref))
  const unpushed = base ? (git(root, 'diff', '--name-only', `${base}...HEAD`) ?? '') : ''
  return [...uncommitted, ...unpushed.split('\n').filter(Boolean)]
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const paths = changedPaths(root)
  const mods = findMods(root).filter(mod => touchesModCode(paths, [mod]))
  if (mods.length === 0) return 0

  const gate = spawnSync(process.execPath, [join(HERE, 'mod-coverage.mjs'), ...mods], {
    cwd: root,
    encoding: 'utf8',
  })
  if (gate.status === 0) return 0

  const missingTools = /ERR_MODULE_NOT_FOUND/.test(gate.stderr)
  console.error(
    missingTools
      ? `Can't measure mod coverage: run \`npm ci\` in ${root}, then finish.`
      : `Mod coverage gate failed for ${mods.join(', ')}. Write the missing tests before finishing:`,
  )
  console.error(`${gate.stdout}${gate.stderr}`.trim())
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
