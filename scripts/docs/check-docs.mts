/**
 * Structural lint for the decisions/specs system — enforces the couplings that
 * generation cannot: record format (a dated YYYYMMDD- name with a real date from 2000 on,
 * not ahead, and a title-only H1, or a legacy NNNN- name whose H1 and number match; a
 * hyphenated date in a name is rejected), metadata bullets, a Status keyword matched whole,
 * supersede links naming the target's ID and the record they point at (never the record
 * itself), spec Source/Tests values naming at least one path and every path resolving on disk
 * in the case written (a `:line` or `#L` suffix dropped first, route-file names such as
 * `[slug]/+page.ts` included, on the bullet's line or an indented line it wraps onto),
 * review-date freshness (a template-owned page's stale warning tells a child to sync), both
 * index pages present, every automd
 * region under docs/ closed, free of automd's warning comment and of merge conflict lines,
 * and current with the generators, no page under docs/ left mid-merge, the template-owned
 * contract pages that follow the spec shape, the agent-skills mirror, and the AGENTS.md
 * line budget. An index page need not carry a region: the lists are read from the files.
 *
 * Blocking errors exit 1; warnings print but pass (GitHub annotations in CI). A
 * missing docs, decisions, specs, or template directory is skipped with a note, so the
 * checker also runs in a repo that synced scripts/docs without the docs layout.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { INDEX_RENDERERS } from './readers.mts'
import { AUTOMD_WARNING, automdRegions, byCodeUnit, CONFLICT_LINE_RE, CONFLICT_OPEN_RE, DECISION_H1_RE, decisionIdentity, DECISIONS_DIR, H1_RE, LINE_COMMENT_RE, markdownFiles, pathCase, repoRoot, SKIP_DIRS, SPECS_DIR, STATUS_BULLET_RE, stripFences, WARN } from './root.mts'
import { posixRelative, skillDrift, SKILLS_SOURCE, SKILLS_TARGET } from './skills.mts'

const STALE_DAYS = 180
// The four plain keywords match the whole value, so "acceptedd" or "accepted, mostly" is
// refused; a "superseded by [ID](./…)" status carries a trailing markdown link, so that branch
// matches its leading words only. Both ID shapes open with four digits, NNNN and YYYYMMDD-slug
// alike. Tested on the value with HTML comments dropped.
const STATUS_VOCAB = /^(?:(?:proposed|accepted|rejected|deprecated)$|superseded by \[?\d{4}\]?)/
// Prefix-anchored like STATUS_VOCAB, so trailing text stays accepted; group 1 is the link
// text, which must be the target's ID, and group 2 the target filename.
const SUPERSEDED_LINK_RE = /^superseded by \[([^\]\n]+)\]\(\.\/([^)\s]+)\)/
// What a dated record's H1 must not open with: a number and a dot (a legacy H1, or the old
// template's `NNNN.` placeholder left in place) or a date, compact or hyphenated. The lists
// add the date themselves; a bare number, as in "# 3 regions", is still a title.
const LABELLED_TITLE_RE = /^(?:\d+|N{4})\.\s|^\d{4}-?\d{2}-?\d{2}\b/
// A name opening with a hyphenated date, padded or not, with or without a day or a slug
// (2026-09-29-x, 2026-9-29-x, 2026-09-29.md): it has the legacy shape and would read as
// record YYYY, so it is rejected, with the compact form when the date is real. Only from
// DATE_FROM_YEAR: no repository numbers its records that high, while a legacy record such as
// 0003-12-01-cutoff.md must stay valid.
const HYPHENATED_DATE_NAME_RE = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:-|\.md$)/
// The earliest year a filename date may carry. A dated name records the day it was created,
// so an earlier year is a typo, and it would move the numbered-by-habit switch back with it.
const DATE_FROM_YEAR = 2000
const DATE_BULLET_RE = /^- \*\*Date:\*\*(.*)$/m
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True only for a well-formed AND calendar-real ISO date — rejects 2026-02-30 / 2026-13-01. */
function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s))
    return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Days from a real ISO date to now; negative for a date ahead. */
function ageInDays(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

/**
 * True when a real ISO date lies more than a day ahead. The date is a calendar day parsed
 * as UTC midnight, while Date.now() is an instant, so today's date written east of UTC reads
 * as slightly in the future until UTC catches up; a full day of tolerance keeps the check
 * for real typos (a wrong year) only.
 */
function isFuture(iso: string): boolean {
  return ageInDays(iso) < -1
}
const BACKTICK_PATH_RE = /`([^`]+)`/g
// The characters a cited path may hold: word characters, `@./-`, and the route-file syntax
// of SvelteKit, Next.js, and Remix: `+page.svelte`, `[slug]`, `[page=fruit]`, `(group)`,
// `$id.tsx`, and a `%5F` escape.
const PATH_CHARS_RE = /^[\w@./+$()[\]=%-]+$/
const EXTENSION_RE = /\.\w+$/
// A line reference after a cited path, `src/a.ts:42`, `:42-50`, `:42:7`, or `#L42-L50`: dropped
// before the existence check, so the path itself is still verified.
const LINE_SUFFIX_RE = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/
const REVIEWED_BULLET_RE = /^- \*\*Last reviewed:\*\*\s*(\d{4}-\d{2}-\d{2})/m
const SOURCE_BULLET_RE = /^- \*\*Source:\*\*/m
// A line a metadata bullet wraps onto: indented, and not blank.
const CONTINUATION_RE = /^[ \t]+\S/
const PENDING = '(pending)'
// What a stale Last reviewed date asks for. A template-owned page is edited only in the
// template: a child that has not synced a newer copy syncs one, never re-reviews the page.
const SPEC_STALE = 're-verify against the source'
const TEMPLATE_STALE = 'template-owned: in the template, re-verify and bump the date; in a child, run `pnpm sync:template` and never edit the page'
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

/**
 * The value of a spec page's `- **Source:**` or `- **Tests:**` bullet: the rest of its line
 * and each indented line it wraps onto, up to a blank or unindented line, joined with spaces,
 * so a comment that wraps reads whole and a path on a wrapped line is checked; a path broken
 * inside its backticks reads with a space and is not a path. Empty for an empty bullet, which
 * never takes the next bullet as its value; undefined when there is no such bullet.
 */
function bulletValue(text: string, bullet: 'Source' | 'Tests'): string | undefined {
  const opener = `- **${bullet}:**`
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.startsWith(opener))
  if (at < 0)
    return undefined
  const parts = [lines[at]!.slice(opener.length)]
  for (let i = at + 1; i < lines.length && CONTINUATION_RE.test(lines[i]!); i++)
    parts.push(lines[i]!)
  return parts.map(part => part.trim()).join(' ').trim()
}

/**
 * The Source, Tests, and Last reviewed bullets of a spec-shaped page: paths resolve, the date
 * is real and fresh. `stale` is what a date past STALE_DAYS asks the reader to do.
 */
function checkSpecPage(where: string, raw: string, stale = SPEC_STALE): void {
  const text = stripFences(raw)
  for (const bullet of ['Source', 'Tests'] as const) {
    const line = bulletValue(text, bullet)
    if (line === undefined) {
      errors.push(`${where}: missing "- **${bullet}:** ..." bullet`)
      continue
    }
    // The visible value, comments dropped. It is pending only when it says so up front; a
    // path followed by the word is still checked.
    const value = line.replace(LINE_COMMENT_RE, '').trim()
    if (value.startsWith(PENDING)) {
      warnings.push(`${where}: ${bullet} is (pending) — fill it when the code lands`)
      continue
    }
    let paths = 0
    for (const [, token] of value.matchAll(BACKTICK_PATH_RE)) {
      // A Source/Tests value may cite a test name beside its path, e.g. `src/foo.ts` (`add`).
      // Only a path-shaped token is existence-checked: path characters throughout, route-file
      // syntax included, and either a `/` or an extension; a bare identifier is a name, not a
      // path. Every path-shaped token is checked, on the bullet's line or a line it wraps onto.
      const p = token!.replace(LINE_SUFFIX_RE, '')
      if (!PATH_CHARS_RE.test(p) || !(p.includes('/') || EXTENSION_RE.test(p)))
        continue
      paths++
      const found = pathCase(root, join(root, p))
      if (found === 'missing')
        errors.push(`${where}: ${bullet} path \`${token}\` does not exist`)
      else if (found !== 'exact')
        errors.push(`${where}: ${bullet} path \`${token}\` is ${found} on disk; the case must match, or Linux CI fails it`)
    }
    // A value naming no backticked path is checked against nothing: a bare path, a glob, or
    // "TBD" would pass forever.
    if (paths === 0)
      errors.push(`${where}: ${bullet} names no path to check — write the repo-relative path in backticks (\`src/feature.ts\`), or ${PENDING} before the code exists`)
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
  else if (isFuture(reviewed)) {
    warnings.push(`${where}: last reviewed ${reviewed} is in the future — likely a year typo`)
  }
  else if (ageInDays(reviewed) > STALE_DAYS) {
    warnings.push(`${where}: last reviewed ${reviewed} (> ${STALE_DAYS} days ago) — ${stale}`)
  }
}

// --- decisions -------------------------------------------------------------
/**
 * Validates every decision record and that the decisions index page exists; returns the
 * record count (0 when the directory is absent). A dated name cannot collide across
 * branches, so only legacy numbers are checked for duplicates.
 */
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
  // For the numbered-by-habit warning: each legacy record's Date, and the filename date of
  // every dated record, which is its creation day and so never earlier than the switch.
  const legacyDates: { where: string, date: string }[] = []
  let firstDated: { file: string, date: string } | undefined

  for (const file of decisionFiles) {
    const where = `${DECISIONS_DIR}/${file}`
    const identity = decisionIdentity(file)
    if (!identity) {
      errors.push(`${where}: filename must be YYYYMMDD-kebab-title.md (a legacy NNNN-kebab-title.md stays valid)`)
      continue
    }
    const hyphenated = file.match(HYPHENATED_DATE_NAME_RE)
    if (hyphenated && Number(hyphenated[1]) >= DATE_FROM_YEAR) {
      const [, year, month, day] = hyphenated
      const iso = day === undefined ? '' : `${year}-${month!.padStart(2, '0')}-${day.padStart(2, '0')}`
      const compact = isRealIsoDate(iso) ? ` (${iso.replaceAll('-', '')})` : ''
      errors.push(`${where}: filename must be YYYYMMDD-kebab-title.md, the date without hyphens${compact}; as written it reads as legacy record ${identity.id}`)
      continue
    }
    if (identity.legacy) {
      if (seenNums.has(identity.id))
        errors.push(`${where}: duplicate decision number ${identity.id} (also ${seenNums.get(identity.id)}) — rename the record not yet on the default branch to YYYYMMDD-kebab-title.md with a title-only H1`)
      seenNums.set(identity.id, file)
    }
    else {
      const compact = file.slice(0, 8)
      if (!isRealIsoDate(identity.label)) {
        errors.push(`${where}: filename date ${compact} is not a real calendar date`)
        continue
      }
      if (isFuture(identity.label))
        errors.push(`${where}: filename date ${compact} is in the future`)
      else if (Number(compact.slice(0, 4)) < DATE_FROM_YEAR)
        errors.push(`${where}: filename date ${compact} is before ${DATE_FROM_YEAR}; a dated name carries the day the record was created`)
      else if (!firstDated || identity.label < firstDated.date)
        firstDated = { file, date: identity.label }
    }

    // Fences blanked, as the readers do, so a fenced example cannot pose as the H1 or Status.
    const text = stripFences(readFileSync(join(decisionsDir, file), 'utf8'))
    if (identity.legacy) {
      const h1 = text.match(DECISION_H1_RE)
      if (!h1)
        errors.push(`${where}: H1 must be "# ${identity.id}. Title"`)
      else if (h1[1] !== identity.id)
        errors.push(`${where}: H1 number ${h1[1]} does not match filename ${identity.id}`)
    }
    else {
      const h1 = text.match(H1_RE)?.[1]?.trim()
      if (!h1 || LABELLED_TITLE_RE.test(h1))
        errors.push(`${where}: H1 must be "# Title", the title alone (a dated record's H1 carries no number or date)`)
    }

    const status = text.match(STATUS_BULLET_RE)?.[1]?.replace(LINE_COMMENT_RE, '').trim()
    if (!status) {
      errors.push(`${where}: missing "- **Status:** ..." bullet`)
    }
    else if (!STATUS_VOCAB.test(status)) {
      errors.push(`${where}: status "${status}" not in vocabulary: proposed | accepted | rejected | deprecated | superseded by [ID](./file.md)`)
    }
    else if (status.startsWith('superseded')) {
      // A bare "superseded" (no "by ID") already failed the vocabulary check above; the
      // link is demanded once the status is otherwise well-formed, its text once the link
      // names a record, and its target once the text is right, so one underlying problem is
      // reported once.
      const link = status.match(SUPERSEDED_LINK_RE)
      const target = link ? decisionIdentity(link[2]!) : undefined
      if (!link || !target)
        errors.push(`${where}: superseded status must link the newer record: "superseded by [ID](./file.md)"`)
      else if (link[1] !== target.id)
        errors.push(`${where}: superseded-by link text "${link[1]}" must be ${target.id}, the ID of ./${link[2]}`)
      else if (link[2] === file)
        errors.push(`${where}: superseded-by link points at this record itself — link the newer record that replaces it`)
      else if (!existsSync(join(decisionsDir, link[2]!)))
        errors.push(`${where}: superseded-by target ./${link[2]} does not exist`)
    }

    const date = text.match(DATE_BULLET_RE)?.[1]?.trim()
    if (!date || !isRealIsoDate(date))
      errors.push(`${where}: missing or non-real "- **Date:** YYYY-MM-DD" bullet`)
    else if (identity.legacy)
      legacyDates.push({ where, date })
  }

  // A numbered record dated after the first dated one was most likely created by habit, from
  // stale prose, and can collide with another branch's number as before. The dates alone
  // cannot tell that from a dated record named for a day before it was created, so the
  // warning names both. A warning, not an error: once either record is on the default branch
  // it stays, as every accepted record does.
  if (firstDated) {
    for (const { where, date } of legacyDates) {
      if (date > firstDated.date)
        warnings.push(`${where}: numbered record dated ${date}, after the first dated record ${firstDated.file} was created. Either this record was numbered by habit: new records are YYYYMMDD-kebab-title.md, so unless it is already on the default branch, rename it and drop the number from its H1. Or ${firstDated.file} is named for a day before it was created: unless it is already on the default branch, rename it to its creation day.`)
    }
  }

  if (!existsSync(join(decisionsDir, 'index.md')))
    errors.push(`${DECISIONS_DIR}/index.md: missing index page`)
  return decisionFiles.length
}

// --- specs -------------------------------------------------------------------
/** Validates the specs layout (areas, flatness), every spec page, and that the specs index page exists. */
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

  if (!existsSync(join(specsDir, 'index.md')))
    errors.push(`${SPECS_DIR}/index.md: missing index page`)
}

// --- automd regions ------------------------------------------------------------
// The regions `pnpm docs:gen` writes, rendered on demand from the same readers automd
// uses. Any other generator name is checked for shape only.
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
  const render = INDEX_RENDERERS[name]
  if (!render)
    return undefined
  let out = rendered.get(name)
  if (out === undefined) {
    out = normalizeRegion(render(root))
    rendered.set(name, out)
  }
  return out
}

const NON_NEWLINE_RE = /[^\n]/g

/**
 * Every automd region under docs/: closed, free of automd's warning comment and of merge
 * conflict lines, and for the two index generators equal to what the generator renders now.
 * The stale comparison is the only check that sees a hand-edited or forgotten region outside
 * the git drift gate: automd rewrites a warning comment byte-identically, and a marker
 * outside automd's `input` is never rewritten at all. A conflicted region is named as such,
 * since the fix is to regenerate it, not to merge it by hand. Outside the regions, and outside
 * fences, a `<<<<<<<` line is a conflict left unresolved. Line endings are normalized first,
 * so a CRLF checkout compares equal.
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
    const regions = automdRegions(text)
    for (const region of regions) {
      const marker = `<!-- automd:${region.name} -->`
      // Without a close the region runs to end-of-file: over-scanning is the safe direction
      // for the sentinel, and the region is already malformed.
      const body = text.slice(region.bodyStart, region.bodyEnd)
      if (!region.closed)
        errors.push(`${where}: missing <!-- /automd --> after ${marker} (line ${text.slice(0, region.start).split('\n').length})`)
      if (body.includes(AUTOMD_WARNING)) {
        errors.push(`${where}: automd generator failed and wrote a warning comment into the ${marker} region. Fix the generator, re-run \`pnpm docs:gen\`, and never commit the warning — once committed it regenerates identically and the drift gate goes green.`)
        continue
      }
      if (body.split('\n').some(line => CONFLICT_LINE_RE.test(line))) {
        // An index region conflicts again on the next pair of branches that each add an entry;
        // the lasting fix is to drop it, since the sidebar and docs:list read the files.
        const lasting = Object.hasOwn(INDEX_RENDERERS, region.name) ? '. To stop the next conflict, delete the region: the handbook sidebar and `pnpm docs:list` read the list from the files' : ''
        errors.push(`${where}: ${marker} region holds merge conflict lines — regenerate it with \`pnpm docs:gen\`; never hand-merge a generated region${lasting}`)
        continue
      }
      if (!region.closed)
        continue
      const want = renderedRegion(region.name)
      if (want !== undefined && normalizeRegion(body) !== want)
        errors.push(`${where}: ${marker} region is stale — run \`pnpm docs:gen\``)
    }
    // Region bodies blanked, line count kept, so a conflict inside one is reported once, above.
    let outside = text
    for (const region of regions.toReversed())
      outside = outside.slice(0, region.bodyStart) + outside.slice(region.bodyStart, region.bodyEnd).replace(NON_NEWLINE_RE, '') + outside.slice(region.bodyEnd)
    stripFences(outside).split('\n').forEach((line, i) => {
      if (CONFLICT_OPEN_RE.test(line))
        errors.push(`${where}: unresolved merge conflict marker (line ${i + 1}) — resolve the conflict and delete the markers`)
    })
  }
}

// --- template contracts --------------------------------------------------------
// Template mechanics are specified under docs/template (sync-template.md, …): any page
// there that carries a Source bullet is held to the same Source/Tests/Last reviewed rules.
// A stale date names the template-owned remedy, since a child never edits these pages.
function checkTemplateContracts(): void {
  const dir = join(root, 'docs/template')
  if (!existsSync(dir))
    return
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md')).sort(byCodeUnit)) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (SOURCE_BULLET_RE.test(stripFences(text)))
      checkSpecPage(`docs/template/${file}`, text, TEMPLATE_STALE)
  }
}

// --- rulebooks ---------------------------------------------------------------
// AGENTS.md declares a hard 200-line budget for itself and every nested rulebook. A directory
// with its own `.git` entry (a linked worktree under .claude/worktrees, a nested clone, a
// submodule) is another checkout: its rulebook is its own, and another agent's half-finished
// edit there must not fail this one.
const RULEBOOK_BUDGET = 200
function rulebooks(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !existsSync(join(dir, e.name, '.git')))
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
