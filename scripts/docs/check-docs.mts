/**
 * Structural lint for the decisions/specs system — enforces the couplings that
 * generation cannot: record format, metadata bullets, supersede links, spec
 * Source/Tests paths resolving on disk, review-date freshness, index pages
 * carrying their automd markers, the template-owned contract pages that follow
 * the spec shape, the agent-skills mirror, and the AGENTS.md line budget.
 *
 * Blocking errors exit 1; warnings print but pass (GitHub annotations in CI). A
 * missing decisions, specs, or template directory is skipped with a note, so the
 * checker also runs in a repo that synced scripts/docs without the docs layout.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DECISION_FILE_RE, repoRoot, SKIP_DIRS, STATUS_BULLET_RE, WARN } from './root.mts'
import { posixRelative, skillDrift, SKILLS_SOURCE, SKILLS_TARGET } from './skills.mts'

const STALE_DAYS = 180
// Prefix-anchored on purpose: a "superseded by [NNNN](./…)" status carries a trailing
// markdown link, so the vocabulary matches the leading keyword only, not the whole line.
const STATUS_VOCAB = /^(?:proposed|accepted|rejected|deprecated|superseded by \[?\d{4}\]?)/
const DECISION_H1_RE = /^# (\d{4})\. \S/m
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
// automd turns a generator throw into document CONTENT rather than a failure: it writes
// `<!-- U+26A0 (generatorName) message -->` into the marker region and still exits 0. Once
// that comment is committed, regeneration is byte-identical, so the CI drift gate (docs:gen then
// `git status --porcelain`) can never see it, and check-portability strips HTML comments
// before scanning. This is the only check that catches it.
// Escaped, never pasted: automd's sentinel is U+26A0 followed by U+FE0F and two spaces, and
// a hand-typed bare emoji would silently fail to match. Matching the comment opener rather
// than the bare character also keeps legitimate emoji in prose from tripping it.
const AUTOMD_WARNING = '<!-- \u26A0'
const AUTOMD_CLOSE = '<!-- /automd -->'

const root = repoRoot()
const errors: string[] = []
const warnings: string[] = []

/**
 * Errors when automd left a warning comment inside a generated region. `open` is the
 * generator's opening marker; the region runs to the next `<!-- /automd -->`, or to
 * end-of-file when the closing marker is absent — over-scanning is the safe direction,
 * since a missing close means the region is already malformed.
 */
function checkAutomdRegion(where: string, text: string, open: string): void {
  const start = text.indexOf(open)
  if (start === -1)
    return
  const from = start + open.length
  const closeAt = text.indexOf(AUTOMD_CLOSE, from)
  const region = text.slice(from, closeAt === -1 ? undefined : closeAt)
  if (region.includes(AUTOMD_WARNING))
    errors.push(`${where}: automd generator failed and wrote a warning comment into the ${open} region. Fix the generator, re-run \`pnpm docs:gen\`, and never commit the warning — once committed it regenerates identically and the drift gate goes green.`)
}

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

/** The Source, Tests, and Last reviewed bullets of a spec-shaped page: paths resolve, the date is real and fresh. */
function checkSpecPage(where: string, text: string): void {
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

// --- decisions -------------------------------------------------------------
/** Validates every decision record and the decisions index; returns the record count (0 when the directory is absent). */
function checkDecisions(): number {
  const decisionsDir = join(root, 'docs/internal/decisions')
  if (!existsSync(decisionsDir)) {
    console.log('  (docs/internal/decisions: not present, skipped)')
    return 0
  }
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

  const indexPath = join(decisionsDir, 'index.md')
  if (!existsSync(indexPath)) {
    errors.push('docs/internal/decisions/index.md: missing index page')
  }
  else {
    const indexText = readFileSync(indexPath, 'utf8')
    if (!indexText.includes('<!-- automd:decisionsIndex -->'))
      errors.push('docs/internal/decisions/index.md: missing <!-- automd:decisionsIndex --> marker')
    checkAutomdRegion('docs/internal/decisions/index.md', indexText, '<!-- automd:decisionsIndex -->')
  }
  return decisionFiles.length
}

// --- specs -------------------------------------------------------------------
/** Validates the specs layout (areas, flatness), every spec page, and the specs index. */
function checkSpecs(): void {
  const specsDir = join(root, 'docs/internal/specs')
  if (!existsSync(specsDir)) {
    console.log('  (docs/internal/specs: not present, skipped)')
    return
  }
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
      checkSpecPage(`docs/internal/specs/${area.name}/${file}`, readFileSync(join(specsDir, area.name, file), 'utf8'))
    }
  }

  const indexPath = join(specsDir, 'index.md')
  if (!existsSync(indexPath)) {
    errors.push('docs/internal/specs/index.md: missing index page')
  }
  else {
    const indexText = readFileSync(indexPath, 'utf8')
    if (!indexText.includes('<!-- automd:specIndex -->'))
      errors.push('docs/internal/specs/index.md: missing <!-- automd:specIndex --> marker')
    checkAutomdRegion('docs/internal/specs/index.md', indexText, '<!-- automd:specIndex -->')
  }
}

// --- template contracts --------------------------------------------------------
// Template mechanics are specified under docs/template (sync-template.md, …): any page
// there that carries a Source bullet is held to the same Source/Tests/Last reviewed rules.
function checkTemplateContracts(): void {
  const dir = join(root, 'docs/template')
  if (!existsSync(dir))
    return
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (/^- \*\*Source:\*\*/m.test(text))
      checkSpecPage(`docs/template/${file}`, text)
  }
}

// --- rulebooks ---------------------------------------------------------------
// AGENTS.md declares a hard 200-line budget for itself and every nested rulebook.
const RULEBOOK_BUDGET = 200
function rulebooks(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name))
      out.push(...rulebooks(join(dir, e.name)))
    else if (e.isFile() && e.name === 'AGENTS.md')
      out.push(join(dir, e.name))
  }
  return out
}
function checkRulebooks(): void {
  for (const file of rulebooks(root)) {
    const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').length
    if (lines > RULEBOOK_BUDGET)
      errors.push(`${posixRelative(root, file)}: ${lines} lines exceeds the ${RULEBOOK_BUDGET}-line rulebook budget — move content to its canonical home and link it`)
  }
}

// --- agent-skills mirror -------------------------------------------------------
// .agents/skills must equal .claude/skills byte for byte: a stale or hand-edited copy
// means Codex and Gemini run different skills than Claude Code. `pnpm docs:gen` regenerates it.
function checkSkillsMirror(): void {
  const drift = skillDrift(root)
  for (const f of drift.missing)
    errors.push(`${SKILLS_TARGET}/${f}: missing — run \`pnpm docs:gen\` to mirror ${SKILLS_SOURCE}`)
  for (const f of drift.different)
    errors.push(`${SKILLS_TARGET}/${f}: differs from ${SKILLS_SOURCE}/${f} — never hand-edit the mirror; edit the source and run \`pnpm docs:gen\``)
  for (const f of drift.stale)
    errors.push(`${SKILLS_TARGET}/${f}: has no source under ${SKILLS_SOURCE} — run \`pnpm docs:gen\` to remove it`)
}

const decisionCount = checkDecisions()
checkSpecs()
checkTemplateContracts()
checkRulebooks()
checkSkillsMirror()

// --- report ------------------------------------------------------------------
for (const w of warnings)
  console.warn(`${WARN}docs:check: ${w}`)
if (errors.length > 0) {
  console.error(`\n✖ docs:check — ${errors.length} error(s)\n`)
  for (const e of errors)
    console.error(`  ${e}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs:check — ${decisionCount} decision(s), specs valid, rulebooks within budget${warnings.length ? `, ${warnings.length} warning(s)` : ''}`)
