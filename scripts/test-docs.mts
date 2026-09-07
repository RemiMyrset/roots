/**
 * Regression suite for the docs checkers (scripts/docs/check-docs.mts and
 * check-portability.mts) — the two densest regex files in the repo, whose comments each
 * record a past bug. Copies a fixture tree (scripts/docs/fixtures/clean, /broken) to a temp
 * dir, runs each checker with that cwd, and asserts the exit code and the messages. Also
 * pins the rulebook budget, the CI-annotation gating, a missing docs dir, and the three-step
 * repo-root fallback. Runs in CI on Ubuntu and Windows via `pnpm test:docs`. Node builtins
 * only.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const FIXTURES = join(import.meta.dirname, 'docs', 'fixtures')
const CHECKERS = {
  'docs:check': join(import.meta.dirname, 'docs', 'check-docs.mts'),
  'docs:portability': join(import.meta.dirname, 'docs', 'check-portability.mts'),
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

const today = new Date().toISOString().slice(0, 10)
const CI_KEY = 'GITHUB_ACTIONS' // a const key: tsc refuses dot access on process.env, eslint refuses a bracketed literal
const withoutCi = { ...process.env }
delete withoutCi[CI_KEY]

// 1. The clean tree passes both checkers with nothing on stderr.
{
  const dir = fixture('clean')
  const spec = join(dir, 'docs/internal/specs/cli/hello.md')
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('2026-09-07', today))
  const c = run('docs:check', dir, withoutCi)
  check('clean docs:check exits 0', c.status === 0, c.out)
  check('clean docs:check counts records', c.out.includes('✔ docs:check — 2 decision(s)'), c.out)
  check('clean docs:check has no warnings', !c.out.includes('warning'), c.out)
  const p = run('docs:portability', dir, withoutCi)
  check('clean docs:portability exits 0', p.status === 0, p.out)
  check('clean docs:portability has no warnings', !p.out.includes('warning'), p.out)
}

// 2. The broken tree: every structural rule fires once, with its path.
{
  const dir = fixture('broken')
  const c = run('docs:check', dir, withoutCi)
  check('broken docs:check exits 1', c.status === 1, `status ${c.status}`)
  expectAll('broken docs:check', c.out, [
    'docs/internal/decisions/bad-name.md: filename must be NNNN-kebab-title.md',
    'docs/internal/decisions/0001-mismatch.md: H1 number 0002 does not match filename 0001',
    'status "unknown" not in vocabulary',
    '0001-mismatch.md: missing or non-real "- **Date:** YYYY-MM-DD" bullet',
    '0002-superseded.md: superseded status must link the newer record',
    'duplicate decision number 0002',
    'automd generator failed and wrote a warning comment',
    'docs/internal/specs/index.md: missing <!-- automd:specIndex --> marker',
    'docs/internal/specs/stray.md: specs must live in an area directory',
    'docs/internal/specs/cli/stale.md: Source path `src/nope.txt` does not exist',
    'docs/internal/specs/cli/nested/deep.md: specs must be flat within an area',
    'docs/internal/specs/cli/no-review.md: missing "- **Last reviewed:**',
    'Tests is (pending)',
    'last reviewed 2020-01-01 (> 180 days ago)',
    'last reviewed 2999-01-01 is in the future',
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
  ])
}

// 4. The rulebook budget applies to every AGENTS.md in the tree.
{
  const dir = fixture('clean')
  mkdirSync(join(dir, 'packages/x'), { recursive: true })
  writeFileSync(join(dir, 'packages/x/AGENTS.md'), `# Big\n${'- line\n'.repeat(200)}`)
  const c = run('docs:check', dir, withoutCi)
  check('over-budget rulebook exits 1', c.status === 1, c.out)
  check('over-budget rulebook named with a forward-slash path', c.out.includes('packages/x/AGENTS.md: 201 lines exceeds the 200-line rulebook budget'), c.out)
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

if (fails.length > 0) {
  console.error(`\n✖ docs fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ docs fixtures — ${checks} checks pass`)
