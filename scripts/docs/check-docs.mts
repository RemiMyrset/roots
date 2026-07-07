/**
 * Structural lint for the decisions/specs system — enforces the couplings that
 * generation cannot: record format, metadata bullets, supersede links, spec
 * Source/Tests paths resolving on disk, review-date freshness, and index pages
 * carrying their automd markers.
 *
 * Blocking errors exit 1; warnings print but pass (CI shows them as ::warning).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { repoRoot } from './generators.mts'

const STALE_DAYS = 180
// Prefix-anchored on purpose: a "superseded by [NNNN](./…)" status carries a trailing
// markdown link, so the vocabulary matches the leading keyword only, not the whole line.
const STATUS_VOCAB = /^(?:proposed|accepted|rejected|deprecated|superseded by \[?\d{4}\]?)/
const DECISION_FILE_RE = /^\d{4}-[a-z0-9-]+\.md$/
const DECISION_H1_RE = /^# (\d{4})\. \S/m
const STATUS_BULLET_RE = /^- \*\*Status:\*\*(.*)$/m
const SUPERSEDED_LINK_RE = /superseded by \[\d{4}\]\(\.\/\d{4}-[a-z0-9-]+\.md\)/
const DATE_BULLET_RE = /^- \*\*Date:\*\*(.*)$/m
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True only for a well-formed AND calendar-real ISO date — rejects 2026-02-30 / 2026-13-01. */
function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s))
    return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
const BACKTICK_PATH_RE = /`([^`]+)`/g
const REVIEWED_BULLET_RE = /^- \*\*Last reviewed:\*\*\s*(\d{4}-\d{2}-\d{2})/m

const root = repoRoot()
const errors: string[] = []
const warnings: string[] = []

/**
 * Markdown specs found below a directory (recursive), area-relative. Ignores
 * `_`-prefixed templates and non-markdown assets (e.g. an `images/` folder).
 */
function nestedMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory())
      out.push(...nestedMarkdown(join(dir, e.name)).map(p => `${e.name}/${p}`))
    else if (e.name.endsWith('.md') && !e.name.startsWith('_'))
      out.push(e.name)
  }
  return out
}

// --- decisions -------------------------------------------------------------
const decisionsDir = join(root, 'docs/internal/decisions')
const decisionFiles = readdirSync(decisionsDir).filter(f => f.endsWith('.md') && !f.startsWith('_') && f !== 'index.md')
const seenNums = new Map<string, string>()

for (const file of decisionFiles) {
  const where = `docs/internal/decisions/${file}`
  if (!DECISION_FILE_RE.test(file)) {
    errors.push(`${where}: filename must be NNNN-kebab-title.md`)
    continue
  }
  const num = file.slice(0, 4)
  if (seenNums.has(num))
    errors.push(`${where}: duplicate decision number ${num} (also ${seenNums.get(num)})`)
  seenNums.set(num, file)

  const text = readFileSync(join(decisionsDir, file), 'utf8')
  const h1 = text.match(DECISION_H1_RE)
  if (!h1)
    errors.push(`${where}: H1 must be "# ${num}. Title"`)
  else if (h1[1] !== num)
    errors.push(`${where}: H1 number ${h1[1]} does not match filename ${num}`)

  const status = text.match(STATUS_BULLET_RE)?.[1]?.trim()
  if (!status)
    errors.push(`${where}: missing "- **Status:** ..." bullet`)
  else if (!STATUS_VOCAB.test(status))
    errors.push(`${where}: status "${status}" not in vocabulary: proposed | accepted | rejected | deprecated | superseded by NNNN`)
  // A bare "superseded" (no "by NNNN") already fails the vocabulary check above;
  // only demand the markdown link once the status is otherwise well-formed, so
  // one underlying problem is not reported twice.
  else if (status.startsWith('superseded') && !SUPERSEDED_LINK_RE.test(status))
    errors.push(`${where}: superseded status must link the newer record: "superseded by [NNNN](./NNNN-slug.md)"`)

  const date = text.match(DATE_BULLET_RE)?.[1]?.trim()
  if (!date || !isRealIsoDate(date))
    errors.push(`${where}: missing or non-real "- **Date:** YYYY-MM-DD" bullet`)
}

const decisionsIndexPath = join(decisionsDir, 'index.md')
if (!existsSync(decisionsIndexPath)) {
  errors.push('docs/internal/decisions/index.md: missing index page')
}
else {
  const decisionsIndexText = readFileSync(decisionsIndexPath, 'utf8')
  if (!decisionsIndexText.includes('<!-- automd:decisionsIndex -->'))
    errors.push('docs/internal/decisions/index.md: missing <!-- automd:decisionsIndex --> marker')
}

// --- specs -------------------------------------------------------------------
const specsDir = join(root, 'docs/internal/specs')
for (const area of readdirSync(specsDir, { withFileTypes: true })) {
  if (!area.isDirectory()) {
    // A stray top-level spec would be invisible to the index, the sidebar, and
    // every check below — reject it instead of silently ignoring it.
    if (area.name.endsWith('.md') && area.name !== 'index.md' && !area.name.startsWith('_'))
      errors.push(`docs/internal/specs/${area.name}: specs must live in an area directory (specs/<area>/<name>.md)`)
    continue
  }
  for (const entry of readdirSync(join(specsDir, area.name), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // A spec nested below the area (specs/<area>/<sub>/<name>.md) is invisible
      // to the index, sidebar, and every check here — reject it. Asset folders
      // (e.g. images/) hold no markdown and pass silently.
      for (const nested of nestedMarkdown(join(specsDir, area.name, entry.name)))
        errors.push(`docs/internal/specs/${area.name}/${entry.name}/${nested}: specs must be flat within an area (specs/<area>/<name>.md); nested specs are invisible to the index`)
      continue
    }
    const file = entry.name
    if (!file.endsWith('.md') || file.startsWith('_'))
      continue
    const where = `docs/internal/specs/${area.name}/${file}`
    const text = readFileSync(join(specsDir, area.name, file), 'utf8')

    for (const bullet of ['Source', 'Tests'] as const) {
      const line = text.match(new RegExp(`^- \\*\\*${bullet}:\\*\\*\\s*(.+)$`, 'm'))?.[1]
      if (!line) {
        errors.push(`${where}: missing "- **${bullet}:** ..." bullet`)
        continue
      }
      if (line.includes('(pending)')) {
        warnings.push(`${where}: ${bullet} is (pending) — fill it when the code lands`)
        continue
      }
      for (const [, p] of line.matchAll(BACKTICK_PATH_RE)) {
        // A Source/Tests line may cite a test name alongside its path, e.g.
        // `src/foo.ts` (`describe('add')`). Only existence-check path-shaped
        // tokens; skip anything with spaces, quotes, or parens.
        if (!/^[\w@./-]+$/.test(p!))
          continue
        if (!existsSync(join(root, p!)))
          errors.push(`${where}: ${bullet} path \`${p}\` does not exist`)
      }
    }

    const reviewed = text.match(REVIEWED_BULLET_RE)?.[1]
    if (!reviewed) {
      errors.push(`${where}: missing "- **Last reviewed:** YYYY-MM-DD" bullet`)
    }
    else if (!isRealIsoDate(reviewed)) {
      // Shape is guaranteed by the regex; reject impossible dates (2026-02-30) so a
      // typo cannot masquerade as fresh (an Invalid Date's NaN age silently passes).
      errors.push(`${where}: "- **Last reviewed:** ${reviewed}" is not a real calendar date`)
    }
    else {
      const ageDays = (Date.now() - new Date(reviewed).getTime()) / 86_400_000
      if (ageDays < 0)
        warnings.push(`${where}: last reviewed ${reviewed} is in the future — likely a year typo`)
      else if (ageDays > STALE_DAYS)
        warnings.push(`${where}: last reviewed ${reviewed} (> ${STALE_DAYS} days ago) — re-verify against the source`)
    }
  }
}

const specsIndexPath = join(specsDir, 'index.md')
if (!existsSync(specsIndexPath)) {
  errors.push('docs/internal/specs/index.md: missing index page')
}
else {
  const specsIndexText = readFileSync(specsIndexPath, 'utf8')
  if (!specsIndexText.includes('<!-- automd:specIndex -->'))
    errors.push('docs/internal/specs/index.md: missing <!-- automd:specIndex --> marker')
}

// --- report ------------------------------------------------------------------
for (const w of warnings)
  console.warn(`::warning::docs:check: ${w}`)
if (errors.length > 0) {
  console.error(`\n✖ docs:check — ${errors.length} error(s)\n`)
  for (const e of errors)
    console.error(`  ${e}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs:check — ${decisionFiles.length} decision(s), specs valid${warnings.length ? `, ${warnings.length} warning(s)` : ''}`)
