// The mod's settings (plan F12, Phase 1 keys). plugin.json's userConfig
// declares each key with the same default, and the engine fills defaults in
// and checks types before register runs. plugin.json declares no min or max:
// the engine refuses to load a module whose stored value is out of range, so
// a typo in settings would switch the whole mod off. The ranges live here
// instead, and parseConfig moves a value into its range. A choice key keeps
// its plugin.json options, for the /config picker: a stored value outside
// them reaches the module as unset, and so as the default.

import type { PluginOptions } from 'claude-code'

import type { Config } from '../types'

export const DEFAULTS: Config = {
  strictness: 'enforce',
  maxStopBlocks: 2,
  exemptSkills: [],
  checkpointDir: '.taskmaster',
  checkpointGit: 'commit',
  checkpointPush: 'off',
  checkpointEveryWrites: 10,
  contextCheckpointPercent: 70,
  resumePolicy: 'offer',
  metrics: true,
  metricsDir: '.taskmaster/metrics',
  ratingSample: 3,
  experiment: 'off',
  experimentWeights: '1/1/1',
  experimentBlind: true,
  rca: 'manual',
  rcaModel: 'haiku',
  rcaDailyCap: 5,
  circuitBreakerThreshold: 3,
  overrideDir: '.taskmaster/overrides',
}

type Key = keyof Config

/** The values a choice key may hold, as plugin.json's `options` list them. */
export const CHOICES: Partial<Record<Key, readonly string[]>> = {
  strictness: ['observe', 'advisory', 'enforce', 'strict'],
  checkpointGit: ['commit', 'ignore'],
  checkpointPush: ['off', 'milestone'],
  resumePolicy: ['offer', 'auto', 'off'],
  experiment: ['off', 'on'],
  rca: ['manual', 'off'],
}

/** Each number key's range. plugin.json declares none: see the top of this file. */
const RANGES: Partial<Record<Key, readonly [number, number]>> = {
  maxStopBlocks: [1, 5],
  checkpointEveryWrites: [1, 1000],
  contextCheckpointPercent: [10, 95],
  ratingSample: [0, 100],
  rcaDailyCap: [0, 50],
  circuitBreakerThreshold: [1, 20],
}

/** The hooks' settings: each known key from `options`, or its default when the value can't stand. */
export function parseConfig(options: PluginOptions): Config {
  const config: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULTS) as Key[]) {
    config[key] = pick(key, options[key])
  }
  return config as Config
}

/** Keys naming a folder inside the project, which later tasks write to and commit. */
const FOLDERS: readonly Key[] = ['checkpointDir', 'metricsDir', 'overrideDir']

function pick(key: Key, value: unknown): unknown {
  const fallback = DEFAULTS[key]
  if (Array.isArray(fallback)) return names(value) ?? [...fallback]
  if (typeof value !== typeof fallback) return fallback
  if (typeof value === 'number') return clamp(value, RANGES[key], fallback as number)
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (FOLDERS.includes(key)) return folder(text) ?? fallback
  if (key === 'experimentWeights') return weights(text) ?? fallback
  return choose(text, CHOICES[key], fallback as string)
}

/** A folder relative to the project root, tidied; undefined for one that leaves it, is the root itself, or is inside `.git`. */
function folder(path: string): string | undefined {
  if (/^([/\\~]|[A-Za-z]:)/.test(path)) return undefined
  const parts = path.split(/[/\\]+/).filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..')) return undefined
  if (parts.some(part => part.toLowerCase() === '.git')) return undefined
  return parts.join('/')
}

/** Three non-negative numbers, baseline/generic/frontmatter, not all zero. */
function weights(text: string): string | undefined {
  const parts = text.split('/')
  if (parts.length !== 3 || !parts.every(part => /^\d+(\.\d+)?$/.test(part))) return undefined
  return parts.some(part => Number(part) > 0) ? text : undefined
}

function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean)
}

function clamp(value: number, range: readonly [number, number] | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !range) return fallback
  return Math.min(range[1], Math.max(range[0], Math.round(value)))
}

function choose(value: string, choices: readonly string[] | undefined, fallback: string): string {
  if (!value) return fallback
  if (choices && !choices.includes(value)) return fallback
  return value
}
