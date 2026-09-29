/**
 * Repository-root discovery plus the constants and text helpers every docs script shares.
 * Kept in its own module with ZERO npm imports so the lint-only scripts (check-docs,
 * check-portability) and the readers run in a repo that has synced `scripts/docs` but not
 * installed `automd` — the pre-commit hook depends on that. generators.mts is the one file
 * that imports automd.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** Where decision records live, relative to the repository root. */
export const DECISIONS_DIR = 'docs/internal/decisions'
/** Where spec areas live, relative to the repository root. */
export const SPECS_DIR = 'docs/internal/specs'
/** A decision record filename, NNNN-kebab-title.md — one definition so the checker and the readers agree. */
export const DECISION_FILE_RE = /^\d{4}-[a-z0-9-]+\.md$/

/** The number of a record named by DECISION_FILE_RE: its four leading digits, zero padding kept ("0007"). */
export function decisionNumber(file: string): string {
  return file.slice(0, 4)
}
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
/**
 * Any line git writes into a conflicted file: the `<<<<<<<` opener, the `|||||||` base
 * (diff3), the `=======` divider, and the `>>>>>>>` closer, at the default marker size of
 * seven. Tested line by line, and only where a line of `=======` cannot be prose: inside a
 * generated region.
 */
export const CONFLICT_LINE_RE = /^(?:<{7}|\|{7}|>{7})(?:\s|$)|^={7}\s*$/
/**
 * The `<<<<<<<` line that opens a conflict hunk, the one marker line that is never valid
 * markdown. The others can be: `=======` underlines a setext H1, `>>>>>>>` nests seven
 * blockquotes, and `|||||||` is a table row of empty cells. Tested line by line on a page.
 */
export const CONFLICT_OPEN_RE = /^<{7}(?:\s|$)/
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

/** Every `.md` file below `dir` as an absolute path, depth first in code-unit order, SKIP_DIRS not entered. */
export function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name))) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name))
      out.push(...markdownFiles(join(dir, e.name)))
    else if (e.isFile() && e.name.endsWith('.md'))
      out.push(join(dir, e.name))
  }
  return out
}

/** One automd region: the generator it names and where its body sits in the text it was read from. */
export interface AutomdRegion {
  /** The generator name, `decisionsIndex` for `<!-- automd:decisionsIndex -->`. */
  name: string
  /** Offset of the opening marker. */
  start: number
  /** Offset just past the opening marker: the body starts here. */
  bodyStart: number
  /** Offset of the closing marker; the text length when there is none. */
  bodyEnd: number
  /** False when no closing marker follows, so the body runs to the end of the text. */
  closed: boolean
}

/**
 * The automd regions of a page, in order, read as automd reads them: an opener inside an
 * earlier region's body belongs to that body, and an opener without a close runs to the end
 * of the text. Offsets index `text` exactly as given, so normalize line endings first only
 * when the caller compares, never when it writes.
 */
export function automdRegions(text: string): AutomdRegion[] {
  const close = new RegExp(AUTOMD_CLOSE_RE.source, AUTOMD_CLOSE_RE.flags)
  const out: AutomdRegion[] = []
  let pos = 0
  for (const open of text.matchAll(AUTOMD_OPEN_RE)) {
    if (open.index < pos)
      continue
    const bodyStart = open.index + open[0].length
    close.lastIndex = bodyStart
    const closed = close.exec(text)
    out.push({ name: open[1]!, start: open.index, bodyStart, bodyEnd: closed?.index ?? text.length, closed: closed !== null })
    pos = closed ? closed.index + closed[0].length : text.length
  }
  return out
}

/**
 * The text with the body of every closed region named `name` replaced by `contents`, framed
 * `\n\n<contents trimmed>\n\n`: the frame automd 0.4.3's transform writes, byte for byte,
 * whatever the file's line endings, so `pnpm docs:gen` afterwards changes nothing. An
 * unclosed region is left alone, as automd leaves it.
 */
export function writeRegion(text: string, name: string, contents: string): string {
  let out = ''
  let at = 0
  for (const region of automdRegions(text)) {
    if (region.name !== name || !region.closed)
      continue
    out += `${text.slice(at, region.bodyStart)}\n\n${contents.trim()}\n\n`
    at = region.bodyEnd
  }
  return out + text.slice(at)
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
