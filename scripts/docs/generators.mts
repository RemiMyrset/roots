import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineGenerator } from 'automd'
import { repoRoot } from './root.mts'

export interface DecisionEntry {
  file: string
  num: string
  title: string
  status: string
}

const DECISIONS_DIR = 'docs/internal/decisions'
const SPECS_DIR = 'docs/internal/specs'

const DECISION_FILE_RE = /^\d{4}-[a-z0-9-]+\.md$/
const DECISION_H1_RE = /^# \d{4}\. (\S.*)$/m
const STATUS_BULLET_RE = /^- \*\*Status:\*\*(.*)$/m
const H1_RE = /^# (.+)$/m
const MD_EXT_RE = /\.md$/

/** Deterministic, locale-independent string order (code-unit, not localeCompare). */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const CELL_PIPE_RE = /\|/g
/** Escape a value going into a Markdown table cell so a literal `|` cannot break the row. */
function escapeCell(s: string): string {
  return s.replace(CELL_PIPE_RE, '\\|')
}

/**
 * Read every decision record. Metadata is parsed from the visible bold bullets
 * (`- **Status:** accepted`) — ONE format, no frontmatter (docs render portably
 * in GitHub, VitePress, and Obsidian). Format is enforced by check-docs.mts.
 */
export function readDecisions(): DecisionEntry[] {
  const dir = join(repoRoot(), DECISIONS_DIR)
  return readdirSync(dir)
    .filter(f => DECISION_FILE_RE.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      const title = text.match(DECISION_H1_RE)?.[1] ?? file
      const status = text.match(STATUS_BULLET_RE)?.[1]?.trim() ?? 'unknown'
      return { file, num: file.slice(0, 4), title, status }
    })
}

export interface SpecEntry {
  area: string
  file: string
  title: string
}

/** Read every spec, grouped by area folder. Areas are discovered dynamically. */
export function readSpecs(): SpecEntry[] {
  const dir = join(repoRoot(), SPECS_DIR)
  const entries: SpecEntry[] = []
  for (const area of readdirSync(dir, { withFileTypes: true })) {
    if (!area.isDirectory())
      continue
    for (const file of readdirSync(join(dir, area.name)).sort()) {
      if (!file.endsWith('.md') || file.startsWith('_'))
        continue
      const text = readFileSync(join(dir, area.name, file), 'utf8')
      const title = text.match(H1_RE)?.[1] ?? file
      entries.push({ area: area.name, file, title })
    }
  }
  return entries.sort((a, b) => byCodeUnit(a.area, b.area) || byCodeUnit(a.file, b.file))
}

/** Generated table for docs/internal/decisions/index.md. Never hand-edit. */
export const decisionsIndex = defineGenerator({
  name: 'decisionsIndex',
  generate() {
    const rows = readDecisions().map(d =>
      `| [${d.num}](./${d.file}) | ${escapeCell(d.title)} | ${escapeCell(d.status)} |`,
    )
    return {
      contents: ['| # | Title | Status |', '| --- | --- | --- |', ...rows].join('\n'),
    }
  },
})

/** Generated area-grouped list for docs/internal/specs/index.md. Never hand-edit. */
export const specIndex = defineGenerator({
  name: 'specIndex',
  generate() {
    const specs = readSpecs()
    if (specs.length === 0)
      return { contents: '_No specs yet. The first one appears here after `pnpm docs:gen`._' }
    const lines: string[] = []
    let currentArea = ''
    for (const s of specs) {
      if (s.area !== currentArea) {
        currentArea = s.area
        lines.push(`### ${s.area}`, '')
      }
      lines.push(`- [${s.title}](./${s.area}/${s.file})`)
    }
    return { contents: lines.join('\n') }
  },
})

interface SidebarItem {
  text: string
  link: string
}

/** VitePress sidebar entries — same readers as the automd index, so they cannot drift. */
export function decisionsSidebar(): SidebarItem[] {
  return readDecisions().map(d => ({
    text: `${d.num}. ${d.title}`,
    link: `/decisions/${d.file.replace(MD_EXT_RE, '')}`,
  }))
}

export function specsSidebar(): SidebarItem[] {
  return readSpecs().map(s => ({
    text: `${s.area}: ${s.title}`,
    link: `/specs/${s.area}/${s.file.replace(MD_EXT_RE, '')}`,
  }))
}
