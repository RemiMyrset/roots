/**
 * Structural lint for the decisions/specs system — enforces the couplings that
 * generation cannot: record format, metadata bullets, supersede links and the record
 * they point at, spec Source/Tests paths resolving on disk, review-date freshness, index
 * pages carrying their automd markers, every automd region under docs/ closed, free of
 * automd's warning comment, and current with the generators, the template-owned contract
 * pages that follow the spec shape, the agent-skills mirror, and the AGENTS.md line budget.
 *
 * Blocking errors exit 1; warnings print but pass (GitHub annotations in CI). A
 * missing docs, decisions, specs, or template directory is skipped with a note, so the
 * checker also runs in a repo that synced scripts/docs without the docs layout.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { readDecisions, readSpecs, renderDecisionsIndex, renderSpecIndex } from './readers.mts'
import { AUTOMD_CLOSE_RE, AUTOMD_OPEN_RE, AUTOMD_WARNING, byCodeUnit, DECISION_FILE_RE, DECISION_H1_RE, DECISIONS_DIR, repoRoot, SKIP_DIRS, SPECS_DIR, STATUS_BULLET_RE, stripFences, WARN } from './root.mts'
import { posixRelative, skillDrift, SKILLS_SOURCE, SKILLS_TARGET } from './skills.mts'

const STALE_DAYS = 180
// Prefix-anchored on purpose: a "superseded by [NNNN](./…)" status carries a trailing
// markdown link, so the vocabulary matches the leading keyword only, not the whole line.
const STATUS_VOCAB = /^(?:proposed|accepted|rejected|deprecated|superseded by \[?\d{4}\]?)/
// Prefix-anchored like STATUS_VOCAB, so trailing text stays accepted; group 2 is the link
// target, whose number must repeat the displayed one.
const SUPERSEDED_LINK_RE = /^superseded by \[(\d{4})\]\((\.\/\1-[a-z0-9-]+\.md)\)/
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
const PATH_CHARS_RE = /^[\w@./-]+$/
const EXTENSION_RE = /\.\w+$/
const REVIEWED_BULLET_RE = /^- \*\*Last reviewed:\*\*\s*(\d{4}-\d{2}-\d{2})/m
const SOURCE_BULLET_RE = /^- \*\*Source:\*\*/m
const CRLF_RE = /\r\n/g

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

/** The Source, Tests, and Last reviewed bullets of a spec-shaped page: paths resolve, the date is real and fresh. */
function checkSpecPage(where: string, raw: string): void {
  const text = stripFences(raw)
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
      // A Source/Tests line may cite a test name beside its path, e.g. `src/foo.ts` (`add`).
      // Only a path-shaped token is existence-checked: path characters throughout, and
      // either a `/` or an extension; a bare identifier is a name, not a path.
      if (!PATH_CHARS_RE.test(p!) || !(p!.includes('/') || EXTENSION_RE.test(p!)))
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
  const decisionsDir = join(root, DECISIONS_DIR)
  if (!existsSync(decisionsDir)) {
    console.log(`  (${DECISIONS_DIR}: not present, skipped)`)
    return 0
  }
  const decisionFiles = readdirSync(decisionsDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_') && e.name !== 'index.md')
    .map(e => e.name)
    .sort(byCodeUnit)
  const seenNums = new Map<string, string>()

  for (const file of decisionFiles) {
    const where = `${DECISIONS_DIR}/${file}`
    if (!DECISION_FILE_RE.test(file)) {
      errors.push(`${where}: filename must be NNNN-kebab-title.md`)
      continue
    }
    const num = file.slice(0, 4)
    if (seenNums.has(num))
      errors.push(`${where}: duplicate decision number ${num} (also ${seenNums.get(num)})`)
    seenNums.set(num, file)

    // Fences blanked, as the readers do, so a fenced example cannot pose as the H1 or Status.
    const text = stripFences(readFileSync(join(decisionsDir, file), 'utf8'))
    const h1 = text.match(DECISION_H1_RE)
    if (!h1)
      errors.push(`${where}: H1 must be "# ${num}. Title"`)
    else if (h1[1] !== num)
      errors.push(`${where}: H1 number ${h1[1]} does not match filename ${num}`)

    const status = text.match(STATUS_BULLET_RE)?.[1]?.trim()
    if (!status) {
      errors.push(`${where}: missing "- **Status:** ..." bullet`)
    }
    else if (!STATUS_VOCAB.test(status)) {
      errors.push(`${where}: status "${status}" not in vocabulary: proposed | accepted | rejected | deprecated | superseded by NNNN`)
    }
    else if (status.startsWith('superseded')) {
      // A bare "superseded" (no "by NNNN") already failed the vocabulary check above; the
      // link is demanded once the status is otherwise well-formed, and its target once the
      // link is, so one underlying problem is reported once.
      const link = status.match(SUPERSEDED_LINK_RE)
      if (!link)
        errors.push(`${where}: superseded status must link the newer record: "superseded by [NNNN](./NNNN-slug.md)"`)
      else if (!existsSync(join(decisionsDir, link[2]!)))
        errors.push(`${where}: superseded-by target ${link[2]} does not exist`)
    }

    const date = text.match(DATE_BULLET_RE)?.[1]?.trim()
    if (!date || !isRealIsoDate(date))
      errors.push(`${where}: missing or non-real "- **Date:** YYYY-MM-DD" bullet`)
  }

  const indexPath = join(decisionsDir, 'index.md')
  if (!existsSync(indexPath))
    errors.push(`${DECISIONS_DIR}/index.md: missing index page`)
  else if (!readFileSync(indexPath, 'utf8').includes('<!-- automd:decisionsIndex -->'))
    errors.push(`${DECISIONS_DIR}/index.md: missing <!-- automd:decisionsIndex --> marker`)
  return decisionFiles.length
}

// --- specs -------------------------------------------------------------------
/** Validates the specs layout (areas, flatness), every spec page, and the specs index. */
function checkSpecs(): void {
  const specsDir = join(root, SPECS_DIR)
  if (!existsSync(specsDir)) {
    console.log(`  (${SPECS_DIR}: not present, skipped)`)
    return
  }
  for (const area of readdirSync(specsDir, { withFileTypes: true })) {
    if (!area.isDirectory()) {
      // A stray top-level spec would be invisible to the index, the sidebar, and
      // every check below — reject it instead of silently ignoring it.
      if (area.name.endsWith('.md') && area.name !== 'index.md' && !area.name.startsWith('_'))
        errors.push(`${SPECS_DIR}/${area.name}: specs must live in an area directory (specs/<area>/<name>.md)`)
      continue
    }
    for (const entry of readdirSync(join(specsDir, area.name), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A spec nested below the area (specs/<area>/<sub>/<name>.md) is invisible
        // to the index, sidebar, and every check here — reject it. Asset folders
        // (e.g. images/) hold no markdown and pass silently.
        for (const nested of nestedMarkdown(join(specsDir, area.name, entry.name)))
          errors.push(`${SPECS_DIR}/${area.name}/${entry.name}/${nested}: specs must be flat within an area (specs/<area>/<name>.md); nested specs are invisible to the index`)
        continue
      }
      const file = entry.name
      if (!file.endsWith('.md') || file.startsWith('_'))
        continue
      checkSpecPage(`${SPECS_DIR}/${area.name}/${file}`, readFileSync(join(specsDir, area.name, file), 'utf8'))
    }
  }

  const indexPath = join(specsDir, 'index.md')
  if (!existsSync(indexPath))
    errors.push(`${SPECS_DIR}/index.md: missing index page`)
  else if (!readFileSync(indexPath, 'utf8').includes('<!-- automd:specIndex -->'))
    errors.push(`${SPECS_DIR}/index.md: missing <!-- automd:specIndex --> marker`)
}

// --- automd regions ------------------------------------------------------------
// The regions `pnpm docs:gen` writes, rendered on demand from the same readers automd
// uses. Any other generator name is checked for shape only.
const RENDERERS: Record<string, () => string> = {
  decisionsIndex: () => renderDecisionsIndex(readDecisions(root)),
  specIndex: () => renderSpecIndex(readSpecs(root)),
}
const rendered = new Map<string, string>()

/** Region text as compared: trailing whitespace off every line, the blank lines automd pads with dropped. */
function normalizeRegion(s: string): string {
  const lines = s.split('\n').map(l => l.trimEnd())
  while (lines.length > 0 && lines[0] === '')
    lines.shift()
  while (lines.length > 0 && lines.at(-1) === '')
    lines.pop()
  return lines.join('\n')
}

function renderedRegion(name: string): string | undefined {
  const render = RENDERERS[name]
  if (!render)
    return undefined
  let out = rendered.get(name)
  if (out === undefined) {
    out = normalizeRegion(render())
    rendered.set(name, out)
  }
  return out
}

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name))) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name))
      out.push(...markdownFiles(join(dir, e.name)))
    else if (e.isFile() && e.name.endsWith('.md'))
      out.push(join(dir, e.name))
  }
  return out
}

/**
 * Every automd region under docs/: closed, free of automd's warning comment, and for the
 * two index generators equal to what the generator renders now. The stale comparison is
 * the only check that sees a hand-edited or forgotten region outside the git drift gate:
 * automd rewrites a warning comment byte-identically, and a marker outside automd's
 * `input` is never rewritten at all. Line endings are normalized first, so a CRLF checkout
 * compares equal.
 */
function checkAutomdMarkers(): void {
  const docsDir = join(root, 'docs')
  if (!existsSync(docsDir)) {
    console.log('  (docs/: not present, skipped)')
    return
  }
  for (const file of markdownFiles(docsDir)) {
    const where = posixRelative(root, file)
    const text = readFileSync(file, 'utf8').replace(CRLF_RE, '\n')
    const close = new RegExp(AUTOMD_CLOSE_RE.source, AUTOMD_CLOSE_RE.flags)
    let pos = 0
    for (const open of text.matchAll(AUTOMD_OPEN_RE)) {
      // An opener inside an earlier region's body belongs to that region, as automd reads it.
      if (open.index < pos)
        continue
      const marker = `<!-- automd:${open[1]} -->`
      const from = open.index + open[0].length
      close.lastIndex = from
      const closed = close.exec(text)
      // Without a close the region runs to end-of-file: over-scanning is the safe direction
      // for the sentinel, and the region is already malformed.
      const body = text.slice(from, closed?.index)
      pos = closed ? closed.index + closed[0].length : text.length
      if (!closed)
        errors.push(`${where}: missing <!-- /automd --> after ${marker} (line ${text.slice(0, open.index).split('\n').length})`)
      if (body.includes(AUTOMD_WARNING)) {
        errors.push(`${where}: automd generator failed and wrote a warning comment into the ${marker} region. Fix the generator, re-run \`pnpm docs:gen\`, and never commit the warning — once committed it regenerates identically and the drift gate goes green.`)
        continue
      }
      if (!closed)
        continue
      const want = renderedRegion(open[1]!)
      if (want !== undefined && normalizeRegion(body) !== want)
        errors.push(`${where}: ${marker} region is stale — run \`pnpm docs:gen\``)
    }
  }
}

// --- template contracts --------------------------------------------------------
// Template mechanics are specified under docs/template (sync-template.md, …): any page
// there that carries a Source bullet is held to the same Source/Tests/Last reviewed rules.
function checkTemplateContracts(): void {
  const dir = join(root, 'docs/template')
  if (!existsSync(dir))
    return
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md')).sort(byCodeUnit)) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (SOURCE_BULLET_RE.test(stripFences(text)))
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
checkAutomdMarkers()
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
