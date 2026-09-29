/**
 * Readers and renderers for the decisions/specs system. The index tables automd writes,
 * the region currency check in check-docs.mts, the regions rewritten without automd
 * (regenerateIndexRegions), and the VitePress sidebars all go through these functions, so
 * they cannot drift. ZERO npm imports: check-docs.mts runs in a repo
 * that synced scripts/docs without installing the docs toolchain. An absent directory
 * reads as empty, so a repo without decisions or specs still generates, checks, and
 * builds; an index page that links a page which is gone fails in VitePress, by design.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { automdRegions, byCodeUnit, DECISION_FILE_RE, DECISION_H1_RE, decisionNumber, DECISIONS_DIR, H1_RE, markdownFiles, repoRoot, SPECS_DIR, STATUS_BULLET_RE, stripFences, writeRegion } from './root.mts'

/** One decision record as read from its file: number, title, and the Status bullet. */
export interface DecisionEntry {
  file: string
  num: string
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
 * Every decision record under `root`, by filename. Metadata comes from the visible bold
 * bullets (`- **Status:** accepted`), never frontmatter, and fenced examples are ignored;
 * a record missing its H1 or Status reads as its filename and `unknown` (check-docs.mts
 * rejects those). Default root: the repository this script runs in.
 */
export function readDecisions(root = repoRoot()): DecisionEntry[] {
  const dir = join(root, DECISIONS_DIR)
  return filesIn(dir)
    .filter(f => DECISION_FILE_RE.test(f))
    .map((file) => {
      const text = stripFences(readFileSync(join(dir, file), 'utf8'))
      const title = text.match(DECISION_H1_RE)?.[2]?.trim() ?? file
      const status = text.match(STATUS_BULLET_RE)?.[1]?.trim() ?? 'unknown'
      return { file, num: decisionNumber(file), title, status }
    })
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

/** The decisions index table as automd writes it into `docs/internal/decisions/index.md`; a placeholder line when there are no records. */
export function renderDecisionsIndex(decisions: DecisionEntry[]): string {
  if (decisions.length === 0)
    return '_No decisions yet. The first one appears here after `pnpm docs:gen`._'
  const rows = decisions.map(d => `| [${d.num}](./${d.file}) | ${escapeCell(d.title)} | ${escapeCell(d.status)} |`)
  return ['| # | Title | Status |', '| --- | --- | --- |', ...rows].join('\n')
}

/** The area-grouped spec list as automd writes it into `docs/internal/specs/index.md`; a placeholder line when there are no specs. */
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
 * for a given root. The checker compares regions against these, and regenerateIndexRegions
 * writes them; automd reaches the same renderers through generators.mts. A region named
 * anything else is not generated here.
 */
export const INDEX_RENDERERS: Readonly<Record<string, (root: string) => string>> = {
  decisionsIndex: root => renderDecisionsIndex(readDecisions(root)),
  specIndex: root => renderSpecIndex(readSpecs(root)),
}

/**
 * Rewrites every closed decisionsIndex and specIndex region in the markdown under
 * `<root>/docs` from the files on disk, framed as automd frames it, and returns the absolute
 * paths it changed. A conflicted region is replaced whole, which is how a merge conflict in
 * one is resolved; `pnpm docs:gen` afterwards finds nothing to change. Default root: the
 * repository this script runs in.
 */
export function regenerateIndexRegions(root = repoRoot()): string[] {
  const docs = join(root, 'docs')
  if (!existsSync(docs))
    return []
  const rendered = new Map<string, string>()
  const changed: string[] = []
  for (const file of markdownFiles(docs)) {
    const text = readFileSync(file, 'utf8')
    let out = text
    for (const name of new Set(automdRegions(text).map(r => r.name))) {
      const render = INDEX_RENDERERS[name]
      if (!render)
        continue
      let contents = rendered.get(name)
      if (contents === undefined) {
        contents = render(root)
        rendered.set(name, contents)
      }
      out = writeRegion(out, name, contents)
    }
    if (out !== text) {
      writeFileSync(file, out)
      changed.push(file)
    }
  }
  return changed
}

/** VitePress sidebar entries for the decisions, from the same reader as the index. Default root: the repository this script runs in. */
export function decisionsSidebar(root = repoRoot()): SidebarItem[] {
  return readDecisions(root).map(d => ({
    text: `${d.num}. ${d.title}`,
    link: `/decisions/${d.file.replace(MD_EXT_RE, '')}`,
  }))
}

/** VitePress sidebar entries for the specs, from the same reader as the index. Default root: the repository this script runs in. */
export function specsSidebar(root = repoRoot()): SidebarItem[] {
  return readSpecs(root).map(s => ({
    text: `${s.area}: ${s.title}`,
    link: `/specs/${s.area}/${s.file.replace(MD_EXT_RE, '')}`,
  }))
}
