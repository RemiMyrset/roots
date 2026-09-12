/**
 * Repository-root discovery plus the constants and text helpers every docs script shares.
 * Kept in its own module with ZERO npm imports so the lint-only scripts (check-docs,
 * check-portability) and the readers run in a repo that has synced `scripts/docs` but not
 * installed `automd` — the pre-commit hook depends on that. generators.mts is the one file
 * that imports automd.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** Where decision records live, relative to the repository root. */
export const DECISIONS_DIR = 'docs/internal/decisions'
/** Where spec areas live, relative to the repository root. */
export const SPECS_DIR = 'docs/internal/specs'
/** A decision record filename, NNNN-kebab-title.md — one definition so the checker and the readers agree. */
export const DECISION_FILE_RE = /^\d{4}-[a-z0-9-]+\.md$/
/** The H1 of a decision record, `# NNNN. Title`; group 1 is the number, group 2 the title. */
export const DECISION_H1_RE = /^# (\d{4})\. (\S.*)$/m
/** The first H1 of a page; group 1 is its text. */
export const H1_RE = /^# (.+)$/m
/** The Status metadata bullet of a decision record; group 1 is the raw value. */
export const STATUS_BULLET_RE = /^- \*\*Status:\*\*(.*)$/m
/**
 * An automd opening marker; group 1 is the generator name. Anchored at line start and
 * tolerant of arguments and letter case because automd's own block matcher is, so the two
 * agree on what a region is: a marker quoted mid-line in prose is not one. Global, for
 * `matchAll`; never set its `lastIndex`.
 */
export const AUTOMD_OPEN_RE = /^<!--\s*automd:(\S+)\s[^\n]*?-->/gim
/** An automd closing marker, matched as loosely as automd matches it. Global; clone before `exec`. */
export const AUTOMD_CLOSE_RE = /^<!--\s*\/automd\s*-->/gim
/**
 * The opener of the comment automd writes into a region when a generator throws. automd
 * turns the throw into document CONTENT and still exits 0; once that comment is committed,
 * regeneration is byte-identical, so the drift gate never sees it and check-portability
 * strips it as an HTML comment. Escaped, never pasted: the sentinel is U+26A0 followed by
 * U+FE0F and two spaces, and a hand-typed emoji would silently fail to match. Matching the
 * comment opener rather than the bare character keeps emoji in prose from tripping it.
 */
export const AUTOMD_WARNING = '<!-- \u26A0'
/** Directories no docs walk descends into: VCS, caches, build output, editor state. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', '.obsidian', '.turbo', '.vitepress', 'coverage', 'dist', 'node_modules'])
// Named key: tsc (noPropertyAccessFromIndexSignature) refuses dot access on process.env and
// eslint (dot-notation) refuses a literal in brackets; a const key satisfies both.
const CI_KEY = 'GITHUB_ACTIONS'
/** Warning-line prefix: a GitHub Actions annotation in CI, plain text everywhere else. */
export const WARN = process.env[CI_KEY] ? '::warning::' : 'warning: '

/** Deterministic, locale-independent string order (code-unit, not localeCompare) for sort comparators. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

/**
 * The text with every fenced code block blanked, markers included, line count preserved,
 * so a line-anchored regex cannot match an example inside a fence. Only fences indented
 * three spaces or fewer are tracked (no blockquoted or list-nested fences), which is what
 * the decision and spec pages use; a fence of the same character and at least the opener's
 * length closes, as in CommonMark.
 */
export function stripFences(text: string): string {
  let fence: { char: string, len: number } | undefined
  return text.split('\n').map((line) => {
    if (!fence) {
      const open = line.match(OPEN_FENCE_RE)
      if (!open)
        return line
      fence = { char: open[1]![0]!, len: open[1]!.length }
      return ''
    }
    const close = line.match(CLOSE_FENCE_RE)
    if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len)
      fence = undefined
    return ''
  }).join('\n')
}

const SLUG_DROP_RE = /[^\p{L}\p{N}\p{M}\s_-]/gu
const SLUG_SPACE_RE = /\s/g

/**
 * The anchor GitHub derives from heading text: lowercased, everything but letters, digits,
 * marks, underscores, hyphens, and whitespace dropped, each whitespace character a hyphen.
 * Duplicates are not suffixed here; slugsOf does that per page. VitePress slugs a heading
 * with inner punctuation or a leading digit differently, so avoid anchoring into those.
 */
export function githubSlug(text: string): string {
  return text.trim().toLowerCase().replace(SLUG_DROP_RE, '').replace(SLUG_SPACE_RE, '-')
}

/**
 * An ATX heading as CommonMark reads it: up to three spaces of indent, one to six hashes,
 * then optional text; group 1 is the hash run (its length is the level), group 2 the raw text,
 * which may still carry closing hashes (strip with CLOSING_HASHES_RE). One definition, so the
 * anchor checker and the portability checker agree on what a heading is.
 */
export const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(\S.*)?)?$/
/** The optional closing hash run of an ATX heading, `## Title ##`, which is not part of the text. */
export const CLOSING_HASHES_RE = /[ \t]+#+[ \t]*$/

/**
 * The GitHub anchor of every ATX heading in a page, in document order, repeated slugs
 * suffixed `-1`, `-2` as GitHub does. Fenced examples are skipped; setext headings are
 * not read, and an empty heading yields no slug.
 */
export function slugsOf(text: string): string[] {
  const seen = new Map<string, number>()
  const out: string[] = []
  for (const line of stripFences(text).split('\n')) {
    const heading = line.match(ATX_HEADING_RE)
    if (!heading)
      continue
    const base = githubSlug((heading[2] ?? '').trim().replace(CLOSING_HASHES_RE, ''))
    if (!base)
      continue
    let slug = base
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    out.push(slug)
  }
  return out
}

let cachedRoot: string | undefined

function findUp(marker: string): string | undefined {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, marker)))
      return dir
    const parent = dirname(dir)
    if (parent === dir)
      return undefined
    dir = parent
  }
}

function gitToplevel(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || undefined
}

/**
 * The repository root, in this order: the nearest directory above cwd holding
 * automd.config.ts (the roots docs layout); else the git top level (a repo that synced
 * scripts/docs without the config); else the nearest package.json (no git either). Git
 * comes before package.json because inside a workspace package the nearest package.json
 * is the wrong root. Lazy + memoized so importing this module stays side-effect free.
 */
export function repoRoot(): string {
  if (cachedRoot)
    return cachedRoot
  const root = findUp('automd.config.ts') ?? gitToplevel() ?? findUp('package.json')
  if (!root)
    throw new Error('repo root not found: no automd.config.ts or package.json above cwd and not a git checkout — run from inside the repo')
  cachedRoot = root
  return root
}
