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
 * contract pages that follow the spec shape, the agent-skills mirror, skill frontmatter Codex
 * can parse (what a nested block or a flow collection holds aside), and the AGENTS.md line
 * budget. An index page need not carry a region: the lists are read from the files.
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

// --- skill frontmatter -----------------------------------------------------------
// Codex parses a skill's frontmatter as YAML and skips a skill whose frontmatter fails to parse,
// with nothing the user sees, while Claude Code reads the same file leniently: the break shows in
// one tool only. It breaks in a value, a line's indentation, or a character, so each quoted or
// unquoted value is held to what parses unchanged. Node builtins only, no YAML parser: the check
// reads the shape skills use, top-level `key: value` lines, each value running on over its
// more-indented lines. A key holding a nested block map or list is not read further, and a flow
// collection (`[...]`, `{...}`) only for where it closes.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/
// A character libyaml refuses anywhere (a control character but a tab or a newline, DEL, a C1
// control, U+FFFE, U+FFFF), or one it reads as a line break where this check reads none (NEL,
// U+2028, U+2029, a lone CR, each of which also splits an unquoted value).
const YAML_BAD_CHAR_RE = /[^\t\n\x20-\x7E\u{A0}-\u{2027}\u{202A}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u
// A tab in a line's indentation, leading or after spaces: libyaml rejects one in block context,
// on a blank line too. So too any other space JavaScript's \s and trim() take but YAML reads as
// text (a no-break space, U+3000, a byte-order mark), which would otherwise pass as indentation
// or a blank line. Refusing every one also refuses a few shapes YAML takes, such as a plain
// value's continuation ` \tmore`; indenting with spaces only is always open.
const TAB_INDENT_RE = /^ *[^\S ]/
// The spaces and tabs at a line's ends, all YAML trims: it keeps any other space as text, so a
// no-break space after a closing quote, a closing bracket, or a block indicator is text there,
// which YAML rejects, and one around a name is part of it.
const YAML_TRIM_RE = /^[ \t]+|[ \t]+$/g
// The separators inside a flow collection: a space, a tab, a line break, and no other space.
const FLOW_SPACE_RE = /[ \t\n]/
const FRONTMATTER_KEY_RE = /^([\w-]+):(?:[ \t](.*))?$/
// A list item at column 0, which YAML takes as the value of an empty `key:` line above it.
const LIST_ITEM_RE = /^-(?:[ \t]|$)/
// Below an empty `key:` line, YAML reads a nested block when the first line opens a list item or
// is itself a `key:` line, the key plain or quoted. A plain key may hold spaces, and a `#` after
// a non-space; ` #` opens a comment.
const NESTED_START_RE = /^(?:-(?:\s|$)|(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{}|>@`%,](?:[ \t]*[^\s#]|#)*?)\s*:(?:\s|$))/
// In an unquoted value, `: ` or a line-final `:` opens a nested key, which YAML rejects, and
// ` #` opens a comment, which cuts the value short.
const PLAIN_BREAK_RE = /:(?:\s|$)|\s#/
// A first character YAML reserves: refused (`@`, a backtick, `%`, `*`, `,`, `]`, `}`, or `-`,
// `?`, `:` before a space) or read as an anchor or a tag (`&`, `!`), which drops it from the value.
const PLAIN_RESERVED_START_RE = /^(?:[@`%*,&!\]}]|[-?:](?:\s|$))/
// A block scalar's first line: `|` or `>`, an indent digit and a chomping sign in either order,
// each optional, then only a comment. Its text starts on the next line.
const BLOCK_HEADER_RE = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?$/
// A quoted value, its trimmed lines joined by newlines, closes at its end, with only comments
// after. Inside single quotes an apostrophe is written ''; inside double quotes a backslash opens
// one of YAML's escapes, a line break included, and nothing else, and a \u or \U escape names a
// Unicode character: libyaml rejects a surrogate (D800 to DFFF) and anything past 10FFFF.
const SINGLE_QUOTED_RE = /^'((?:[^']|'')*)'(?:[ \t]+#[^\n]*)?(?:\n#[^\n]*)*$/
const DOUBLE_QUOTED_RE = /^"((?:[^"\\]|\\[0abtnvfre "/\\N_LP\t\n]|\\x[0-9A-Fa-f]{2}|\\u(?![Dd][89A-Fa-f])[0-9A-Fa-f]{4}|\\U00(?:00(?![Dd][89A-Fa-f])[0-9A-Fa-f]{4}|0[1-9A-Fa-f][0-9A-Fa-f]{4}|10[0-9A-Fa-f]{4}))*)"(?:[ \t]+#[^\n]*)?(?:\n#[^\n]*)*$/
// A line's indentation: YAML counts spaces only.
const LEADING_SPACES_RE = /^ */
// What may follow a value's end: a comment on its line, then only comment lines.
const AFTER_VALUE_RE = /^(?:[ \t]+#[^\n]*)?(?:\n#[^\n]*)*$/
// An unquoted value YAML reads as null, a boolean, a number, or a date, under YAML 1.1 (libyaml)
// or 1.2, or as YAML 1.1's merge (`<<`) or value (`=`) key, which PyYAML's safe loader refuses
// to construct: not a string.
const NON_STRING_RE = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|<<|=|[-+]?(?:\d[\d_]*(?::[0-5]?\d)*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?|[-+]?0(?:x[\dA-Fa-f_]+|o[0-7_]+|b[01_]+)|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|\d{4}-\d\d-\d\d|\d{4}-\d\d?-\d\d?(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)$/

/**
 * A block scalar's lines below its header, each trimmed with its indentation in spaces beside
 * it: the text they hold, or why YAML rejects them. The header's indent digit, or else the first
 * text line, sets how far each text line is indented. Without an indent digit, a blank line above
 * the first text line may not hold more spaces than it. A line indented less ends the block, so
 * it must be a comment, and only comments may follow it.
 */
function readBlock(lines: string[], indents: number[], digit: string | undefined): { text: string } | { why: string } {
  const top = lines.findIndex(l => l !== '')
  if (top < 0)
    return { text: '' }
  const floor = digit === undefined ? indents[top] ?? 0 : Number(digit)
  if (digit === undefined && indents.slice(0, top).some(n => n > floor))
    return { why: 'with a blank line above its first text line that holds more spaces than that line, which YAML rejects; empty the blank line' }
  const body: string[] = []
  let ended = false
  for (const [i, line] of lines.entries()) {
    if (line === '' || (ended && line.startsWith('#')))
      continue
    if (ended)
      return { why: 'with text after a comment indented less than the block, which ends it, so YAML rejects the text; indent the comment with the text, or drop it' }
    if ((indents[i] ?? 0) >= floor)
      body.push(line)
    else if (line.startsWith('#'))
      ended = true
    else
      return { why: `with a line indented less than ${digit === undefined ? 'its first text line' : `the ${digit} spaces its header sets`}, which ends the block, so YAML rejects the line; indent every line at least as far` }
  }
  return { text: body.join(' ') }
}

/**
 * Whether a value opening with `[` or `{` closes that flow collection at its end, with only a
 * comment after it. Brackets inside a quoted scalar or a comment do not count; a quote opens a
 * scalar only where one may start, after an opening bracket, a comma, or a colon. Only a space,
 * a tab, or a line break separates, as in YAML, so a `#` after a no-break space is text. What
 * the collection holds is not judged.
 */
function flowCloses(value: string): boolean {
  const open: string[] = []
  let last = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if ((c === '"' || c === '\'') && '[{,:'.includes(last)) {
      // Skip to the closing quote: a backslash escapes inside double quotes, '' is an apostrophe inside single.
      for (i++; i < value.length; i++) {
        if (c === '"' && value[i] === '\\')
          i++
        else if (value[i] === c && !(c === '\'' && value[i + 1] === '\''))
          break
        else if (value[i] === c)
          i++
      }
      last = c
    }
    else if (c === '#' && (i === 0 || FLOW_SPACE_RE.test(value[i - 1]!))) {
      const end = value.indexOf('\n', i)
      i = end < 0 ? value.length : end - 1
    }
    else if (c === '[' || c === '{') {
      open.push(c === '[' ? ']' : '}')
      last = c
    }
    else if (c === ']' || c === '}') {
      if (open.pop() !== c)
        return false
      if (open.length === 0)
        return AFTER_VALUE_RE.test(value.slice(i + 1))
      last = c
    }
    else if (!FLOW_SPACE_RE.test(c)) {
      last = c
    }
  }
  return false
}

/**
 * Every `.claude/skills/<dir>/SKILL.md` opens with a closed frontmatter block whose `name` is
 * `<dir>`, written as no block scalar, and whose `description` is a non-empty string; every line
 * in it is a top-level `key: value` (each key set once), a continuation indented with spaces, a
 * list item under an empty `key:`, a comment, or blank; no line's indentation holds a tab or
 * another space YAML reads as text (a no-break space, U+3000, a byte-order mark), a blank line's
 * included, which also refuses a few such shapes YAML takes; a value is trimmed of spaces and
 * tabs alone, as YAML trims it; the block holds no character YAML rejects or reads as a line
 * break; no quoted or unquoted value holds what YAML rejects or reads differently; a block
 * scalar's lines keep its indentation; and a flow collection closes at its value's end. A key
 * holding a nested block map or list is not read further, nor what a flow collection holds. The
 * mirror is byte for byte the same, so the source alone is read.
 */
function checkSkillFrontmatter(): void {
  const dir = join(root, SKILLS_SOURCE)
  if (!existsSync(dir))
    return
  for (const skill of readdirSync(dir).sort(byCodeUnit)) {
    const file = join(dir, skill, 'SKILL.md')
    if (!existsSync(file))
      continue
    const where = `${SKILLS_SOURCE}/${skill}/SKILL.md`
    const block = readFileSync(file, 'utf8').replace(CRLF_RE, '\n').match(FRONTMATTER_RE)?.[1]
    if (block === undefined) {
      errors.push(`${where}: no frontmatter — open the file with a --- line, then \`name: ${skill}\` and \`description: ...\`, then a closing --- line`)
      continue
    }
    // Such a character breaks the lines read below, so it is reported alone.
    const bad = YAML_BAD_CHAR_RE.exec(block)
    if (bad) {
      const code = bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
      errors.push(`${where}: line ${block.slice(0, bad.index).split('\n').length + 1}, in the frontmatter, holds U+${code}, a character YAML rejects or reads as a line break; remove it`)
      continue
    }
    // Each top-level key's value, one entry per line: the text after `key:`, then each
    // more-indented line below it, trimmed of spaces and tabs; a blank line stays as ''. Below an
    // empty `key:`, a column-0 comment stays too, since the value may still follow it, and so do
    // column-0 list items, which YAML nests under the key.
    const values = new Map<string, string[]>()
    // Each value line's indentation in spaces, in step with its entry in values; a block scalar
    // reads it.
    const margins = new Map<string[], number[]>()
    // The values a line with a tab in its indentation continues: that line's error stands for
    // them, so they are not judged further.
    const tabbed = new Set<string[]>()
    let current: string[] | undefined
    let listAtKey = false
    const stray = (i: number, why: string): void => {
      errors.push(`${where}: line ${i + 2}, in the frontmatter, ${why}`)
      current = undefined
    }
    const add = (text: string, margin: number): void => {
      if (current) {
        current.push(text)
        margins.get(current)?.push(margin)
      }
    }
    block.split('\n').forEach((line, i) => {
      const key = FRONTMATTER_KEY_RE.exec(line)
      if (key) {
        if (values.has(key[1]!))
          errors.push(`${where}: line ${i + 2} sets ${key[1]} a second time, which YAML rejects; keep one`)
        // A comment right after `key:` leaves the value empty on that line.
        const inline = (key[2] ?? '').replace(YAML_TRIM_RE, '')
        current = [inline.startsWith('#') ? '' : inline]
        margins.set(current, [0])
        listAtKey = false
        values.set(key[1]!, current)
      }
      else if (TAB_INDENT_RE.test(line)) {
        const c = TAB_INDENT_RE.exec(line)![0].at(-1)!
        const what = c === '\t' ? 'a tab' : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} (a space YAML reads as text)`
        if (line.trim() === '') {
          errors.push(`${where}: line ${i + 2}, in the frontmatter, is blank but holds ${what}, which YAML rejects; empty the line`)
          add('', 0)
        }
        else {
          errors.push(`${where}: line ${i + 2}, in the frontmatter, holds ${what} in its indentation, which YAML rejects; indent it with spaces only`)
          if (current)
            tabbed.add(current)
        }
      }
      // Past the branch above, a line's indentation is spaces alone.
      else if (line.replace(YAML_TRIM_RE, '') === '') {
        add('', LEADING_SPACES_RE.exec(line)![0].length)
      }
      else if (line.startsWith(' ') && current) {
        add(line.replace(YAML_TRIM_RE, ''), LEADING_SPACES_RE.exec(line)![0].length)
      }
      else if (LIST_ITEM_RE.test(line) && current?.[0] === '' && (listAtKey || current.every(l => l === '' || l.startsWith('#')))) {
        listAtKey = true
        add(line, 0)
      }
      else if (line.startsWith('#')) {
        if (current?.[0] === '')
          add(line, 0)
        else
          current = undefined
      }
      else {
        stray(i, 'is not a top-level `key: value` line, so YAML fails to parse the block; indent it under its key, or write it as `key: value`')
      }
    })

    // What each value reads as. A value that YAML rejects or reads as other than a string is
    // reported once, under its key, and then not judged as a name or a description.
    const text = new Map<string, string>()
    const broken = new Set<string>()
    const fail = (key: string, why: string): void => {
      errors.push(`${where}: ${key} ${why}`)
      broken.add(key)
    }
    for (const [key, lines] of values) {
      if (tabbed.has(lines)) {
        broken.add(key)
        continue
      }
      // Below an empty `key:`, the blank and comment lines before the value are no part of it.
      const start = lines[0] === '' ? lines.findIndex((l, i) => i > 0 && l !== '' && !l.startsWith('#')) : 0
      const shown = start < 0 ? [] : lines.slice(start).filter(l => l !== '')
      const first = shown[0] ?? ''
      if (first === '') {
        text.set(key, '')
        continue
      }
      if ((lines[0] === '' && NESTED_START_RE.test(first)) || /^[[{]/.test(first)) {
        if (key === 'name' || key === 'description')
          fail(key, `must be a string, not a nested map or list, which YAML reads from a "[" or "{" opening the value, or from a first line below \`${key}:\` that opens with "- " or holds ": "; reword it, or quote the whole value`)
        else if (/^[[{]/.test(first) && !flowCloses(shown.join('\n')))
          fail(key, `opens a flow collection with "${first[0]}" that does not close at the end of the value, which YAML rejects; close it there, or quote the whole value`)
        continue
      }
      if (/^[|>]/.test(first)) {
        if (!BLOCK_HEADER_RE.test(first)) {
          fail(key, `opens a block scalar with "${first}", which YAML rejects: only an indent digit, a chomping sign, and a comment may follow the "${first[0]}"; move the text to the indented lines below`)
          continue
        }
        // The header sits at start; the block's lines follow it. Its indent digit, if any, sits
        // right after the indicator or the chomping sign, never in its comment.
        const read = readBlock(lines.slice(start + 1), (margins.get(lines) ?? []).slice(start + 1), /^[|>][+-]?(\d)/.exec(first)?.[1])
        if ('why' in read)
          fail(key, `is a block scalar ${read.why}`)
        // YAML keeps what the text read here drops: the line break that ends a block scalar
        // unless "-" strips it, a blank line above its text, the spaces past its indentation, and
        // those at a line's end. So a name is never read from one.
        else if (key === 'name' && read.text !== '')
          fail(key, `is a block scalar, whose line breaks and spaces YAML keeps, so it can differ from the directory's name; write \`name: ${skill}\` on one line`)
        else
          text.set(key, read.text)
        continue
      }
      if (/^["']/.test(first)) {
        const single = first.startsWith('\'')
        const quoted = (single ? SINGLE_QUOTED_RE : DOUBLE_QUOTED_RE).exec(shown.join('\n'))
        if (quoted)
          text.set(key, single ? quoted[1]!.replaceAll('\'\'', '\'') : quoted[1]!)
        else
          fail(key, 'is a quoted value YAML rejects: it must close at its end, with an apostrophe written \'\' inside single quotes and only YAML escapes inside double quotes')
        continue
      }
      // A comment line ends an unquoted value; YAML cannot place value text after one.
      const comment = shown.findIndex((l, i) => i > 0 && l.startsWith('#'))
      const plain = comment < 0 ? shown : shown.slice(0, comment)
      if (comment >= 0 && shown.slice(comment).some(l => !l.startsWith('#')))
        fail(key, 'continues after a comment line, which ends an unquoted value, so YAML rejects the lines after it; move the comment below the value, or drop it')
      else if (PLAIN_RESERVED_START_RE.test(first))
        fail(key, `opens with "${first[0]}", which YAML reserves at the start of an unquoted value; reword the start, or quote the whole value`)
      else if (PLAIN_BREAK_RE.test(plain.join('\n')))
        fail(key, 'is an unquoted value holding ": ", " #", or a colon at a line end, which YAML rejects or cuts short, and then Codex skips the skill; reword it (a comma where the colon was), or quote the whole value')
      else if ((key === 'name' || key === 'description') && NON_STRING_RE.test(plain.join(' ')))
        fail(key, 'is an unquoted value YAML reads as other than a string (null, a boolean, a number, a date, `<<`, or `=`); reword it, or quote it')
      else
        text.set(key, plain.join(' '))
    }

    if (!broken.has('name')) {
      const name = text.get('name')
      if (!name)
        errors.push(`${where}: frontmatter has no name — add \`name: ${skill}\`, the directory's name`)
      else if (name !== skill)
        errors.push(`${where}: name "${name}" must be the directory's name, "${skill}"`)
    }
    if (!broken.has('description') && !text.get('description')?.trim())
      errors.push(`${where}: frontmatter has no description, or an empty one — say what the skill does and when to use it; a tool reads it to decide when to load the skill`)
  }
}

const decisionCount = checkDecisions()
checkSpecs()
checkAutomdMarkers()
checkTemplateContracts()
checkRulebooks()
checkSkillsMirror()
checkSkillFrontmatter()

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
