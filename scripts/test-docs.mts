/**
 * Regression suite for the docs checkers (scripts/docs/check-docs.mts and
 * check-portability.mts) — the two densest regex files in the repo, whose comments each
 * record a past bug — plus the readers (readers.mts) called directly and the skills mirror
 * generator (gen-skills.mts). Copies a fixture tree (scripts/docs/fixtures/clean, /broken)
 * to a temp dir, runs each script with that cwd, and asserts the exit code and the messages.
 * Also pins the rulebook budget, the CI-annotation gating, a missing docs dir, the
 * three-step repo-root fallback, the stale-region comparison (with a CRLF checkout), and
 * the skills mirror clean, drifted, generated, and absent. The skill trees are planted in
 * the copy at test time: a fixture under `.claude/skills` would be listed as a live skill.
 * Runs in CI on Ubuntu and Windows via `pnpm test:docs`. Node builtins only.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { decisionsSidebar, escapeCell, readDecisions, readSpecs, specsSidebar } from './docs/readers.mts'
import { SKILLS_SOURCE, SKILLS_TARGET } from './docs/skills.mts'

const FIXTURES = join(import.meta.dirname, 'docs', 'fixtures')
const CHECKERS = {
  'docs:check': join(import.meta.dirname, 'docs', 'check-docs.mts'),
  'docs:portability': join(import.meta.dirname, 'docs', 'check-portability.mts'),
  'gen-skills': join(import.meta.dirname, 'docs', 'gen-skills.mts'),
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
function run(checker: Checker, cwd: string, env: NodeJS.ProcessEnv = process.env): Run {
  const r = spawnSync(process.execPath, [CHECKERS[checker]], { cwd, env, encoding: 'utf8' })
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

const today = new Date().toISOString().slice(0, 10)
const CI_KEY = 'GITHUB_ACTIONS' // a const key: tsc refuses dot access on process.env, eslint refuses a bracketed literal
const withoutCi = { ...process.env }
delete withoutCi[CI_KEY]

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
  check('clean docs:check counts records', c.out.includes('✔ docs:check — 2 decision(s)'), c.out)
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
    'docs/internal/decisions/bad-name.md: filename must be NNNN-kebab-title.md',
    'docs/internal/decisions/0001-mismatch.md: H1 number 0002 does not match filename 0001',
    'status "unknown" not in vocabulary',
    '0001-mismatch.md: missing or non-real "- **Date:** YYYY-MM-DD" bullet',
    '0002-superseded.md: superseded status must link the newer record',
    '0003-missing-target.md: superseded-by target ./0004-nope.md does not exist',
    'docs/internal/decisions/0004-no-h1.md: H1 must be "# 0004. Title"',
    'docs/internal/decisions/0005-no-status.md: missing "- **Status:** ..." bullet',
    'duplicate decision number 0002',
    'automd generator failed and wrote a warning comment',
    'docs/internal/stale.md: <!-- automd:decisionsIndex --> region is stale — run `pnpm docs:gen`',
    'docs/internal/unclosed.md: missing <!-- /automd --> after <!-- automd:custom --> (line 3)',
    'docs/internal/specs/index.md: missing <!-- automd:specIndex --> marker',
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
    '.agents/skills/y/SKILL.md: missing — run `pnpm docs:gen` to mirror .claude/skills',
    '.agents/skills/x/SKILL.md: differs from .claude/skills/x/SKILL.md — never hand-edit the mirror',
    '.agents/skills/z/SKILL.md: has no source under .claude/skills — run `pnpm docs:gen` to remove it',
  ])
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
    'docs/internal/README.md  no H1',
    'docs/internal/README.md  README.md inside a site directory',
    'docs/index.md  index.md outside a site directory',
  ])
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
  writeFileSync(index, readFileSync(index, 'utf8').replace('| Second | accepted |', '| Second | proposed |'))
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
  const decisions = readDecisions(dir).map(d => [d.num, d.title, d.status])
  check('readDecisions reads both records past the fenced Status', same(decisions, [['0001', 'First', 'superseded by [0002](./0002-second.md)'], ['0002', 'Second', 'accepted']]), JSON.stringify(decisions))
  const specs = readSpecs(dir)
  check('readSpecs reads the one spec', same(specs, [{ area: 'cli', file: 'hello.md', title: 'Hello' }]), JSON.stringify(specs))
  check('decisionsSidebar links each record', same(decisionsSidebar(dir), [{ text: '0001. First', link: '/decisions/0001-first' }, { text: '0002. Second', link: '/decisions/0002-second' }]), JSON.stringify(decisionsSidebar(dir)))
  check('specsSidebar links each spec', same(specsSidebar(dir), [{ text: 'cli: Hello', link: '/specs/cli/hello' }]), JSON.stringify(specsSidebar(dir)))
  check('escapeCell escapes a bare pipe', escapeCell('a | b') === 'a \\| b')
  check('escapeCell leaves an escaped pipe alone', escapeCell('a \\| b') === 'a \\| b')

  mkdirSync(join(dir, 'docs/internal/decisions/0003-dir.md'))
  check('a directory named like a record is not one', readDecisions(dir).length === 2)
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

if (fails.length > 0) {
  console.error(`\n✖ docs fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs fixtures — ${checks} checks pass`)
