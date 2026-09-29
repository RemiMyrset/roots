/**
 * Readers and renderers for the decisions/specs system. Every list is derived from the
 * files when read: the VitePress sidebars, `pnpm docs:list`, the tables automd writes into
 * a page that keeps a region, and the region currency check in check-docs.mts all go
 * through these functions, so they cannot drift. ZERO npm imports: check-docs.mts runs in
 * a repo that synced scripts/docs without installing the docs toolchain. An absent
 * directory reads as empty, so a repo without decisions or specs still generates, checks,
 * and builds; an index page that links a page which is gone fails in VitePress, by design.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { byCodeUnit, DECISION_H1_RE, decisionIdentity, DECISIONS_DIR, H1_RE, repoRoot, SPECS_DIR, STATUS_BULLET_RE, stripFences } from './root.mts'

/** One decision record as read from its file: identity, title, and the Status bullet. */
export interface DecisionEntry {
  file: string
  /** What a supersede link's text names: NNNN for a legacy record, the filename stem for a dated one. */
  id: string
  /**
   * The display label: NNNN for a legacy record, the filename date (YYYY-MM-DD) for a dated
   * one. Named for the numbers it held alone before dated records, so site code written
   * against it keeps working; it is not a number, so never parse it as one.
   */
  num: string
  /** True for a numbered NNNN- record, which lists before every dated one. */
  legacy: boolean
  title: string
  status: string
}

/** One spec file, keyed by the area folder it lives in. */
export interface SpecEntry {
  area: string
  file: string
  title: string
}

/** One VitePress sidebar link. */
export interface SidebarItem {
  text: string
  link: string
}

const MD_EXT_RE = /\.md$/
const WHITESPACE_RE = /\s/
const UNESCAPED_PIPE_RE = /(?<!\\)\|/g

/** Regular files directly inside `dir`, sorted; empty when `dir` is absent. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name)
    .sort(byCodeUnit)
}

/**
 * Every decision record under `root`, legacy NNNN- records first, then dated ones, each by
 * filename, so dated records read oldest first. The explicit legacy-first order keeps a
 * numbered record at 2100 or above ahead of the dated ones too. Metadata comes from the
 * visible bold bullets (`- **Status:** accepted`), never frontmatter, and fenced examples
 * are ignored; the title is the text after `NNNN. ` in a legacy H1 and the whole H1 in a
 * dated one. A record missing its H1 or Status reads as its filename and `unknown`
 * (check-docs.mts rejects those). Default root: the repository this script runs in.
 */
export function readDecisions(root = repoRoot()): DecisionEntry[] {
  const dir = join(root, DECISIONS_DIR)
  const entries: DecisionEntry[] = []
  for (const file of filesIn(dir)) {
    const identity = decisionIdentity(file)
    if (!identity)
      continue
    const text = stripFences(readFileSync(join(dir, file), 'utf8'))
    const title = (identity.legacy ? text.match(DECISION_H1_RE)?.[2] : text.match(H1_RE)?.[1])?.trim() ?? file
    const status = text.match(STATUS_BULLET_RE)?.[1]?.trim() ?? 'unknown'
    entries.push({ file, id: identity.id, num: identity.label, legacy: identity.legacy, title, status })
  }
  return entries.sort((a, b) => Number(b.legacy) - Number(a.legacy) || byCodeUnit(a.file, b.file))
}

/**
 * Every spec under `root`, grouped by area folder, sorted by area then file. Areas are
 * discovered, `_`-prefixed templates skipped, and the title is the first H1 outside a
 * fence (the filename when there is none). Default root: the repository this script runs in.
 */
export function readSpecs(root = repoRoot()): SpecEntry[] {
  const dir = join(root, SPECS_DIR)
  if (!existsSync(dir))
    return []
  const entries: SpecEntry[] = []
  for (const area of readdirSync(dir, { withFileTypes: true })) {
    if (!area.isDirectory())
      continue
    for (const file of filesIn(join(dir, area.name))) {
      if (!file.endsWith('.md') || file.startsWith('_'))
        continue
      const text = stripFences(readFileSync(join(dir, area.name, file), 'utf8'))
      entries.push({ area: area.name, file, title: text.match(H1_RE)?.[1]?.trim() ?? file })
    }
  }
  return entries.sort((a, b) => byCodeUnit(a.area, b.area) || byCodeUnit(a.file, b.file))
}

/** A value for a Markdown table cell: every unescaped `|` escaped, an existing `\|` left alone. */
export function escapeCell(s: string): string {
  return s.replace(UNESCAPED_PIPE_RE, '\\|')
}

/**
 * The decisions table: what `pnpm docs:list` prints, and what automd writes into a page
 * that keeps a decisionsIndex region. A placeholder line when there are no records. Each
 * row links its record by ID, the text a supersede link needs, and the first column is
 * headed `ID` once a dated record exists. A legacy-only tree renders byte for byte as before
 * dated records, `#` header included, so a region a child still commits stays current.
 */
export function renderDecisionsIndex(decisions: DecisionEntry[]): string {
  if (decisions.length === 0)
    return '_No decisions yet. The first one appears here after `pnpm docs:gen`._'
  const header = decisions.every(d => d.legacy) ? '| # | Title | Status |' : '| ID | Title | Status |'
  const rows = decisions.map(d => `| [${d.id}](./${d.file}) | ${escapeCell(d.title)} | ${escapeCell(d.status)} |`)
  return [header, '| --- | --- | --- |', ...rows].join('\n')
}

/** The area-grouped spec list: what `pnpm docs:list` prints, and what automd writes into a page that keeps a specIndex region. A placeholder line when there are no specs. */
export function renderSpecIndex(specs: SpecEntry[]): string {
  if (specs.length === 0)
    return '_No specs yet. The first one appears here after `pnpm docs:gen`._'
  const lines: string[] = []
  let currentArea = ''
  for (const s of specs) {
    if (s.area !== currentArea) {
      currentArea = s.area
      lines.push(`### ${s.area}`, '')
    }
    lines.push(`- [${s.title}](./${s.area}/${s.file})`)
  }
  return lines.join('\n')
}

/**
 * What each generated index region holds, keyed by its automd generator name and rendered
 * for a given root. The checker compares regions against these; automd reaches the same
 * renderers through generators.mts. A region named anything else is not generated here.
 */
export const INDEX_RENDERERS: Readonly<Record<string, (root: string) => string>> = {
  decisionsIndex: root => renderDecisionsIndex(readDecisions(root)),
  specIndex: root => renderSpecIndex(readSpecs(root)),
}

/**
 * VitePress sidebar entries for the decisions, from the same reader as `pnpm docs:list`:
 * `NNNN. Title` for a legacy record, `YYYY-MM-DD Title` for a dated one, then the first word
 * of the Status in parentheses unless it is `accepted`, so the handbook shows status without a table.
 * Default root: the repository this script runs in.
 */
export function decisionsSidebar(root = repoRoot()): SidebarItem[] {
  return readDecisions(root).map((d) => {
    const word = d.status.split(WHITESPACE_RE, 1)[0]
    const suffix = word && word !== 'accepted' ? ` (${word})` : ''
    return {
      text: `${d.legacy ? `${d.num}.` : d.num} ${d.title}${suffix}`,
      link: `/decisions/${d.file.replace(MD_EXT_RE, '')}`,
    }
  })
}

/** VitePress sidebar entries for the specs, from the same reader as `pnpm docs:list`. Default root: the repository this script runs in. */
export function specsSidebar(root = repoRoot()): SidebarItem[] {
  return readSpecs(root).map(s => ({
    text: `${s.area}: ${s.title}`,
    link: `/specs/${s.area}/${s.file.replace(MD_EXT_RE, '')}`,
  }))
}
