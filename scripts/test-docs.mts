/**
 * Regression suite for the docs checkers (scripts/docs/check-docs.mts and
 * check-portability.mts) — the two densest regex files in the repo, whose comments each
 * record a past bug — plus the readers (readers.mts) called directly and the skills mirror
 * generator (gen-skills.mts). Copies a fixture tree (scripts/docs/fixtures/clean, /broken)
 * to a temp dir, runs each script with that cwd, and asserts the exit code and the messages.
 * Also pins the rulebook budget, the CI-annotation gating, a missing docs dir, the
 * three-step repo-root fallback, the stale-region comparison (with a CRLF checkout), the
 * skills mirror clean, drifted, generated, and absent, a region holding merge conflict
 * lines (named, then repaired by automd), dated and legacy decision records side by side (a
 * legacy-only table byte for byte as before), index pages without regions, `docs:list`, a
 * Status keyword matched whole, Source and Tests values with a line reference, a route-file
 * path (a param matcher and a `%5F` escape too), a wrapped line, or no path, a stale template
 * page's remedy, sidebar text escaped as HTML and a Status comment dropped by the readers,
 * fences nested in list items, inline code wrapped across lines, link targets spelled with a
 * space, percent-encoding, or the wrong case or starting on the next line, public pages that
 * link outside docs/public or to its root, symlinks out of docs/public (made at test time,
 * skipped where the platform refuses one), a VitePress include or snippet in every form
 * VitePress expands, reference definitions in quotes and list items (the destination on the
 * next line too, the label escaped or wrapped, a `[^label]:` one on a public page) but not a
 * `[Term]:` followed by prose, automd regions on a public page (filled by the installed automd
 * to show each refused one leaks, a `ſrc` key among them) and a multi-line automd opener, text
 * the checker must not blank (after an escaped backtick, where a list item, a quote, a
 * thematic break, a setext underline, a table's header row, or an HTML block's start ends the
 * paragraph a stray backtick opened, after a comment opener its paragraph never closes, below a
 * comment its quote or list item ends, below a `<!--` in indented code, space- or
 * tab-indented, below a backtick fence whose info string holds a backtick, in a mid-line
 * comment VitePress's grammar refuses: a `--` in it, `<!-->`, an escaped `<`, a table cell's
 * pipe, a code span opened first, a link's title holding it, a nested item's heading, a table,
 * or an HTML block ending the paragraph; and in blocks read as VitePress reads them: an HTML
 * block's lines, which hold no code span and no fence, a table's rows, split at their pipes,
 * and list items, lazy lines, and quotes as CommonMark nests them), while a comment that
 * grammar accepts stays hidden (holding a pipe, in a table cell or an HTML block, past a lone
 * `<br>`), a tab-indented fence in a list item, a quoted fence that ends with its quote, and the
 * property dated names exist for: two git branches that each add a record merge with no
 * conflict. The skill trees are planted in the copy at test time: a fixture under
 * `.claude/skills` would be listed as a live skill. Runs in CI on Ubuntu and Windows via
 * `pnpm test:docs`. Node builtins only; git runs with an isolated config; the automd runs
 * use the installed automd in a child process and are skipped, with a note, where automd is
 * not installed.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { decisionsSidebar, escapeCell, readDecisions, readSpecs, renderDecisionsIndex, specsSidebar } from './docs/readers.mts'
import { stripFences } from './docs/root.mts'
import { SKILLS_SOURCE, SKILLS_TARGET } from './docs/skills.mts'

const FIXTURES = join(import.meta.dirname, 'docs', 'fixtures')
const CHECKERS = {
  'docs:check': join(import.meta.dirname, 'docs', 'check-docs.mts'),
  'docs:portability': join(import.meta.dirname, 'docs', 'check-portability.mts'),
  'gen-skills': join(import.meta.dirname, 'docs', 'gen-skills.mts'),
  'docs:list': join(import.meta.dirname, 'docs', 'list-docs.mts'),
} as const
type Checker = keyof typeof CHECKERS

const tmp = mkdtempSync(join(tmpdir(), 'docs-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
let n = 0

/** A fresh copy of a fixture tree (mutations never touch the checked-in fixtures). */
function fixture(name: 'clean' | 'broken'): string {
  const dir = join(tmp, `${name}-${n++}`)
  cpSync(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

/** One skill file in a copy's source or mirror tree; planted here, never checked in. */
function plantSkill(dir: string, tree: typeof SKILLS_SOURCE | typeof SKILLS_TARGET, name: string, content: string): void {
  mkdirSync(join(dir, tree, name), { recursive: true })
  writeFileSync(join(dir, tree, name, 'SKILL.md'), content)
}

interface Run { status: number | null, out: string }
function run(checker: Checker, cwd: string, env: NodeJS.ProcessEnv = process.env, args: string[] = []): Run {
  const r = spawnSync(process.execPath, [CHECKERS[checker], ...args], { cwd, env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const fails: string[] = []
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok)
    fails.push(`${name}${detail ? ` — ${detail.trim().slice(0, 400)}` : ''}`)
}
function expectAll(name: string, out: string, wants: string[]): void {
  for (const want of wants)
    check(`${name}: ${want}`, out.includes(want), out)
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The copy with both index pages rewritten as pages that carry no region, the lists being read from the files. */
function withoutRegions(dir: string): string {
  writeFileSync(join(dir, 'docs/internal/decisions/index.md'), '# Decision records\n\nThe list is read from the files.\n')
  writeFileSync(join(dir, 'docs/internal/specs/index.md'), '# Specifications\n\nThe list is read from the files.\n')
  return dir
}

const today = new Date().toISOString().slice(0, 10)
const now = new Date()
/** Today in this machine's timezone, as a person or an agent naming a record today writes it. */
const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const CI_KEY = 'GITHUB_ACTIONS' // a const key: tsc refuses dot access on process.env, eslint refuses a bracketed literal
const withoutCi = { ...process.env }
delete withoutCi[CI_KEY]

// The installed automd, run the way `pnpm docs:gen` runs it but against a fixture copy: the
// fixtures' own automd.config.ts is an empty root marker, so the input glob and the two
// generators are passed in. Undefined where automd is not installed; its checks then skip.
let automdUrl: string | undefined
try {
  automdUrl = import.meta.resolve('automd')
}
catch {}
const GENERATORS_URL = pathToFileURL(join(import.meta.dirname, 'docs', 'generators.mts')).href
function runAutomd(cwd: string): Run {
  const code = [
    `const { automd } = await import(${JSON.stringify(automdUrl)})`,
    `const { decisionsIndex, specIndex } = await import(${JSON.stringify(GENERATORS_URL)})`,
    `await automd({ dir: process.cwd(), input: ['docs/**/*.md'], generators: { decisionsIndex, specIndex } })`,
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env: withoutCi, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// 1. The clean tree passes both checkers with nothing on stderr; the mirror is current.
{
  const dir = fixture('clean')
  for (const page of ['docs/internal/specs/cli/hello.md', 'docs/template/contract.md']) {
    const file = join(dir, page)
    writeFileSync(file, readFileSync(file, 'utf8').replace('2026-09-07', today))
  }
  plantSkill(dir, SKILLS_SOURCE, 'x', '# x\n')
  plantSkill(dir, SKILLS_TARGET, 'x', '# x\n')
  const c = run('docs:check', dir, withoutCi)
  check('clean docs:check exits 0', c.status === 0, c.out)
  check('clean docs:check counts records', c.out.includes('✔ docs:check — 4 decision(s)'), c.out)
  check('clean docs:check has no warnings', !c.out.includes('warning'), c.out)
  const p = run('docs:portability', dir, withoutCi)
  check('clean docs:portability exits 0', p.status === 0, p.out)
  check('clean docs:portability has no warnings', !p.out.includes('warning'), p.out)
}

// 2. The broken tree: every structural rule fires once, with its path. The mirror drifts
// in all three forms: a source without a copy, a copy that differs, a copy without a source.
{
  const dir = fixture('broken')
  plantSkill(dir, SKILLS_SOURCE, 'x', '# x\n')
  plantSkill(dir, SKILLS_SOURCE, 'y', '# y\n')
  plantSkill(dir, SKILLS_TARGET, 'x', '# x edited\n')
  plantSkill(dir, SKILLS_TARGET, 'z', '# z\n')
  const c = run('docs:check', dir, withoutCi)
  check('broken docs:check exits 1', c.status === 1, `status ${c.status}`)
  expectAll('broken docs:check', c.out, [
    'docs/internal/decisions/bad-name.md: filename must be YYYYMMDD-kebab-title.md (a legacy NNNN-kebab-title.md stays valid)',
    'docs/internal/decisions/0001-mismatch.md: H1 number 0002 does not match filename 0001',
    'status "unknown" not in vocabulary',
    '0001-mismatch.md: missing or non-real "- **Date:** YYYY-MM-DD" bullet',
    '0002-superseded.md: superseded status must link the newer record',
    '0003-missing-target.md: superseded-by target ./0004-nope.md does not exist',
    'docs/internal/decisions/0004-no-h1.md: H1 must be "# 0004. Title"',
    'docs/internal/decisions/0005-no-status.md: missing "- **Status:** ..." bullet',
    'duplicate decision number 0002',
    'duplicate decision number 0002 (also 0002-duplicate.md) — rename the record not yet on the default branch to YYYYMMDD-kebab-title.md with a title-only H1',
    'docs/internal/decisions/20260230-not-a-date.md: filename date 20260230 is not a real calendar date',
    'docs/internal/decisions/29990101-future.md: filename date 29990101 is in the future',
    'docs/internal/decisions/20260107-numbered-h1.md: H1 must be "# Title", the title alone (a dated record\'s H1 carries no number or date)',
    'docs/internal/decisions/20260111-no-h1.md: H1 must be "# Title", the title alone (a dated record\'s H1 carries no number or date)',
    // The old template's placeholder left in the H1, and a date the list adds itself.
    'docs/internal/decisions/20260112-placeholder-h1.md: H1 must be "# Title", the title alone (a dated record\'s H1 carries no number or date)',
    'docs/internal/decisions/20260113-dated-h1.md: H1 must be "# Title", the title alone (a dated record\'s H1 carries no number or date)',
    'docs/internal/decisions/19991231-too-early.md: filename date 19991231 is before 2000; a dated name carries the day the record was created',
    'docs/internal/decisions/20260108-bad-link.md: superseded-by link text "0003" must be 20260107-numbered-h1, the ID of ./20260107-numbered-h1.md',
    'docs/internal/decisions/20260109-missing-target.md: superseded-by target ./20260110-nope.md does not exist',
    'warning: docs:check: docs/internal/decisions/0006-late.md: numbered record dated 2026-06-01, after the first dated record 20260107-numbered-h1.md was created. Either this record was numbered by habit: new records are YYYYMMDD-kebab-title.md, so unless it is already on the default branch, rename it and drop the number from its H1. Or 20260107-numbered-h1.md is named for a day before it was created: unless it is already on the default branch, rename it to its creation day.',
    'docs/internal/conflicted.md: <!-- automd:specIndex --> region holds merge conflict lines — regenerate it with `pnpm docs:gen`; never hand-merge a generated region. To stop the next conflict, delete the region: the handbook sidebar and `pnpm docs:list` read the list from the files',
    'docs/internal/conflicted.md: unresolved merge conflict marker (line 3)',
    'automd generator failed and wrote a warning comment',
    'docs/internal/stale.md: <!-- automd:decisionsIndex --> region is stale — run `pnpm docs:gen`',
    'docs/internal/unclosed.md: missing <!-- /automd --> after <!-- automd:custom --> (line 3)',
    'docs/internal/specs/cli/no-source.md: missing "- **Source:** ..." bullet',
    'docs/internal/specs/stray.md: specs must live in an area directory',
    'docs/internal/specs/cli/stale.md: Source path `src/nope.txt` does not exist',
    'docs/internal/specs/cli/nested/deep.md: specs must be flat within an area',
    'docs/internal/specs/cli/no-review.md: missing "- **Last reviewed:**',
    'Tests is (pending)',
    'last reviewed 2020-01-01 (> 180 days ago)',
    'last reviewed 2999-01-01 is in the future',
    'docs/template/contract.md: Source path `scripts/nope.mts` does not exist',
    'docs/template/contract.md: Tests path `scripts/test-nope.mts` does not exist',
    'docs/template/contract.md: "- **Last reviewed:** 2026-02-30" is not a real calendar date',
    // A copy of the spec template that keeps its guidance comments, which mention "(pending)".
    'docs/internal/specs/cli/template-copy.md: Source path `src/missing.ts` does not exist',
    'docs/internal/specs/cli/template-copy.md: Tests path `test/missing.ts` does not exist',
    // A plain keyword matches whole, and a record cannot be superseded by itself.
    'docs/internal/decisions/20260114-near-keyword.md: status "acceptedd" not in vocabulary',
    'docs/internal/decisions/20260115-self-superseded.md: superseded-by link points at this record itself — link the newer record that replaces it',
    // A line reference is dropped before the path is checked, a value with no backticked
    // path is refused, and a path in the wrong case is named with the case on disk.
    'docs/internal/specs/cli/line-refs.md: Source path `src/nope.ts:42` does not exist',
    'docs/internal/specs/cli/line-refs.md: Tests path `test/nope.ts#L3-L5` does not exist',
    'docs/internal/specs/cli/no-path.md: Source names no path to check — write the repo-relative path in backticks (`src/feature.ts`), or (pending) before the code exists',
    'docs/internal/specs/cli/no-path.md: Tests names no path to check',
    'docs/internal/specs/cli/wrong-case.md: Source path `readme.md` is README.md on disk; the case must match, or Linux CI fails it',
    // A route file is a path, and a bullet is read with the indented lines it wraps onto; an
    // empty bullet names no path rather than taking the next bullet as its value.
    'docs/internal/specs/cli/routes.md: Source path `src/routes/(group)/+page.ts` does not exist',
    'docs/internal/specs/cli/routes.md: Source path `src/routes/[id=integer]/+page.svelte` does not exist',
    'docs/internal/specs/cli/routes.md: Tests path `app/routes/$id.tsx` does not exist',
    'docs/internal/specs/cli/routes.md: Tests path `app/%5Fprivate/page.tsx` does not exist',
    'docs/internal/specs/cli/wrapped.md: Source path `src/gone.ts` does not exist',
    'docs/internal/specs/cli/empty-source.md: Source names no path to check',
    // A stale spec is re-verified; a stale template page is the template's to re-verify, and a
    // child syncs it instead of editing it.
    'docs/internal/specs/cli/stale.md: last reviewed 2020-01-01 (> 180 days ago) — re-verify against the source',
    'docs/template/aged.md: last reviewed 2020-01-01 (> 180 days ago) — template-owned: in the template, re-verify and bump the date; in a child, run `pnpm sync:template` and never edit the page',
    '.agents/skills/y/SKILL.md: missing — run `pnpm docs:gen` to mirror .claude/skills',
    '.agents/skills/x/SKILL.md: differs from .claude/skills/x/SKILL.md — never hand-edit the mirror',
    '.agents/skills/z/SKILL.md: has no source under .claude/skills — run `pnpm docs:gen` to remove it',
  ])
  check('a path inside a comment that wraps is not checked', !c.out.includes('src/ignored.ts'), c.out)
  check('a template page\'s stale warning does not ask a child to re-verify it', !c.out.includes('docs/template/aged.md: last reviewed 2020-01-01 (> 180 days ago) — re-verify against the source'), c.out)
  check('a "(pending)" inside a comment is not a pending bullet', !c.out.includes('template-copy.md: Source is (pending)') && !c.out.includes('template-copy.md: Tests is (pending)'), c.out)
  check('an index page without a region is not an error', !c.out.includes('missing <!-- automd:'), c.out)
  check('a bad filename date is reported once, not also per bullet', c.out.split('20260230-not-a-date.md').length === 2, c.out)
  check('numbered records dated before the first dated record are not warned', !c.out.includes('0002-duplicate.md: numbered record dated'), c.out)
  check('a filename date before 2000 does not become the first dated record', !c.out.includes('after the first dated record 19991231-too-early.md'), c.out)
  check('a conflicted region is reported once, not also as stale or per marker', !c.out.includes('conflicted.md: <!-- automd:specIndex --> region is stale') && !c.out.includes('conflicted.md: unresolved merge conflict marker (line 11)'), c.out)
}

// 3. The broken tree: every portability rule fires with file:line.
{
  const dir = fixture('broken')
  const p = run('docs:portability', dir, withoutCi)
  check('broken docs:portability exits 1', p.status === 1, `status ${p.status}`)
  expectAll('broken docs:portability', p.out, [
    'README.md:1  YAML frontmatter',
    'README.md:6  Obsidian wikilink',
    'README.md:6  absolute link',
    'README.md:6  emoji shortcode',
    'README.md:6  raw HTML tag',
    'README.md:8  Vue interpolation',
    'README.md:10  broken relative link: ./missing.md',
    'README.md:12  VitePress container',
    'README.md:16  VitePress code snippet',
    'README.md:18  duplicate heading "Broken fixture" (also line 4)',
    'README.md:20  VitePress @include',
    'README.md:22  heading with backticks',
    'README.md:24  root-absolute inline link "/"',
    'README.md:26  absolute link "[abs]: /abs.md"',
    'README.md:28  broken anchor: ./AGENTS.md#nope (rule 1)',
    'README.md:31  second H1 "Second H1" (first at line 4)',
    'README.md:33  callout type "[!tip]"',
    'README.md:38  duplicate heading "Title" (also line 36)',
    'README.md:40  Vue interpolation',
    'README.md:42  callout type "[!NOTE] Custom title"',
    'README.md:45  callout type "[!NOTE]-"',
    'README.md:48  raw HTML tag beyond <details>/<summary>/<br>, split across lines',
    'README.md:51  root-absolute inline link "</abs.md>"',
    'README.md:53  root-absolute inline link " /abs.md"',
    'README.md:55  link target with a space: ./My Doc.md — write the space as %20 or wrap the target in <...> (rule 1)',
    'README.md:57  relative link in the wrong case: ./agents.md — on disk it is AGENTS.md',
    // A destination may start on the line after `](` or `]:`, and a backtick no later line of
    // its paragraph closes is a literal one, hiding nothing after it.
    'README.md:59  root-absolute inline link " /abs.md"',
    'README.md:62  absolute link "[padded]: /abs.md"',
    'README.md:65  raw HTML tag beyond <details>/<summary>/<br>, split across lines',
    'docs/public/index.md:3  link or image outside docs/public: ../internal/images/diagram.svg — the public site would publish it',
    'docs/public/index.md:3  link or image outside docs/public: ../internal/stale.md',
    'docs/internal/README.md  no H1',
    'docs/internal/README.md  README.md inside a site directory',
    'docs/index.md  index.md outside a site directory',
    // A reference definition counts after quote and list markers, as markdown-it reads it.
    'README.md:68  absolute link "[qabs]: /abs.md"',
    'README.md:69  broken relative link: [qbr]: ./missing.md',
    'README.md:71  broken relative link: [lbr]: ./missing.md',
    // A destination may start on the next line there too.
    'README.md:73  broken relative link: [qnext]: ./missing.md',
    'README.md:76  broken relative link: [lnext]: ./missing.md',
    'docs/public/index.md:5  link or image outside docs/public: [d]: ../internal/images/diagram.svg',
    'docs/public/index.md:7  link or image outside docs/public: [q]: ../internal/images/diagram.svg',
    'docs/public/index.md:9  link or image outside docs/public: [l]: ../internal/images/diagram.svg',
    'docs/public/index.md:15  link or image outside docs/public: [f]: ../internal/images/diagram.svg',
    // automd fills a public page's region from wherever its src resolves, and the opener's
    // arguments may run onto the lines below it.
    'docs/public/index.md:17  automd region reads outside docs/public: <!-- automd:file src=../internal/part.txt --> reads docs/internal/part.txt',
    'docs/public/index.md:23  automd region reads outside docs/public: <!-- automd:file src="/docs/internal/part.txt" --> reads docs/internal/part.txt',
    // A comment an HTML block opens in a quote or a list item ends with it, in VitePress at an
    // empty line too, and a `<!--` in indented code opens none: the line below each renders.
    'docs/public/index.md:32  link or image outside docs/public: [v1]: ../internal/images/diagram.svg',
    'docs/public/index.md:36  link or image outside docs/public: [v2]: ../internal/images/diagram.svg',
    'docs/public/index.md:42  link or image outside docs/public: [v3]: ../internal/images/diagram.svg',
    'docs/public/index.md:47  link or image outside docs/public: [v4]: ../internal/images/diagram.svg',
    // A label may hold an escaped bracket or wrap onto the next line, in a quote too, and
    // VitePress, with no footnote plugin, reads a `[^x]:` line as a definition.
    'docs/public/index.md:52  link or image outside docs/public: [a\\]b]: ../internal/images/diagram.svg',
    'docs/public/index.md:54  link or image outside docs/public: [multi line]: ../internal/images/diagram.svg',
    'docs/public/index.md:57  link or image outside docs/public: [quoted label]: ../internal/images/diagram.svg',
    'docs/public/index.md:60  link or image outside docs/public: [^x]: ../internal/images/diagram.svg',
    // VitePress expands an include across lines, in fenced code, and in inline code, and a
    // snippet from a list item or a quote, or from below a comment the quote or item ends or a
    // `<!--` in indented code.
    'docs/internal/embeds.md:4  VitePress @include',
    'docs/internal/embeds.md:8  VitePress @include',
    'docs/internal/embeds.md:11  VitePress @include',
    'docs/internal/embeds.md:13  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:15  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:17  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:19  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:22  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:26  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:32  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:37  VitePress code snippet "<<<"',
    // Any number of spaces may follow a quote marker in a list item, and a tab indents to the
    // next multiple of four columns: a tab-indented `<!--` is indented code at the top level
    // and an HTML block in a list item, which the unindented line ends.
    'docs/internal/embeds.md:40  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:42  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:47  VitePress code snippet "<<<"',
    'docs/internal/embeds.md:53  VitePress code snippet "<<<"',
    // Text the renderers show is read: past an escaped backtick; in a list item or a quote that
    // ends the paragraph a stray backtick opened; after a `<!--` no line of its paragraph
    // closes, and in the next paragraph; below a backtick fence whose info string holds a
    // backtick, which is no fence; and after a quoted fence, which ends with its quote.
    'docs/internal/blanked.md:3  Obsidian wikilink',
    'docs/internal/blanked.md:6  Obsidian wikilink',
    'docs/internal/blanked.md:10  Obsidian wikilink',
    'docs/internal/blanked.md:14  Obsidian wikilink',
    'docs/internal/blanked.md:16  Obsidian wikilink',
    'docs/internal/blanked.md:18  Obsidian wikilink',
    'docs/internal/blanked.md:21  Obsidian wikilink',
    // An escaped backtick opens no span a later line closes, and a thematic break or a setext
    // underline ends the paragraph a stray backtick opened.
    'docs/internal/blanked.md:23  Obsidian wikilink',
    'docs/internal/blanked.md:28  Obsidian wikilink',
    'docs/internal/blanked.md:32  Obsidian wikilink',
    // A `<!--` opens no comment after a comment block closes on its line, beside a comment
    // block closed on its line, or in a heading; and a comment block ends the paragraph a
    // stray backtick opened.
    'docs/internal/blanked.md:36  Obsidian wikilink',
    'docs/internal/blanked.md:40  Obsidian wikilink',
    'docs/internal/blanked.md:44  Obsidian wikilink',
    'docs/internal/blanked.md:48  Obsidian wikilink',
    // A definition in an alert is one too.
    'docs/public/index.md:63  link or image outside docs/public: [q2]: ../internal/images/diagram.svg',
    // Away from a block's start, a comment is one only as VitePress's grammar reads it: not with
    // `--` in its text, not as `<!-->` or `<!--->`, not after an escaping backslash, not across a
    // table cell's pipe, not where a code span opened first holds its `<!--`, and not past what
    // ends its paragraph: a heading that ends a nested item's, a table's header row, or an HTML
    // block's start such as `<details>`. A `<!--` in a link's title is the title's. A heading's
    // or an HTML block's backtick opens no code span below it, and what a comment hid turns into
    // spaces, so the backticks on either side of it, or after its `-->`, open no fence.
    'docs/public/index.md:65  link or image outside docs/public: ../internal/images/diagram.svg',
    'docs/public/index.md:67  link or image outside docs/public: ../internal/images/diagram.svg',
    'docs/public/index.md:72  link or image outside docs/public: ../internal/images/diagram.svg',
    'docs/public/index.md:76  link or image outside docs/public: ../internal/images/diagram.svg "<!--"',
    // A table's header row ends the paragraph a stray backtick opened, and a cell's backtick
    // pairs with none in another cell.
    'docs/public/index.md:81  link or image outside docs/public: ../internal/images/diagram.svg',
    'docs/internal/comments.md:3  Obsidian wikilink',
    'docs/internal/comments.md:5  Obsidian wikilink',
    'docs/internal/comments.md:8  Obsidian wikilink',
    'docs/internal/comments.md:11  Obsidian wikilink',
    'docs/internal/comments.md:15  Obsidian wikilink',
    'docs/internal/comments.md:20  Obsidian wikilink',
    'docs/internal/comments.md:23  Obsidian wikilink',
    'docs/internal/comments.md:28  Obsidian wikilink',
    'docs/internal/comments.md:31  Obsidian wikilink',
    'docs/internal/comments.md:34  Obsidian wikilink',
    'docs/internal/comments.md:37  Obsidian wikilink',
    'docs/internal/comments.md:51  Obsidian wikilink',
    'docs/internal/comments.md:54  Obsidian wikilink',
    'docs/internal/comments.md:58  Obsidian wikilink',
    'docs/internal/comments.md:62  Obsidian wikilink',
    // A fence opens where the line as written opens one, so a backtick in a comment still makes
    // an info string no fence's; and a comment's last line stays in its list item, whose fence
    // ends with it.
    'docs/internal/comments.md:64  Obsidian wikilink',
    'docs/internal/comments.md:48  Obsidian wikilink',
    // A `<!--` that heads a table opens no HTML block in VitePress: the table comes first.
    'docs/internal/comments.md:68  Obsidian wikilink',
    // A backtick run pairs with one on an indented line below it, which continues the
    // paragraph, so the line after both is read.
    'docs/internal/comments.md:41  Obsidian wikilink',
    // Blocks read as VitePress 1.6.4 reads them. A paragraph runs on past a lone `<br>` line and
    // past a header row whose cell count no delimiter row matches; a `<!--` in what only looks
    // like a link's title is a comment (all three as before this check read tables and HTML).
    'docs/internal/blocks.md:4  Obsidian wikilink',
    'docs/internal/blocks.md:7  Obsidian wikilink',
    'docs/internal/blocks.md:11  Obsidian wikilink',
    // An HTML block's lines, a comment block's included, hold no code span.
    'docs/internal/blocks.md:13  Obsidian wikilink',
    'docs/internal/blocks.md:16  Obsidian wikilink',
    'docs/internal/blocks.md:19  Obsidian wikilink',
    // A paragraph's comment may hold a pipe; a title holds a `<!--` though it wraps, and on the
    // line it wraps onto.
    'docs/internal/blocks.md:21  Obsidian wikilink',
    'docs/internal/blocks.md:24  Obsidian wikilink',
    'docs/internal/blocks.md:28  Obsidian wikilink',
    // A table row splits at its pipes before a code span pairs: in a table a list marker heads,
    // one in a list item, and a row with no pipe; and a quoted line heads a table at its
    // delimiter row's depth.
    'docs/internal/blocks.md:32  Obsidian wikilink',
    'docs/internal/blocks.md:36  Obsidian wikilink',
    'docs/internal/blocks.md:40  Obsidian wikilink',
    'docs/internal/blocks.md:44  Obsidian wikilink',
    'docs/internal/blocks.md:47  Obsidian wikilink',
    // A quoted fence ends where the quote depth drops; a backtick fence whose info string holds a
    // backtick ends no paragraph.
    'docs/internal/blocks.md:51  Obsidian wikilink',
    'docs/internal/blocks.md:55  Obsidian wikilink',
    // List items as CommonMark reads them: a thematic break or a setext underline opens none,
    // a line may open two, a quote inside one ends its paragraph, a paragraph ends where its
    // item's content column says, and an HTML block's line ends one.
    'docs/internal/blocks.md:59  Obsidian wikilink',
    'docs/internal/blocks.md:64  Obsidian wikilink',
    'docs/internal/blocks.md:67  Obsidian wikilink',
    'docs/internal/blocks.md:71  Obsidian wikilink',
    'docs/internal/blocks.md:74  Obsidian wikilink',
    'docs/internal/blocks.md:80  Obsidian wikilink',
    // A lazy line quoted two less than its paragraph loses its indent, so a comment there ends
    // the paragraph; a line indented as code below a deeper quote's line is code.
    'docs/internal/blocks.md:85  Obsidian wikilink',
    'docs/internal/blocks.md:90  Obsidian wikilink',
    // An HTML block runs on past a `>` line, empty only inside the quote; a lone `<br>` opens
    // one where a block starts; a `--` with no text above is text.
    'docs/internal/blocks.md:94  Obsidian wikilink',
    'docs/internal/blocks.md:97  Obsidian wikilink',
    'docs/internal/blocks.md:101  Obsidian wikilink',
    // A link's destination is read when its title wraps onto the next line or starts there.
    'docs/internal/blocks.md:103  broken relative link: ./missing-wrapped.md',
    'docs/internal/blocks.md:106  broken relative link: ./missing-next.md',
    // A lazy line keeps its paragraph's content column and quote depth: an item's HTML block
    // ends the paragraph, and a line quoted less than it runs on in it. A quote left of a list
    // item's content ends the item; a lazy line's heading ends a paragraph two quotes deeper.
    'docs/internal/blocks.md:112  Obsidian wikilink',
    'docs/internal/blocks.md:116  Obsidian wikilink',
    'docs/internal/blocks.md:121  Obsidian wikilink',
    'docs/internal/blocks.md:135  Obsidian wikilink',
    'docs/internal/blocks.md:148  Obsidian wikilink',
    // A lone `<br>` below a paragraph's text is the paragraph's, so a fence below it opens; a
    // `<!--` after a `](` no label opens is a comment.
    'docs/internal/blocks.md:156  Obsidian wikilink',
    'docs/internal/blocks.md:158  Obsidian wikilink',
    // A list item at a paragraph's content column ends it only as a bullet or a `1.`, and
    // another marker there is the paragraph's text, no item opening an HTML block; a lone `-`
    // below the text still underlines it.
    'docs/internal/blocks.md:161  Obsidian wikilink',
    'docs/internal/blocks.md:165  Obsidian wikilink',
    'docs/internal/blocks.md:172  Obsidian wikilink',
    // A table's delimiter row is its own though it reads as a thematic break, its rows end at a
    // fence, and a deeper quote that runs on into a line keeps it from heading a shallower table.
    'docs/internal/blocks.md:125  Obsidian wikilink',
    'docs/internal/blocks.md:131  Obsidian wikilink',
    'docs/internal/blocks.md:143  Obsidian wikilink',
    // A lazy line leaves its list item open, so a fence at the item's indent ends with the item;
    // a fence inside an HTML block is the block's text.
    'docs/internal/blocks.md:178  Obsidian wikilink',
    'docs/internal/blocks.md:184  Obsidian wikilink',
  ])
  check('a quoted fence\'s body is still code', !p.out.includes('blanked.md:13'), p.out)
  check('a split tag is reported once, on its first line', !p.out.includes('README.md:49'), p.out)
  check('a raw-space link is not also reported broken', !p.out.includes('broken relative link: ./My Doc.md'), p.out)
  check('a wrong-case link is not also reported broken', !p.out.includes('broken relative link: ./agents.md'), p.out)
}

// 3b. Heading grammar matches CommonMark: an H1 indented up to three spaces is an H1, and a
// review date written today in a timezone ahead of UTC is not "in the future".
{
  const dir = fixture('clean')
  writeFileSync(join(dir, 'docs/internal/indented.md'), '   # Indented\n\nText.\n')
  const p = run('docs:portability', dir, withoutCi)
  check('indented H1 passes', p.status === 0, p.out)

  // A page written with CRLF endings (a Windows editor, before git normalizes it) reads the
  // same: its H1 is found and a fragment into its own heading resolves.
  const crlf = fixture('clean')
  writeFileSync(join(crlf, 'docs/internal/crlf.md'), '# Title\r\n\r\nSee [below](#section).\r\n\r\n## Section\r\n')
  const cr = run('docs:portability', crlf, withoutCi)
  check('CRLF page passes docs:portability', cr.status === 0, cr.out)

  const local = localToday
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
  const spec = join(dir, 'docs/internal/specs/cli/hello.md')
  const original = readFileSync(spec, 'utf8')
  writeFileSync(spec, original.replace('2026-09-07', local))
  const contract = join(dir, 'docs/template/contract.md')
  writeFileSync(contract, readFileSync(contract, 'utf8').replace('2026-09-07', local))
  plantSkill(dir, SKILLS_SOURCE, 'x', '# x\n')
  plantSkill(dir, SKILLS_TARGET, 'x', '# x\n')
  const ok = run('docs:check', dir, withoutCi)
  check('local today is not in the future', ok.status === 0 && !ok.out.includes('in the future'), ok.out)
  writeFileSync(spec, original.replace('2026-09-07', inTwoDays))
  const future = run('docs:check', dir, withoutCi)
  check('two days ahead is in the future', future.out.includes('is in the future'), future.out)
}

// 4. The rulebook budget applies to every AGENTS.md in the tree: 200 lines pass, 201 fail.
{
  const over = fixture('clean')
  mkdirSync(join(over, 'packages/x'), { recursive: true })
  writeFileSync(join(over, 'packages/x/AGENTS.md'), `# Big\n${'- line\n'.repeat(200)}`)
  const c = run('docs:check', over, withoutCi)
  check('over-budget rulebook exits 1', c.status === 1, c.out)
  check('over-budget rulebook named with a forward-slash path', c.out.includes('packages/x/AGENTS.md: 201 lines exceeds the 200-line rulebook budget'), c.out)

  const exact = fixture('clean')
  mkdirSync(join(exact, 'packages/x'), { recursive: true })
  writeFileSync(join(exact, 'packages/x/AGENTS.md'), `# Big\n${'- line\n'.repeat(199)}`)
  const ok = run('docs:check', exact, withoutCi)
  check('rulebook of exactly 200 lines passes', ok.status === 0, ok.out)
}

// 5. Warnings are GitHub annotations only under GitHub Actions.
{
  const dir = fixture('broken')
  const ci = run('docs:check', dir, { ...process.env, [CI_KEY]: 'true' })
  check('annotations in CI', ci.out.includes('::warning::docs:check:'), ci.out)
  const local = run('docs:check', dir, withoutCi)
  check('plain warnings locally', local.out.includes('warning: docs:check:') && !local.out.includes('::warning::'), local.out)
  const pci = run('docs:portability', dir, { ...process.env, [CI_KEY]: 'true' })
  check('portability annotations in CI', pci.out.includes('::warning::docs:portability:'), pci.out)
}

// 6. No docs directory at all: both checkers skip it rather than crash.
{
  const dir = fixture('clean')
  rmSync(join(dir, 'docs'), { recursive: true, force: true })
  writeFileSync(join(dir, 'README.md'), '# No docs\n')
  const c = run('docs:check', dir, withoutCi)
  check('no docs dir: docs:check exits 0', c.status === 0, c.out)
  check('no docs dir: docs:check says skipped', c.out.includes('skipped'), c.out)
  const p = run('docs:portability', dir, withoutCi)
  check('no docs dir: docs:portability exits 0', p.status === 0, p.out)
}

// 7. Repo-root fallback: automd.config.ts, then the git top level, then package.json.
{
  const viaGit = fixture('clean')
  rmSync(join(viaGit, 'automd.config.ts'))
  spawnSync('git', ['init', '-q'], { cwd: viaGit, stdio: 'ignore' })
  const g = run('docs:portability', join(viaGit, 'docs'), withoutCi)
  check('root via git top level', g.status === 0, g.out)

  const viaPkg = fixture('clean')
  rmSync(join(viaPkg, 'automd.config.ts'))
  writeFileSync(join(viaPkg, 'package.json'), '{ "name": "fixture" }\n')
  const k = run('docs:portability', join(viaPkg, 'docs'), withoutCi)
  check('root via package.json', k.status === 0, k.out)

  const nowhere = join(tmp, 'nowhere')
  mkdirSync(nowhere)
  const x = run('docs:portability', nowhere, withoutCi)
  check('no root: non-zero with a clear message', x.status !== 0 && x.out.includes('repo root not found'), x.out)
}

// 8. A generated region is compared to the generator, whatever the line endings, and an
// opener whose arguments run onto the lines below it opens one, as automd reads it.
{
  const edited = fixture('clean')
  const index = join(edited, 'docs/internal/decisions/index.md')
  writeFileSync(index, readFileSync(index, 'utf8').replace('| Fourth | accepted |', '| Fourth | proposed |'))
  const e = run('docs:check', edited, withoutCi)
  check('stale index region exits 1', e.status === 1, e.out)
  check('stale index region named', e.out.includes('docs/internal/decisions/index.md: <!-- automd:decisionsIndex --> region is stale'), e.out)

  const split = fixture('clean')
  const splitIndex = join(split, 'docs/internal/decisions/index.md')
  writeFileSync(splitIndex, readFileSync(splitIndex, 'utf8').replace('<!-- automd:decisionsIndex -->', '<!-- automd:decisionsIndex\n  note="the arguments run on"\n-->').replace('| Fourth | accepted |', '| Fourth | proposed |'))
  const m = run('docs:check', split, withoutCi)
  check('a stale region under a multi-line opener is named', m.status === 1 && m.out.includes('docs/internal/decisions/index.md: <!-- automd:decisionsIndex --> region is stale'), m.out)

  const crlf = fixture('clean')
  const crlfIndex = join(crlf, 'docs/internal/decisions/index.md')
  writeFileSync(crlfIndex, readFileSync(crlfIndex, 'utf8').replace(/\n/g, '\r\n'))
  const c = run('docs:check', crlf, withoutCi)
  check('CRLF index region is current', c.status === 0, c.out)
}

// 9. The readers, called directly: what feeds the index regions and the sidebars.
{
  const dir = fixture('clean')
  const decisions = readDecisions(dir).map(d => [d.id, d.num, d.legacy, d.title, d.status])
  check('readDecisions reads legacy then dated records past the fenced Status', same(decisions, [
    ['0001', '0001', true, 'First', 'superseded by [0002](./0002-second.md)'],
    ['0002', '0002', true, 'Second', 'superseded by [20260105-third](./20260105-third.md)'],
    ['20260105-third', '2026-01-05', false, 'Third', 'superseded by [20260106-fourth](./20260106-fourth.md)'],
    ['20260106-fourth', '2026-01-06', false, 'Fourth', 'accepted'],
  ]), JSON.stringify(decisions))
  const specs = readSpecs(dir)
  check('readSpecs reads the one spec', same(specs, [{ area: 'cli', file: 'hello.md', title: 'Hello' }]), JSON.stringify(specs))
  check('decisionsSidebar labels each record and names a status other than accepted', same(decisionsSidebar(dir), [
    { text: '0001. First (superseded)', link: '/decisions/0001-first' },
    { text: '0002. Second (superseded)', link: '/decisions/0002-second' },
    { text: '2026-01-05 Third (superseded)', link: '/decisions/20260105-third' },
    { text: '2026-01-06 Fourth', link: '/decisions/20260106-fourth' },
  ]), JSON.stringify(decisionsSidebar(dir)))
  check('specsSidebar links each spec', same(specsSidebar(dir), [{ text: 'cli: Hello', link: '/specs/cli/hello' }]), JSON.stringify(specsSidebar(dir)))
  check('escapeCell escapes a bare pipe', escapeCell('a | b') === 'a \\| b')
  check('escapeCell leaves an escaped pipe alone', escapeCell('a \\| b') === 'a \\| b')

  mkdirSync(join(dir, 'docs/internal/decisions/0003-dir.md'))
  mkdirSync(join(dir, 'docs/internal/decisions/20260101-dir.md'))
  check('a directory named like a record is not one', readDecisions(dir).length === 4)
  const c = run('docs:check', dir, withoutCi)
  check('a directory named like a record passes docs:check', c.status === 0, c.out)

  const empty = fixture('clean')
  for (const sub of ['docs/internal/decisions', 'docs/internal/specs']) {
    rmSync(join(empty, sub), { recursive: true, force: true })
    mkdirSync(join(empty, sub))
  }
  check('empty dirs read as no records', readDecisions(empty).length === 0 && readSpecs(empty).length === 0)
  rmSync(join(empty, 'docs'), { recursive: true, force: true })
  check('absent dirs read as no records', readDecisions(empty).length === 0 && readSpecs(empty).length === 0)
}

// 10. A missing index page is an error, not a skipped directory.
{
  const dir = fixture('clean')
  rmSync(join(dir, 'docs/internal/decisions/index.md'))
  rmSync(join(dir, 'docs/internal/specs/index.md'))
  const c = run('docs:check', dir, withoutCi)
  check('missing index pages exit 1', c.status === 1, c.out)
  expectAll('missing index pages', c.out, [
    'docs/internal/decisions/index.md: missing index page',
    'docs/internal/specs/index.md: missing index page',
  ])
}

// 11. The mirror generator: copies a planted source; without one, removes a stale mirror
// and exits 0, and docs:check passes with neither tree present.
{
  const dir = fixture('clean')
  plantSkill(dir, SKILLS_SOURCE, 'x', '# x\n')
  const g = run('gen-skills', dir, withoutCi)
  check('gen-skills mirrors the source', g.status === 0 && g.out.includes('.agents/skills (1 files) mirrored from .claude/skills'), g.out)
  check('mirror is byte-identical', readFileSync(join(dir, SKILLS_TARGET, 'x/SKILL.md'), 'utf8') === '# x\n')
  const c = run('docs:check', dir, withoutCi)
  check('generated mirror passes docs:check', c.status === 0, c.out)

  const none = fixture('clean')
  plantSkill(none, SKILLS_TARGET, 'z', '# stale\n')
  const r = run('gen-skills', none, withoutCi)
  check('gen-skills without a source exits 0', r.status === 0 && r.out.includes('(.claude/skills: not present, mirror removed)'), r.out)
  check('stale mirror removed', !existsSync(join(none, SKILLS_TARGET)))
  const n = run('docs:check', none, withoutCi)
  check('no skills dirs: docs:check exits 0', n.status === 0, n.out)
}

// 12. A merge conflict inside a generated region is named as such, not as a stale region,
// and `pnpm docs:gen` repairs it: automd rewrites the whole region from the files.
{
  // Conflict lines inside a generated region: named as such, then repaired byte for byte.
  const conflicted = fixture('clean')
  const index = join(conflicted, 'docs/internal/decisions/index.md')
  const clean = readFileSync(index, 'utf8')
  writeFileSync(index, clean.replace('| [20260106-fourth](./20260106-fourth.md) | Fourth | accepted |', '<<<<<<< HEAD\n| [20260106-fourth](./20260106-fourth.md) | Fourth | accepted |\n=======\n| [20260106-other](./20260106-other.md) | Other | accepted |\n>>>>>>> main'))
  const c = run('docs:check', conflicted, withoutCi)
  check('conflicted region exits 1', c.status === 1, c.out)
  check('conflicted region named with its remedy and the lasting fix', c.out.includes('docs/internal/decisions/index.md: <!-- automd:decisionsIndex --> region holds merge conflict lines — regenerate it with `pnpm docs:gen`; never hand-merge a generated region. To stop the next conflict, delete the region: the handbook sidebar and `pnpm docs:list` read the list from the files'), c.out)
  check('conflicted region not also reported stale', !c.out.includes('region is stale'), c.out)
  if (automdUrl) {
    const a = runAutomd(conflicted)
    check('automd runs on the conflicted copy', a.status === 0, a.out)
    check('automd restores a conflicted region byte for byte', readFileSync(index, 'utf8') === clean)
  }
  else {
    console.log('  (automd not installed: the docs:gen repair of a conflicted region is skipped)')
  }

  // A region no index generator writes gets the regenerate remedy alone: deleting it drops content.
  const custom = fixture('clean')
  writeFileSync(join(custom, 'docs/internal/custom.md'), '# Custom\n\n<!-- automd:custom -->\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n<!-- /automd -->\n')
  const u = run('docs:check', custom, withoutCi)
  check('a conflicted custom region is named without the index advice', u.status === 1 && u.out.includes('docs/internal/custom.md: <!-- automd:custom --> region holds merge conflict lines — regenerate it with `pnpm docs:gen`; never hand-merge a generated region\n') && !u.out.includes('custom.md: <!-- automd:custom --> region holds merge conflict lines — regenerate it with `pnpm docs:gen`; never hand-merge a generated region. To stop'), u.out)

  // A setext `=======` underline and a fenced example are not conflicts.
  const prose = fixture('clean')
  writeFileSync(join(prose, 'docs/internal/setext.md'), 'Setext title\n=======\n\n```text\n<<<<<<< HEAD\n```\n')
  const p = run('docs:check', prose, withoutCi)
  check('a setext underline and a fenced marker pass docs:check', p.status === 0, p.out)
}

// 13. A legacy-only tree renders its table byte for byte as before dated records, so a
// child that still commits a region and has no dated record sees no change.
{
  const LEGACY_TABLE = [
    '| # | Title | Status |',
    '| --- | --- | --- |',
    '| [0001](./0001-first.md) | First | superseded by [0002](./0002-second.md) |',
    '| [0002](./0002-second.md) | Second | accepted |',
  ].join('\n')
  const LEGACY_PAGE = `# Decision records\n\n<!-- automd:decisionsIndex -->\n\n${LEGACY_TABLE}\n\n<!-- /automd -->\n`
  const dir = fixture('clean')
  const decisions = join(dir, 'docs/internal/decisions')
  rmSync(join(decisions, '20260105-third.md'))
  rmSync(join(decisions, '20260106-fourth.md'))
  const second = join(decisions, '0002-second.md')
  writeFileSync(second, readFileSync(second, 'utf8').replace('- **Status:** superseded by [20260105-third](./20260105-third.md)', '- **Status:** accepted'))
  writeFileSync(join(decisions, 'index.md'), LEGACY_PAGE)
  const table = renderDecisionsIndex(readDecisions(dir))
  check('a legacy-only table renders byte for byte as before', table === LEGACY_TABLE, table)
  check('no records render the placeholder as before', renderDecisionsIndex([]) === '_No decisions yet. The first one appears here after `pnpm docs:gen`._')
  const c = run('docs:check', dir, withoutCi)
  check('a committed legacy-only region stays current', c.status === 0, c.out)
  if (automdUrl) {
    const a = runAutomd(dir)
    check('automd leaves a legacy-only region byte for byte', a.status === 0 && readFileSync(join(decisions, 'index.md'), 'utf8') === LEGACY_PAGE, a.out)
  }
}

// 14. An index page need not carry a region: the lists are read from the files.
{
  const dir = withoutRegions(fixture('clean'))
  const c = run('docs:check', dir, withoutCi)
  check('index pages without regions pass docs:check', c.status === 0 && !c.out.includes('missing <!-- automd:'), c.out)
  const p = run('docs:portability', dir, withoutCi)
  check('index pages without regions pass docs:portability', p.status === 0, p.out)
}

// 15. Legacy records list first whatever their number, and a numbered record dated after
// the first dated one is warned as numbered by habit. The switch is the earliest dated
// record's filename date, its creation day, so a backdated Date bullet does not move it.
{
  const dir = withoutRegions(fixture('clean'))
  const decisions = join(dir, 'docs/internal/decisions')
  writeFileSync(join(decisions, '2100-high.md'), '# 2100. High\n\n- **Status:** accepted\n- **Date:** 2026-01-03\n')
  const order = readDecisions(dir).map(d => d.file)
  check('a legacy number of 2100 still lists before the dated records', same(order, ['0001-first.md', '0002-second.md', '2100-high.md', '20260105-third.md', '20260106-fourth.md']), JSON.stringify(order))
  const third = join(decisions, '20260105-third.md')
  writeFileSync(third, readFileSync(third, 'utf8').replace('- **Date:** 2026-01-05', '- **Date:** 2025-12-01'))
  const ok = run('docs:check', dir, withoutCi)
  check('numbered records dated before the first dated filename pass unwarned', ok.status === 0 && !ok.out.includes('numbered record dated'), ok.out)

  writeFileSync(join(decisions, '0003-same-day.md'), '# 0003. Same day\n\n- **Status:** accepted\n- **Date:** 2026-01-05\n')
  writeFileSync(join(decisions, '0004-late.md'), '# 0004. Late\n\n- **Status:** accepted\n- **Date:** 2026-01-06\n')
  const late = run('docs:check', dir, withoutCi)
  check('a numbered record dated after the first dated record is a warning, not an error', late.status === 0 && late.out.includes('docs/internal/decisions/0004-late.md: numbered record dated 2026-01-06, after the first dated record 20260105-third.md was created. Either this record was numbered by habit'), late.out)
  check('a numbered record dated the day of the first dated record is not warned', !late.out.includes('0003-same-day.md: numbered record dated'), late.out)

  // A dated record named for a past day moves the switch back and flags older numbered
  // records; the dates cannot tell that from habit, so the warning names the dated record too.
  writeFileSync(join(decisions, '20240115-retro.md'), '# Retro\n\n- **Status:** accepted\n- **Date:** 2024-01-15\n')
  const retro = run('docs:check', dir, withoutCi)
  check('a backdated dated name is named as the other cause', retro.status === 0 && retro.out.includes('docs/internal/decisions/0001-first.md: numbered record dated 2026-01-01, after the first dated record 20240115-retro.md was created. Either this record was numbered by habit') && retro.out.includes('Or 20240115-retro.md is named for a day before it was created: unless it is already on the default branch, rename it to its creation day.'), retro.out)
}

// 16. A dated record named with today's local date passes in every timezone; two days ahead
// is an error, not a warning, since the name is the record's ID for good; and a hyphenated
// date in the name is an error that names the compact form.
{
  const dir = withoutRegions(fixture('clean'))
  const decisions = join(dir, 'docs/internal/decisions')
  const stamp = localToday.replaceAll('-', '')
  writeFileSync(join(decisions, `${stamp}-today.md`), `# Today\n\n- **Status:** accepted\n- **Date:** ${localToday}\n`)
  // A title may open with a bare number or a year: only a number and a dot, or a date, is a label.
  writeFileSync(join(decisions, `${stamp}-three-regions.md`), `# 3 regions per service\n\n- **Status:** accepted\n- **Date:** ${localToday}\n`)
  writeFileSync(join(decisions, `${stamp}-roadmap.md`), `# 2026 roadmap priorities\n\n- **Status:** accepted\n- **Date:** ${localToday}\n`)
  const ok = run('docs:check', dir, withoutCi)
  check('a dated record named today passes', ok.status === 0, ok.out)
  check('a dated title opening with a bare number or a year passes', !ok.out.includes('three-regions.md') && !ok.out.includes('roadmap.md'), ok.out)
  const ahead = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')
  writeFileSync(join(decisions, `${ahead}-ahead.md`), `# Ahead\n\n- **Status:** accepted\n- **Date:** ${localToday}\n`)
  // The natural slip, a hyphenated date, has the legacy shape: named as a date to compact,
  // never read as record 2026, and never told to take a `# 2026. Title` H1.
  writeFileSync(join(decisions, '2026-01-07-hyphenated.md'), '# Hyphenated\n\n- **Status:** accepted\n- **Date:** 2026-01-07\n')
  // Near misses: unpadded, no slug, and a date that is not real, which gets no compact form.
  writeFileSync(join(decisions, '2026-1-8-unpadded.md'), '# Unpadded\n\n- **Status:** accepted\n- **Date:** 2026-01-08\n')
  writeFileSync(join(decisions, '2026-01-09.md'), '# No slug\n\n- **Status:** accepted\n- **Date:** 2026-01-09\n')
  writeFileSync(join(decisions, '2026-02-30-not-real.md'), '# Not real\n\n- **Status:** accepted\n- **Date:** 2026-01-10\n')
  // A legacy name whose words read as a date of year 3 is still a legacy record.
  writeFileSync(join(decisions, '0003-12-01-cutoff.md'), '# 0003. The 12-01 cutoff\n\n- **Status:** accepted\n- **Date:** 2026-01-03\n')
  const bad = run('docs:check', dir, withoutCi)
  check('a dated record named two days ahead fails', bad.status === 1 && bad.out.includes(`${ahead}-ahead.md: filename date ${ahead} is in the future`), bad.out)
  check('a hyphenated date in the name is named with its compact form', bad.out.includes('docs/internal/decisions/2026-01-07-hyphenated.md: filename must be YYYYMMDD-kebab-title.md, the date without hyphens (20260107); as written it reads as legacy record 2026'), bad.out)
  check('a hyphenated date in the name is reported once', bad.out.split('2026-01-07-hyphenated.md').length === 2, bad.out)
  check('a legacy name with date-like words is not a hyphenated date', !bad.out.includes('0003-12-01-cutoff.md'), bad.out)
  expectAll('a hyphenated near miss', bad.out, [
    'docs/internal/decisions/2026-1-8-unpadded.md: filename must be YYYYMMDD-kebab-title.md, the date without hyphens (20260108); as written it reads as legacy record 2026',
    'docs/internal/decisions/2026-01-09.md: filename must be YYYYMMDD-kebab-title.md, the date without hyphens (20260109); as written it reads as legacy record 2026',
    'docs/internal/decisions/2026-02-30-not-real.md: filename must be YYYYMMDD-kebab-title.md, the date without hyphens; as written it reads as legacy record 2026',
  ])
  check('a hyphenated name is never told to take a numbered H1', !bad.out.includes('H1 must be "# 2026. Title"') && !bad.out.includes('duplicate decision number 2026'), bad.out)
}

// 17. docs:list prints the lists read from the files: the decisions table in reading order
// and the spec list, either alone, a plain line when there is nothing, usage on a bad argument.
{
  const dir = fixture('clean')
  const rows = [
    '| [0001](./0001-first.md) | First |',
    '| [0002](./0002-second.md) | Second |',
    '| [20260105-third](./20260105-third.md) | Third |',
    '| [20260106-fourth](./20260106-fourth.md) | Fourth | accepted |',
  ]
  const all = run('docs:list', join(dir, 'docs'), withoutCi)
  check('docs:list exits 0 from below the repository root', all.status === 0, all.out)
  const at = rows.map(r => all.out.indexOf(r))
  check('docs:list prints every record, legacy first, then oldest first', at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!)), all.out)
  expectAll('docs:list', all.out, ['## Decisions (docs/internal/decisions/, numbered records first, then dated ones oldest first)', '| ID | Title | Status |', '## Specs (docs/internal/specs/)', '### cli', '- [Hello](./cli/hello.md)'])
  const specs = run('docs:list', dir, withoutCi, ['specs'])
  check('docs:list specs prints the specs alone', specs.status === 0 && specs.out.includes('- [Hello](./cli/hello.md)') && !specs.out.includes('## Decisions'), specs.out)
  const decisions = run('docs:list', dir, withoutCi, ['decisions'])
  check('docs:list decisions prints the decisions alone', decisions.status === 0 && decisions.out.includes(rows[3]!) && !decisions.out.includes('## Specs'), decisions.out)
  const dashed = run('docs:list', dir, withoutCi, ['--', 'decisions'])
  check('docs:list takes the npm habit `-- decisions`', dashed.status === 0 && dashed.out.includes(rows[3]!) && !dashed.out.includes('## Specs'), dashed.out)
  const bad = run('docs:list', dir, withoutCi, ['nope'])
  check('docs:list rejects an unknown argument with usage', bad.status === 1 && bad.out.includes('usage: pnpm docs:list [decisions|specs]'), bad.out)

  const empty = fixture('clean')
  for (const sub of ['docs/internal/decisions', 'docs/internal/specs']) {
    rmSync(join(empty, sub), { recursive: true, force: true })
    mkdirSync(join(empty, sub))
  }
  const e = run('docs:list', empty, withoutCi)
  check('docs:list says when there is nothing to list', e.status === 0 && e.out.includes('_No decisions yet._') && e.out.includes('_No specs yet._') && !e.out.includes('docs:gen'), e.out)
}

// 18. The property dated names exist for: two branches cut from the same commit, each adding
// a record on the same day, merge into main with no conflict, and the result passes
// docs:check. Git runs with an isolated config, and the inherited GIT_ variables are dropped
// so a hook's GIT_DIR or GIT_INDEX_FILE cannot point it at the outer repository.
{
  const gitconfig = join(tmp, 'gitconfig')
  writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(withoutCi).filter(([k]) => !k.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]): Run => {
    const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` }
  }
  const stamp = localToday.replaceAll('-', '')
  const record = (repo: string, slug: string, title: string): void => {
    writeFileSync(join(repo, 'docs/internal/decisions', `${stamp}-${slug}.md`), `# ${title}\n\n- **Status:** accepted\n- **Date:** ${localToday}\n`)
  }

  const repo = withoutRegions(fixture('clean'))
  const steps = [
    git(repo, 'init', '-q', '-b', 'main'),
    git(repo, 'add', '-A'),
    git(repo, 'commit', '-q', '-m', 'base'),
    git(repo, 'checkout', '-q', '-b', 'a'),
  ]
  record(repo, 'use-postgres', 'Use Postgres')
  steps.push(git(repo, 'add', '-A'), git(repo, 'commit', '-q', '-m', 'a'), git(repo, 'checkout', '-q', '-b', 'b', 'main'))
  record(repo, 'cache-with-redis', 'Cache with Redis')
  steps.push(git(repo, 'add', '-A'), git(repo, 'commit', '-q', '-m', 'b'), git(repo, 'checkout', '-q', 'main'))
  const failed = steps.find(s => s.status !== 0)
  check('git builds two branches from one base', failed === undefined, failed?.out)
  const first = git(repo, 'merge', '--no-ff', '-q', '-m', 'merge a', 'a')
  const second = git(repo, 'merge', '--no-ff', '-q', '-m', 'merge b', 'b')
  check('two branches that each add a dated record merge into main with no conflict', first.status === 0 && second.status === 0, `${first.out}${second.out}`)
  const c = run('docs:check', repo, gitEnv)
  check('the merged records pass docs:check', c.status === 0 && c.out.includes('✔ docs:check — 6 decision(s)'), c.out)
  const l = run('docs:list', repo, gitEnv, ['decisions'])
  expectAll('docs:list after the merge', l.out, [
    `| [${stamp}-cache-with-redis](./${stamp}-cache-with-redis.md) | Cache with Redis | accepted |`,
    `| [${stamp}-use-postgres](./${stamp}-use-postgres.md) | Use Postgres | accepted |`,
  ])
}

// 19. What docs:check accepts: a line reference after a Source or Tests path, and a comment
// after a Status keyword.
{
  const dir = withoutRegions(fixture('clean'))
  const spec = join(dir, 'docs/internal/specs/cli/hello.md')
  writeFileSync(spec, readFileSync(spec, 'utf8')
    .replace('2026-09-07', today)
    .replace('`src/hello.txt`', '`src/hello.txt:3`')
    .replace('`test/hello.txt`', '`test/hello.txt#L1-L2`'))
  const contract = join(dir, 'docs/template/contract.md')
  writeFileSync(contract, readFileSync(contract, 'utf8').replace('2026-09-07', today))
  const fourth = join(dir, 'docs/internal/decisions/20260106-fourth.md')
  writeFileSync(fourth, readFileSync(fourth, 'utf8').replace('- **Status:** accepted', '- **Status:** accepted <!-- after review -->'))
  const c = run('docs:check', dir, withoutCi)
  check('line references and a commented Status pass docs:check', c.status === 0 && !c.out.includes('warning'), c.out)
}

// 20. What the fence and link checks accept: a fence nested in a list item is code, not
// prose; inline code wrapped onto the next line is code on both lines; a percent-encoded
// link names the file with the space; and a public page links within docs/public, the site's
// root included. stripFences, which docs:check and the anchor check read pages through,
// tracks list items the same way, a tab in an indent counted in columns, and ends a list
// item's fence with the item.
{
  const dir = fixture('clean')
  const page = [
    '# Nested fences',
    '',
    '1. A step:',
    '   - an example nested one level deeper:',
    '',
    '     ```html',
    '     <div>[[not a wikilink]] {{ not vue }}</div>',
    '     ```',
    '',
    '- ```text',
    '  <span>a fence opened on the item line</span>',
    '  ```',
    '',
    '![diagram](./images/My%20Diagram.svg)',
    '',
    'The custom element is written `<my-element',
    'data-x="1">` in a page, and generics like `Map<string,',
    'number>` wrap too. Write `[text](./missing.md)',
    'as a link` to link a page.',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'docs/internal/nested.md'), page)
  mkdirSync(join(dir, 'docs/internal/images'))
  writeFileSync(join(dir, 'docs/internal/images/My Diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  mkdirSync(join(dir, 'docs/public/images'), { recursive: true })
  writeFileSync(join(dir, 'docs/public/index.md'), '# Public\n\nA ![diagram](./images/d.svg), [this page](./index.md), and [the home page](./).\n')
  writeFileSync(join(dir, 'docs/public/images/d.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  mkdirSync(join(dir, 'docs/public/guide'))
  writeFileSync(join(dir, 'docs/public/guide/start.md'), '# Start\n\nBack [home](../) or to [the index](../index.md).\n')
  const p = run('docs:portability', dir, withoutCi)
  check('nested fences, a %20 link, and a public page linking inside docs/public pass', p.status === 0 && !p.out.includes('warning'), p.out)

  check('stripFences blanks a fence nested two list levels deep', stripFences('- a\n  - b\n\n    ```md\n    # not a heading\n    ```\n# Real\n') === '- a\n  - b\n\n\n\n\n# Real\n')
  check('stripFences ends a list item\'s fence with the item', stripFences('- item\n\n  ```\n  code\n# Heading\n') === '- item\n\n\n\n# Heading\n')
  check('stripFences reads an over-indented fence as code in the item, not a fence', stripFences('- item\n\n      ```\n# Heading\n') === '- item\n\n      ```\n# Heading\n')
  check('stripFences counts a tab to the next multiple of four columns', stripFences('- item\n\n\t```\n\t# not a heading\n\t```\n# Real\n') === '- item\n\n\n\n\n# Real\n')
}

// 21. The public build follows a symlink, so one under docs/public that resolves outside it
// publishes what it names: a directory that links to docs/internal, a page embedding through
// it, and a page that is a symlink to an internal page are each refused. A junction on Windows
// needs no privilege, a file symlink may; each is skipped, with a note, where it cannot be made.
{
  const dir = fixture('clean')
  mkdirSync(join(dir, 'docs/internal/images'), { recursive: true })
  writeFileSync(join(dir, 'docs/internal/images/secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  writeFileSync(join(dir, 'docs/internal/secret.md'), '# Secret\n\nInternal only.\n')
  mkdirSync(join(dir, 'docs/public'))
  writeFileSync(join(dir, 'docs/public/index.md'), '# Public\n\nAn ![image](./img/secret.svg).\n')
  const link = (target: string, path: string, type: 'junction' | 'file'): boolean => {
    try {
      symlinkSync(join(dir, target), join(dir, path), type)
      return true
    }
    catch (error) {
      console.log(`  (${path} symlink: skipped, none can be made here: ${(error as Error).message})`)
      return false
    }
  }
  const linkedDir = link('docs/internal/images', 'docs/public/img', 'junction')
  const linkedPage = link('docs/internal/secret.md', 'docs/public/handbook.md', 'file')
  const p = run('docs:portability', dir, withoutCi)
  if (linkedDir || linkedPage)
    check('a symlink under docs/public to docs/internal exits 1', p.status === 1, p.out)
  if (linkedDir) {
    check('a directory symlink out of docs/public is named', p.out.includes('docs/public/img  symlink to docs/internal/images, outside docs/public'), p.out)
    check('a public page embedding through a symlink is named', p.out.includes('docs/public/index.md:3  link or image outside docs/public: ./img/secret.svg'), p.out)
  }
  if (linkedPage)
    check('a page symlinked into docs/public is named', p.out.includes('docs/public/handbook.md  symlink to docs/internal/secret.md, outside docs/public'), p.out)
}

// 22. What a public page may hold: a reference definition in a quote or a list item, a
// `[Term]:` followed by prose, which defines nothing, and an automd region whose source is
// inside docs/public, relative or root-absolute, or which names none (dir-tree then lists the
// page's own directory). Text a comment or a code span hides stays hidden: a comment that
// closes on a later line of its paragraph, a lazy quote line, an indented line, a nested item's
// line, or a lone `<br>` line included; a comment after an escaped backslash or holding a
// backtick or a pipe; a comment block in a quote across a bare `>` line; a comment in a table
// cell or an HTML block; a code span after an escaped backslash, holding an escaped pipe in a
// table cell, in a quoted table, or past a line with a pipe that heads no table; a fence a tab
// indents into a list item; and an image whose title holds a comment. Neither a comment's last
// line nor an HTML block's line is a heading or underlines one. A definition with an escaped or
// wrapped label may name a file inside, and a `[^label]:` line may name one inside or none, as a
// footnote's text does. What it may not: a region that reads outside docs/public in any form
// automd reads it, a long-s `ſrc` key included, or one that lists the handbook. Where automd is
// installed it fills the refused regions, which shows each is a real leak.
{
  const dir = fixture('clean')
  mkdirSync(join(dir, 'docs/public/images'), { recursive: true })
  writeFileSync(join(dir, 'docs/public/images/d.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  writeFileSync(join(dir, 'docs/public/part.txt'), 'Public text.\n')
  const region = (opener: string, body: string): string => `${opener}\n\n${body}\n\n<!-- /automd -->\n`
  writeFileSync(join(dir, 'docs/public/index.md'), [
    '# Public\n',
    '> [q]: ./images/d.svg\n',
    '- [l]: ./images/d.svg\n',
    '- [Obsidian]: open the folder as a vault\n',
    '> [Note]: see the section below\n',
    region('<!-- automd:file src=./part.txt -->', 'Public text.'),
    region('<!-- automd:file\n  src=/docs/public/part.txt\n-->', 'Public text.'),
    region('<!-- automd:dir-tree -->', '```text\n└── index.md\n```'),
    'Text <!-- a note that\nwraps [[hidden]] --> and more.\n',
    '> Quoted <!-- a note that\nwraps [[hidden]] --> lazily.\n',
    'Text <!-- a note [[hidden]] --> and a second backslash \\\\<!-- [[hidden]] --> to end.\n',
    'Text <!-- a tick ` --> shown <!-- and ` its pair [[hidden]] --> after.\n',
    '- a\n  - b <!-- a note in a nested item\n    [[hidden]] -->\n',
    'Text <!-- a note\n--># Not a second H1\n',
    '<!-- a note --># Not a second H1 either\n',
    'A paragraph line\n<!-- a note -->===\n',
    'Text\n    <!-- a note on an indented line\n[[hidden]] -->\n',
    '> <!-- a note\n>\n> [[hidden]]\n> -->\n',
    'Two backslashes \\\\`[[code]]` leave the code span whole.\n',
    '[e\\]x]: ./images/d.svg\n',
    '[wrapped\nlabel]: ./images/d.svg\n',
    '[^word]: word\n',
    '[^inside]: ./images/d.svg\n',
    '- item\n\n\t~~~ts\n\t[ID]: number;\n\t~~~\n',
    'Text <!-- a pipe | in [[hidden]] --> a paragraph comment.\n',
    '| a | b |\n| - | - |\n| <!-- [[hidden]] --> | `an escaped \\| [[code]]` |\n',
    '> | a |\n> | - |\n> | `[[code]]` |\n',
    'Text <!-- a note past\n<br>\n[[hidden]] --> a lone tag.\n',
    'Text `code past\nb | c [[code]]\nd` a header row no delimiter row follows.\n',
    '<details>\n<!-- [[hidden]] -->\n</details>\n',
    'An ![image](./images/d.svg "<!-- its title -->") shown.\n',
  ].join('\n'))
  const p = run('docs:portability', dir, withoutCi)
  check('a public page reading only docs/public passes', p.status === 0 && !p.out.includes('warning'), p.out)

  const leak = fixture('clean')
  mkdirSync(join(leak, 'docs/public'))
  writeFileSync(join(leak, 'docs/internal/part.txt'), 'INTERNAL-PART\n')
  writeFileSync(join(leak, 'x.mts'), 'export const rootOnly = 1\n')
  writeFileSync(join(leak, 'docs/public/x.mts'), 'export const publicOnly = 1\n')
  writeFileSync(join(leak, 'docs/public/index.md'), [
    '# Public\n',
    region('<!-- automd:file src=%2e%2e/internal/part.txt -->', ''),
    '```md',
    region('<!-- automd:file src=../internal/part.txt -->', ''),
    '```\n',
    region('<!-- automd:file src=./nope.txt -->', ''),
    region('<!-- automd:specIndex -->', ''),
    region('<!-- automd:jsimport src=./x.mts -->', ''),
    region('<!-- automd:file ſrc=../internal/part.txt -->', ''),
    region('<!-- automd:dir-tree src=/ -->', ''),
  ].join('\n'))
  const l = run('docs:portability', leak, withoutCi)
  check('a public page reading outside docs/public exits 1', l.status === 1, l.out)
  expectAll('a public region reading outside docs/public', l.out, [
    'docs/public/index.md:3  automd region reads outside docs/public: <!-- automd:file src=%2e%2e/internal/part.txt --> reads docs/internal/part.txt',
    'docs/public/index.md:10  automd region reads outside docs/public: <!-- automd:file src=../internal/part.txt --> reads docs/internal/part.txt',
    'docs/public/index.md:18  automd region reads outside docs/public: <!-- automd:file src=./nope.txt --> names ./nope.txt, which does not exist',
    'docs/public/index.md:24  automd region reads outside docs/public: <!-- automd:specIndex --> lists docs/internal/specs',
    // jsimport resolves its src as a module from the repository root, not from the page, so
    // the copy beside the page does not make it inside.
    'docs/public/index.md:30  automd region reads outside docs/public: <!-- automd:jsimport src=./x.mts --> reads x.mts',
    // automd camel-cases a key, which reads a long s as `s`; and the root has a name.
    'docs/public/index.md:36  automd region reads outside docs/public: <!-- automd:file ſrc=../internal/part.txt --> reads docs/internal/part.txt',
    'docs/public/index.md:42  automd region reads outside docs/public: <!-- automd:dir-tree src=/ --> reads . (the repository root)',
  ])
  if (automdUrl) {
    const a = runAutomd(leak)
    const filled = readFileSync(join(leak, 'docs/public/index.md'), 'utf8').split('INTERNAL-PART').length - 1
    check('automd fills the three refused file regions from docs/internal', a.status === 0 && filled === 3, `${a.out} filled ${filled}`)
  }

  // A layout the rules doc says the checker can miss, which docs/README.md's public-boundary
  // sentence cites: a backtick in a link's title pairs with a later one, so the checker reads
  // nothing between them, while VitePress ends the title at its quote and embeds the image.
  // Pinned so the admission stays true: once the checker catches this, drop it from the list.
  const miss = fixture('clean')
  mkdirSync(join(miss, 'docs/public'))
  mkdirSync(join(miss, 'docs/internal/images'), { recursive: true })
  writeFileSync(join(miss, 'docs/internal/images/d.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  writeFileSync(join(miss, 'docs/public/index.md'), '# Public\n\nSee [home](./index.md "`") ![x](../internal/images/d.svg) `\n')
  const m = run('docs:portability', miss, withoutCi)
  const rules = readFileSync(join(import.meta.dirname, '..', 'docs/template/markdown-portability.md'), 'utf8').replace(/\s+/g, ' ')
  check('a backtick in a link\'s title is still a miss the rules doc names', m.status === 0 && rules.includes('a backtick in a link\'s destination or title'), m.out)
}

// 23. The sidebars hold HTML, since VitePress renders sidebar text as HTML: a title's `&`, `<`,
// and `>` are escaped and its code spans become `<code>`. A Status comment is dropped wherever
// the Status is read, and a Status holding only a comment reads as unknown.
{
  const dir = withoutRegions(fixture('clean'))
  const decisions = join(dir, 'docs/internal/decisions')
  writeFileSync(join(decisions, '20260107-result.md'), '# Return `Result<T, E>` & friends\n\n- **Status:** proposed<!-- until the spike lands -->\n- **Date:** 2026-01-07\n')
  writeFileSync(join(decisions, '20260108-blank.md'), '# Blank\n\n- **Status:** <!-- pick one -->\n- **Date:** 2026-01-08\n')
  writeFileSync(join(dir, 'docs/internal/specs/cli/quote.md'), '# Quote `` `x` `` when a<b\n\n- **Source:** `src/hello.txt`\n- **Tests:** `test/hello.txt`\n- **Last reviewed:** 2026-09-07\n')
  const statuses = readDecisions(dir).slice(-2).map(d => d.status)
  check('readDecisions drops a Status comment, and a comment alone reads as unknown', same(statuses, ['proposed', 'unknown']), JSON.stringify(statuses))
  const sidebar = decisionsSidebar(dir).slice(-2).map(d => d.text)
  check('decisionsSidebar escapes a title and renders its code span', same(sidebar, ['2026-01-07 Return <code>Result&lt;T, E&gt;</code> &amp; friends (proposed)', '2026-01-08 Blank (unknown)']), JSON.stringify(sidebar))
  const specs = specsSidebar(dir).map(s => s.text)
  check('specsSidebar escapes a title and renders a double-backtick span', same(specs, ['cli: Hello', 'cli: Quote <code>`x`</code> when a&lt;b']), JSON.stringify(specs))
  const l = run('docs:list', dir, withoutCi, ['decisions'])
  check('docs:list prints a title as written and a Status without its comment', l.out.includes('| [20260107-result](./20260107-result.md) | Return `Result<T, E>` & friends | proposed |') && !l.out.includes('<!--'), l.out)
}

if (fails.length > 0) {
  console.error(`\n✖ docs fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs fixtures — ${checks} checks pass`)
