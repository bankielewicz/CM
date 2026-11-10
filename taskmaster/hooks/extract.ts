// P1.4: what a skill's extraction is cached under (plan F1.3). skill.prompt's text holds the skill's folder and, for a
// typed command, the person's words, so its hash moves with both. The key is a hash of the skill's own words alone.
// The file at `path` comes first: a body with $ARGUMENTS has the typed words substituted in where nothing can strip them,
// and a file with no final newline gets its ARGUMENTS block where the frame can't tell it from the body (2.1.322).

import { contentHash } from './skills'

/** A frontmatter block: it opens the file, and a line of three dashes closes it. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

/** The skill's own words in its SKILL.md: what follows the frontmatter block, or the whole file where it has none. */
export function fileBody(file: string): string {
  const block = FRONTMATTER.exec(file)
  return block ? file.slice(block[0].length) : file
}

/** The key of a skill's body, from `fileBody` or `promptBody`: its hash, whatever its line endings and the blank lines around it. */
export function bodyKey(body: string): Promise<string> {
  return contentHash(body.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd())
}
