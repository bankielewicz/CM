#!/usr/bin/env node
// Fails a pull request that changes the coverage gate itself.
//
// mod-coverage runs from the pull request's own files, so a pull request could add an
// exemption or lower the bar and still pass. This check runs from the base branch through
// pull_request_target, so a pull request can't edit it for itself. It reads the list of
// changed paths on stdin and never runs pull request code. It has no dependencies, so
// nothing needs installing.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files that decide what the gate does. A trailing slash means everything under it. */
export const PROTECTED = [
  'coverage-exempt.json',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.claude/settings.json',
  '.claude/settings.local.json',
  'scripts/',
  '.github/workflows/',
]

const isProtected = path =>
  PROTECTED.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))

/** The paths in the list that belong to the gate. */
export function protectedChanges(paths) {
  return paths.filter(isProtected)
}

// A file name comes from the pull request, so it can't be allowed to form a workflow command.
const escapeForAnnotation = path => path.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

function main(input) {
  const paths = input.split('\n').map(line => line.trim()).filter(Boolean)
  if (paths.length === 0) {
    console.log('::error::No changed files were listed, so the gate files could not be checked.')
    return 1
  }
  const changed = [...new Set(protectedChanges(paths))]
  if (changed.length === 0) {
    console.log(`gate-guard: none of the ${paths.length} changed paths belong to the coverage gate.`)
    return 0
  }
  for (const path of changed) {
    console.log(`::error::This pull request changes a coverage gate file: ${escapeForAnnotation(path)}`)
  }
  console.log("To change the gate on purpose, the repository owner lifts the gate-guard check in the repository's ruleset for this merge.")
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(readFileSync(0, 'utf8'))
}
