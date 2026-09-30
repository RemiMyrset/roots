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
 * Status keyword matched whole, Source and Tests values with a line reference or no path,
 * fences nested in list items, inline code wrapped across lines, link targets spelled with a
 * space, percent-encoding, or the wrong case or starting on the next line, public pages that
 * link outside docs/public or to its root, symlinks out of docs/public (made at test time,
 * skipped where the platform refuses one), and the property dated names exist
 * for: two git branches that each add a record merge with no conflict. The skill trees are planted in the copy at test time: a fixture under
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

/** A SKILL.md whose frontmatter docs:check accepts: its directory's name and a plain description. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: Say what ${name} does and when to use it.\n---\n\n# ${name}\n`
}

/** Unquoted descriptions YAML reads as a boolean, a number, null, or a YAML 1.1 merge or value key, each planted as its own skill. */
const NON_STRINGS = [['bool', 'true'], ['number', '123'], ['null-word', 'null'], ['tilde', '~'], ['yes-word', 'yes'], ['infinity', '.inf'], ['merge-key', '<<'], ['value-key', '=']] as const

/** One skill planted in the source and, byte for byte, in the mirror, so only its frontmatter is judged. */
function plantMirrored(dir: string, name: string, content: string): void {
  plantSkill(dir, SKILLS_SOURCE, name, content)
  plantSkill(dir, SKILLS_TARGET, name, content)
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
  plantMirrored(dir, 'x', skillFile('x'))
  // Frontmatter that parses as YAML unchanged: a quoted or folded value may hold ": " and " #",
  // a plain one "a:b", "a#b", an apostrophe, and a continuation line; comments, blank lines,
  // other keys, and CRLF endings pass, and a directory without a SKILL.md is no skill.
  plantMirrored(dir, 'quoted', '---\nname: "quoted"\ndescription: "Use when: the user says \\"go\\" # twice."\n---\n')
  plantMirrored(dir, 'folded', '---\nname: folded\ndescription: >\n  Folded: a colon here is text,\n\n  and so is # this.\n---\n')
  plantMirrored(dir, 'plain', '---\n# a comment line\nname: plain\ndescription: Checks a:b and a#b, the user\'s words,\n  and a second line.\n\nallowed-tools: Read, Grep\n---\n')
  plantMirrored(dir, 'crlf', '---\r\nname: crlf\r\ndescription: Written on Windows.\r\n---\r\n\r\n# crlf\r\n')
  // A key holding a nested map or list, as Codex's own skill-creator (metadata) and Claude Code
  // plugins (allowed-tools, hooks) write them, a list at its key's indent included; '' inside
  // single quotes, a comment after a closing quote, and an indented comment under a plain value.
  plantMirrored(dir, 'metadata', '---\nname: metadata\ndescription: Holds a map.\nmetadata:\n  short-description: Short text\n---\n')
  plantMirrored(dir, 'tool-list', '---\nname: tool-list\ndescription: Holds a list.\nallowed-tools:\n  - Read\n  - Grep\n---\n')
  plantMirrored(dir, 'tool-list-at-key', '---\nname: tool-list-at-key\ndescription: Holds a list at its key\'s indent.\nallowed-tools:\n- Read\n- Grep\n---\n')
  plantMirrored(dir, 'hooks', '---\nname: hooks\ndescription: Holds a nested map.\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\n')
  plantMirrored(dir, 'doubled-apostrophe', '---\nname: doubled-apostrophe\ndescription: \'It\'\'s fine: really\'\n---\n')
  plantMirrored(dir, 'quoted-comment', '---\nname: "quoted-comment" # c\ndescription: Fine.\n---\n')
  plantMirrored(dir, 'indented-comment', '---\nname: indented-comment\ndescription: Fine,\n  on two lines.\n  # an indented comment\n---\n')
  // A nested key holding a space or a "#"; flow collections that close at the value's end, with
  // a comment after one, quoted items holding ": " and '', and brackets inside quotes or a comment;
  // a block scalar whose indent digit lets a later line sit less indented than the first, one
  // ended by a less-indented comment, and one whose header comment holds a digit that is no
  // indent digit; \u and \U escapes either side of the surrogates, up to the last character.
  plantMirrored(dir, 'spaced-key', '---\nname: spaced-key\ndescription: Fine.\nmetadata:\n  short description: x\n  a#b: y\n---\n')
  plantMirrored(dir, 'flow-comment', '---\nname: flow-comment\ndescription: Fine.\nargument-hint: [message] # c\n---\n')
  plantMirrored(dir, 'flow-quoted', '---\nname: flow-quoted\ndescription: Fine.\nallowed-tools: [Read, "Bash(git: x)", \'it\'\'s\']\n---\n')
  plantMirrored(dir, 'flow-lines', '---\nname: flow-lines\ndescription: Fine.\nx: {a: "b]", c: [d, # ]\n  e]}\n---\n')
  plantMirrored(dir, 'block-digit', '---\nname: block-digit\ndescription: |2\n    text\n  more\n---\n')
  plantMirrored(dir, 'block-header-digit', '---\nname: block-header-digit\ndescription: > # 4 lines\n  text\n---\n')
  plantMirrored(dir, 'escapes', '---\nname: escapes\ndescription: "Use \\uD7FF \\uE000 \\U00000041 \\U0001F600 \\U0010FFFF."\n---\n')
  plantMirrored(dir, 'block-comment', '---\nname: block-comment\ndescription: >\n  text\n # a comment\n---\n')
  for (const tree of [SKILLS_SOURCE, SKILLS_TARGET]) {
    mkdirSync(join(dir, tree, 'notes'), { recursive: true })
    writeFileSync(join(dir, tree, 'notes', 'README.md'), '# Notes\n')
  }
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
  plantSkill(dir, SKILLS_SOURCE, 'x', skillFile('x'))
  plantSkill(dir, SKILLS_SOURCE, 'y', skillFile('y'))
  plantSkill(dir, SKILLS_TARGET, 'x', `${skillFile('x')}edited\n`)
  plantSkill(dir, SKILLS_TARGET, 'z', skillFile('z'))
  // Skill frontmatter Codex would skip or read differently. The first is new-adr's
  // description as it shipped: "yourself: adding" made the whole block invalid YAML.
  plantMirrored(dir, 'colon-space', '---\nname: colon-space\ndescription: Also use unprompted immediately after making a load-bearing choice yourself: adding or swapping a dependency.\n---\n')
  plantMirrored(dir, 'hash', '---\nname: hash\ndescription: Run the gate #now.\n---\n')
  plantMirrored(dir, 'trailing-colon', '---\nname: trailing-colon\ndescription: Use it for:\n---\n')
  plantMirrored(dir, 'continued', '---\nname: continued\ndescription: The first line is fine,\n  but the second: is not.\n---\n')
  plantMirrored(dir, 'backtick', '---\nname: backtick\ndescription: `pnpm verify` runs the gate.\n---\n')
  plantMirrored(dir, 'no-frontmatter', '# No frontmatter\n')
  plantMirrored(dir, 'unclosed', '---\nname: unclosed\ndescription: Never closed.\n\n# Unclosed\n')
  plantMirrored(dir, 'wrong-name', '---\nname: other-name\ndescription: Named for another directory.\n---\n')
  plantMirrored(dir, 'no-name', '---\ndescription: Has no name.\n---\n')
  plantMirrored(dir, 'empty-description', '---\nname: empty-description\ndescription:\n---\n')
  plantMirrored(dir, 'empty-folded', '---\nname: empty-folded\ndescription: >\n\n---\n')
  plantMirrored(dir, 'stray-line', '---\nname: stray-line\ndescription: Fine.\nnot a key\n---\n')
  plantMirrored(dir, 'twice', '---\nname: twice\nname: twice\ndescription: Named twice.\n---\n')
  // A description YAML reads as a map or a list, not a string.
  plantMirrored(dir, 'usage-map', '---\nname: usage-map\ndescription:\n  Usage: now\n---\n')
  plantMirrored(dir, 'flow-list', '---\nname: flow-list\ndescription: [a, b]\n---\n')
  plantMirrored(dir, 'nested-name', '---\nname:\n  a: b\ndescription: Fine.\n---\n')
  // Quoted values YAML rejects: an apostrophe that closes single quotes early, text after the
  // closing quote, a quote never closed, and a backslash that is no YAML escape.
  plantMirrored(dir, 'apostrophe', '---\nname: apostrophe\ndescription: \'Use when the user\'s words say so\'\n---\n')
  plantMirrored(dir, 'quote-trail', '---\nname: quote-trail\ndescription: "Quoted" and more\n---\n')
  plantMirrored(dir, 'quote-open', '---\nname: quote-open\ndescription: "Never closed\n---\n')
  plantMirrored(dir, 'bad-escape', '---\nname: bad-escape\ndescription: "C:\\Users\\q"\n---\n')
  // Other unquoted shapes YAML rejects: text after a comment line, text after a block
  // indicator, a tab as indentation, a leading "]", and a list item under a plain value.
  plantMirrored(dir, 'comment-then-text', '---\nname: comment-then-text\ndescription: The first line,\n  # a comment\n  then more.\n---\n')
  plantMirrored(dir, 'block-header', '---\nname: block-header\ndescription: > inline text\n---\n')
  plantMirrored(dir, 'tab-indent', '---\nname: tab-indent\ndescription: The first line,\n\tthen a tab.\n---\n')
  plantMirrored(dir, 'bracket', '---\nname: bracket\ndescription: ] opens it.\n---\n')
  plantMirrored(dir, 'list-after-plain', '---\nname: list-after-plain\ndescription: Text,\n- then an item\n---\n')
  // A whitespace-only line opening with a tab, which libyaml rejects too.
  plantMirrored(dir, 'tab-blank', '---\nname: tab-blank\ndescription: Text,\n\t\n  then more.\n---\n')
  // A tab after leading spaces, which libyaml rejects as well: the value's first line under an
  // empty key, a blank line inside a block scalar, a blank line above a list, and a line inside a
  // block scalar with text after it.
  plantMirrored(dir, 'tab-after-space', '---\nname: tab-after-space\ndescription:\n \tUse it when the user asks.\n---\n')
  plantMirrored(dir, 'block-tab-blank', '---\nname: block-tab-blank\ndescription: >\n    Use it.\n  \t\n    More.\n---\n')
  plantMirrored(dir, 'list-tab-blank', '---\nname: list-tab-blank\ndescription: Fine.\nallowed-tools:\n \t\n  - Read\n---\n')
  plantMirrored(dir, 'block-tab-line', '---\nname: block-tab-line\ndescription: >\n  a\n \tb\n  c\n---\n')
  // A space YAML reads as text where JavaScript's \s takes it as indentation: a no-break space
  // opening a value's first line, U+3000 alone on a blank line, a no-break space after a block
  // scalar's indicator, and one after a column-0 "-".
  plantMirrored(dir, 'nbsp-indent', '---\nname: nbsp-indent\ndescription:\n\u00A0\u00A0Use it when the user asks.\n---\n')
  plantMirrored(dir, 'ideo-blank', '---\nname: ideo-blank\ndescription: Use it\n\u3000\n  when the user asks.\n---\n')
  plantMirrored(dir, 'nbsp-header', '---\nname: nbsp-header\ndescription: >\u00A0# c\n  Use it.\n---\n')
  plantMirrored(dir, 'nbsp-dash', '---\nname: nbsp-dash\ndescription: Fine.\nx:\n-\u00A0y\n---\n')
  // Such a space at a value's end, which YAML keeps as text, unlike JavaScript's trim(): after a
  // closing quote, a block indicator, or a closing bracket, where YAML rejects it, and after a
  // name, which it changes. A "#" after one inside a flow collection is text too, so the "}"
  // after it is no comment, and it mismatches the "[".
  plantMirrored(dir, 'nbsp-after-quote', '---\nname: nbsp-after-quote\ndescription: "Use it."\u00A0\n---\n')
  plantMirrored(dir, 'nbsp-after-folded', '---\nname: nbsp-after-folded\ndescription: >\u3000\n  Use it.\n---\n')
  plantMirrored(dir, 'nbsp-after-flow', '---\nname: nbsp-after-flow\ndescription: Fine.\nx: [a]\uFEFF\n---\n')
  plantMirrored(dir, 'name-nbsp', '---\nname: name-nbsp\u00A0\ndescription: Fine.\n---\n')
  plantMirrored(dir, 'flow-nbsp-hash', '---\nname: flow-nbsp-hash\ndescription: Fine.\nx: [a\u00A0#}\n  ]\n---\n')
  // Escapes libyaml rejects though YAML's grammar has them: a surrogate, and one past U+10FFFF.
  plantMirrored(dir, 'surrogate-escape', '---\nname: surrogate-escape\ndescription: "Use \\uD800 it."\n---\n')
  plantMirrored(dir, 'past-unicode-escape', '---\nname: past-unicode-escape\ndescription: "Use \\U00110000 it."\n---\n')
  // Characters libyaml rejects, or reads as a line break: ESC from pasted colored text, NEL, and
  // U+2028, which also ends the line a key opens.
  plantMirrored(dir, 'esc-char', '---\nname: esc-char\ndescription: Use it \x1B[1mnow\x1B[0m.\n---\n')
  plantMirrored(dir, 'nel-char', '---\nname: nel-char\ndescription: Use it\x85now.\n---\n')
  plantMirrored(dir, 'ls-char', '---\nname: ls-char\ndescription: Use it\u2028now.\n---\n')
  // Flow collections that do not close at the value's end: Claude Code's documented
  // argument-hint shape, text after a closed map, a list never closed, and a list closed by "}".
  plantMirrored(dir, 'hint-lists', '---\nname: hint-lists\ndescription: Fine.\nargument-hint: [pr-number] [priority] [assignee]\n---\n')
  plantMirrored(dir, 'map-then-text', '---\nname: map-then-text\ndescription: Fine.\nallowed-tools: {Read} extra\n---\n')
  plantMirrored(dir, 'flow-open', '---\nname: flow-open\ndescription: Fine.\nargument-hint: [a, b\n---\n')
  plantMirrored(dir, 'flow-mismatch', '---\nname: flow-mismatch\ndescription: Fine.\nx: [a}\n---\n')
  // Block scalars with a line indented less than the first, which ends the block; a blank line
  // above the text holding more spaces than it; and text after the comment that ended a block.
  plantMirrored(dir, 'folded-dedent', '---\nname: folded-dedent\ndescription: >\n    text\n  more\n---\n')
  plantMirrored(dir, 'literal-dedent', '---\nname: literal-dedent\ndescription: |\n    text\n  more\n---\n')
  plantMirrored(dir, 'folded-one-space', '---\nname: folded-one-space\ndescription: >\n  text\n more\n---\n')
  plantMirrored(dir, 'block-blank-top', '---\nname: block-blank-top\ndescription: >\n     \n  text\n---\n')
  plantMirrored(dir, 'block-after-comment', '---\nname: block-after-comment\ndescription: >\n   text\n  # c\n   more\n---\n')
  // A block scalar whose header comment holds a digit, which sets no indentation; and a name in a
  // block scalar, whose line breaks and spaces YAML keeps: the break that ends it, a blank line
  // above its text, and, though "-" strips the break, a name in one is refused alike.
  plantMirrored(dir, 'block-header-dedent', '---\nname: block-header-dedent\ndescription: > # 2 lines\n    text\n  more\n---\n')
  plantMirrored(dir, 'block-name-blank', '---\nname: >-\n\n  block-name-blank\ndescription: Fine.\n---\n')
  plantMirrored(dir, 'block-name', '---\nname: |-\n  block-name\ndescription: Fine.\n---\n')
  plantMirrored(dir, 'block-name-clip', '---\nname: |\n  block-name-clip\ndescription: Fine.\n---\n')
  // A description YAML reads as a boolean, a number, null, or a merge or value key.
  for (const [skill, value] of NON_STRINGS)
    plantMirrored(dir, skill, `---\nname: ${skill}\ndescription: ${value}\n---\n`)
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
    '.agents/skills/y/SKILL.md: missing — run `pnpm docs:gen` to mirror .claude/skills',
    '.agents/skills/x/SKILL.md: differs from .claude/skills/x/SKILL.md — never hand-edit the mirror',
    '.agents/skills/z/SKILL.md: has no source under .claude/skills — run `pnpm docs:gen` to remove it',
    '.claude/skills/colon-space/SKILL.md: description is an unquoted value holding ": ", " #", or a colon at a line end, which YAML rejects or cuts short, and then Codex skips the skill; reword it (a comma where the colon was), or quote the whole value',
    '.claude/skills/hash/SKILL.md: description is an unquoted value holding',
    '.claude/skills/trailing-colon/SKILL.md: description is an unquoted value holding',
    '.claude/skills/continued/SKILL.md: description is an unquoted value holding',
    '.claude/skills/backtick/SKILL.md: description opens with "`", which YAML reserves at the start of an unquoted value; reword the start, or quote the whole value',
    '.claude/skills/no-frontmatter/SKILL.md: no frontmatter — open the file with a --- line, then `name: no-frontmatter` and `description: ...`, then a closing --- line',
    '.claude/skills/unclosed/SKILL.md: no frontmatter',
    '.claude/skills/wrong-name/SKILL.md: name "other-name" must be the directory\'s name, "wrong-name"',
    '.claude/skills/no-name/SKILL.md: frontmatter has no name — add `name: no-name`, the directory\'s name',
    '.claude/skills/empty-description/SKILL.md: frontmatter has no description, or an empty one — say what the skill does and when to use it',
    '.claude/skills/empty-folded/SKILL.md: frontmatter has no description, or an empty one',
    '.claude/skills/stray-line/SKILL.md: line 4, in the frontmatter, is not a top-level `key: value` line, so YAML fails to parse the block',
    '.claude/skills/twice/SKILL.md: line 3 sets name a second time, which YAML rejects; keep one',
    '.claude/skills/usage-map/SKILL.md: description must be a string, not a nested map or list',
    '.claude/skills/flow-list/SKILL.md: description must be a string, not a nested map or list',
    '.claude/skills/nested-name/SKILL.md: name must be a string, not a nested map or list',
    '.claude/skills/apostrophe/SKILL.md: description is a quoted value YAML rejects: it must close at its end, with an apostrophe written \'\' inside single quotes and only YAML escapes inside double quotes',
    '.claude/skills/quote-trail/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/quote-open/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/bad-escape/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/comment-then-text/SKILL.md: description continues after a comment line, which ends an unquoted value',
    '.claude/skills/block-header/SKILL.md: description opens a block scalar with "> inline text", which YAML rejects',
    '.claude/skills/tab-indent/SKILL.md: line 4, in the frontmatter, holds a tab in its indentation, which YAML rejects; indent it with spaces only',
    '.claude/skills/bracket/SKILL.md: description opens with "]", which YAML reserves at the start of an unquoted value',
    '.claude/skills/list-after-plain/SKILL.md: line 4, in the frontmatter, is not a top-level `key: value` line',
    '.claude/skills/tab-blank/SKILL.md: line 4, in the frontmatter, is blank but holds a tab, which YAML rejects; empty the line',
    '.claude/skills/tab-after-space/SKILL.md: line 4, in the frontmatter, holds a tab in its indentation, which YAML rejects; indent it with spaces only',
    '.claude/skills/block-tab-blank/SKILL.md: line 5, in the frontmatter, is blank but holds a tab, which YAML rejects; empty the line',
    '.claude/skills/list-tab-blank/SKILL.md: line 5, in the frontmatter, is blank but holds a tab',
    '.claude/skills/block-tab-line/SKILL.md: line 5, in the frontmatter, holds a tab in its indentation',
    '.claude/skills/nbsp-indent/SKILL.md: line 4, in the frontmatter, holds U+00A0 (a space YAML reads as text) in its indentation, which YAML rejects; indent it with spaces only',
    '.claude/skills/ideo-blank/SKILL.md: line 4, in the frontmatter, is blank but holds U+3000 (a space YAML reads as text), which YAML rejects; empty the line',
    '.claude/skills/nbsp-header/SKILL.md: description opens a block scalar with ">\u00A0# c", which YAML rejects',
    '.claude/skills/nbsp-dash/SKILL.md: line 5, in the frontmatter, is not a top-level `key: value` line',
    '.claude/skills/nbsp-after-quote/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/nbsp-after-folded/SKILL.md: description opens a block scalar with ">　", which YAML rejects',
    '.claude/skills/nbsp-after-flow/SKILL.md: x opens a flow collection with "[" that does not close at the end of the value',
    '.claude/skills/name-nbsp/SKILL.md: name "name-nbsp " must be the directory\'s name, "name-nbsp"',
    '.claude/skills/flow-nbsp-hash/SKILL.md: x opens a flow collection with "[" that does not close at the end of the value',
    '.claude/skills/surrogate-escape/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/past-unicode-escape/SKILL.md: description is a quoted value YAML rejects',
    '.claude/skills/esc-char/SKILL.md: line 3, in the frontmatter, holds U+001B, a character YAML rejects or reads as a line break; remove it',
    '.claude/skills/nel-char/SKILL.md: line 3, in the frontmatter, holds U+0085, a character YAML rejects or reads as a line break; remove it',
    '.claude/skills/ls-char/SKILL.md: line 3, in the frontmatter, holds U+2028',
    '.claude/skills/hint-lists/SKILL.md: argument-hint opens a flow collection with "[" that does not close at the end of the value, which YAML rejects; close it there, or quote the whole value',
    '.claude/skills/map-then-text/SKILL.md: allowed-tools opens a flow collection with "{" that does not close at the end of the value',
    '.claude/skills/flow-open/SKILL.md: argument-hint opens a flow collection with "[" that does not close at the end of the value',
    '.claude/skills/flow-mismatch/SKILL.md: x opens a flow collection with "[" that does not close at the end of the value',
    '.claude/skills/folded-dedent/SKILL.md: description is a block scalar with a line indented less than its first text line, which ends the block, so YAML rejects the line; indent every line at least as far',
    '.claude/skills/literal-dedent/SKILL.md: description is a block scalar with a line indented less than its first text line',
    '.claude/skills/folded-one-space/SKILL.md: description is a block scalar with a line indented less than its first text line',
    '.claude/skills/block-blank-top/SKILL.md: description is a block scalar with a blank line above its first text line that holds more spaces than that line, which YAML rejects; empty the blank line',
    '.claude/skills/block-after-comment/SKILL.md: description is a block scalar with text after a comment indented less than the block, which ends it, so YAML rejects the text; indent the comment with the text, or drop it',
    '.claude/skills/block-header-dedent/SKILL.md: description is a block scalar with a line indented less than its first text line',
    '.claude/skills/block-name-clip/SKILL.md: name is a block scalar, whose line breaks and spaces YAML keeps, so it can differ from the directory\'s name; write `name: block-name-clip` on one line',
    '.claude/skills/block-name-blank/SKILL.md: name is a block scalar, whose line breaks and spaces YAML keeps',
    '.claude/skills/block-name/SKILL.md: name is a block scalar, whose line breaks and spaces YAML keeps',
    ...NON_STRINGS.map(([skill]) => `.claude/skills/${skill}/SKILL.md: description is an unquoted value YAML reads as other than a string (null, a boolean, a number, a date, \`<<\`, or \`=\`); reword it, or quote it`),
  ])
  check('a skill with valid frontmatter raises no frontmatter error', !c.out.includes('.claude/skills/x/SKILL.md: ') && !c.out.includes('.claude/skills/y/SKILL.md: '), c.out)
  check('a skill frontmatter break is reported once', c.out.split('.claude/skills/colon-space/SKILL.md: ').length === 2, c.out)
  check('a name that is no string is not also reported missing', c.out.split('.claude/skills/nested-name/SKILL.md: ').length === 2, c.out)
  check('a description that is no string is not also reported empty', c.out.split('.claude/skills/null-word/SKILL.md: ').length === 2, c.out)
  check('a blank line opening with a tab is reported once', c.out.split('.claude/skills/tab-blank/SKILL.md: ').length === 2, c.out)
  // Each break is reported once: a line with a tab stands for the value it continues, so that is
  // not also an empty description, nor the line after it a stray one.
  for (const skill of ['tab-after-space', 'block-tab-blank', 'list-tab-blank', 'block-tab-line', 'esc-char', 'nel-char', 'ls-char', 'block-name-clip', 'nbsp-indent', 'ideo-blank', 'name-nbsp', 'block-name'])
    check(`a ${skill} break is reported once`, c.out.split(`.claude/skills/${skill}/SKILL.md: `).length === 2, c.out)
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
  ])
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
  plantMirrored(dir, 'x', skillFile('x'))
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

// 8. A generated region is compared to the generator, whatever the line endings.
{
  const edited = fixture('clean')
  const index = join(edited, 'docs/internal/decisions/index.md')
  writeFileSync(index, readFileSync(index, 'utf8').replace('| Fourth | accepted |', '| Fourth | proposed |'))
  const e = run('docs:check', edited, withoutCi)
  check('stale index region exits 1', e.status === 1, e.out)
  check('stale index region named', e.out.includes('docs/internal/decisions/index.md: <!-- automd:decisionsIndex --> region is stale'), e.out)

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
  plantSkill(dir, SKILLS_SOURCE, 'x', skillFile('x'))
  const g = run('gen-skills', dir, withoutCi)
  check('gen-skills mirrors the source', g.status === 0 && g.out.includes('.agents/skills (1 files) mirrored from .claude/skills'), g.out)
  check('mirror is byte-identical', readFileSync(join(dir, SKILLS_TARGET, 'x/SKILL.md'), 'utf8') === skillFile('x'))
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
// tracks list items the same way and ends a list item's fence with the item.
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

if (fails.length > 0) {
  console.error(`\n✖ docs fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs fixtures — ${checks} checks pass`)
