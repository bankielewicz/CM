// Which folders in a repository are mods. No dependencies, so the Stop hook can
// still run and report a missing `npm ci`.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MANIFEST = '.claude-plugin/plugin.json'

/** Mods with a hooks module, tracked or new, as paths relative to root. */
export function findMods(root) {
  const listed = spawnSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', `:(glob)**/${MANIFEST}`],
    { encoding: 'utf8' },
  )
  if (listed.status !== 0) return []
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map(manifest => dirname(dirname(manifest)))
    .filter(mod => existsSync(join(root, mod, 'hooks/hooks.json')))
    .sort()
}
