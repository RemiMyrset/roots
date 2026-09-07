/**
 * Regression suite for scripts/sync-template.mts. Builds a throwaway "template" repo
 * with a small commit history and a throwaway "child" with no shared history (the
 * situation every "Use this template" repo is in), runs the real script inside the
 * child against a file:// URL, and asserts exit codes, staged paths, the state file,
 * and the printed follow-ups. Runs in CI via `pnpm test:sync`. Node builtins only;
 * git is isolated from the developer's config so signing or hooks cannot interfere.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SCRIPT = join(import.meta.dirname, 'sync-template.mts')
const REAL_SCRIPT = readFileSync(SCRIPT, 'utf8')
const STATE = '.template-sync.json'

const tmp = mkdtempSync(join(tmpdir(), 'roots-sync-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
const gitconfig = join(tmp, 'gitconfig')
writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function commit(dir: string, message: string): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD').trim()
}

interface Run { status: number | null, stdout: string, stderr: string }
function run(cwd: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts/sync-template.mts'), ...args], { cwd, env: ENV, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** `git diff --cached --name-status` as "X path" lines (rename entries collapse to their destination). */
function staged(cwd: string): string[] {
  const parts = git(cwd, 'diff', '--cached', '--name-status', '-z').split('\0').filter(Boolean)
  const lines: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const status = (parts[i] ?? '').slice(0, 1)
    if (status === 'R' || status === 'C')
      i++
    lines.push(`${status} ${parts[i + 1] ?? ''}`)
  }
  return lines
}

function readState(cwd: string): { url?: string, commit?: string } {
  try {
    return JSON.parse(readFileSync(join(cwd, STATE), 'utf8')) as { url?: string, commit?: string }
  }
  catch {
    return {}
  }
}

const fails: string[] = []
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok)
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// --- template fixture -------------------------------------------------------------
const template = join(tmp, 'template')
mkdirSync(template)
git(template, 'init', '-q', '-b', 'main')
const pkg = (scripts: Record<string, string>): string => `${JSON.stringify({ name: 'fixture', scripts }, null, 2)}\n`
const T1_SCRIPTS = {
  'docs:gen': 'automd && node scripts/docs/gen-llms.mts',
  'docs:check': 'node scripts/docs/check-docs.mts',
  'test:hooks': 'node scripts/test-hooks.mts',
  'sync:template': 'node scripts/sync-template.mts',
  'lint': 'CI=1 eslint .',
}
write(template, 'package.json', pkg(T1_SCRIPTS))
write(template, 'scripts/docs/gen-llms.mts', '// gen\n')
write(template, 'scripts/docs/check-docs.mts', '// check v1\n')
write(template, 'scripts/sync-template.mts', `${REAL_SCRIPT}// t1\n`) // an older copy of the real script
write(template, 'scripts/test-hooks.mts', '// hooks\n')
write(template, '.claude/skills/x/SKILL.md', '# x\n')
write(template, '.github/workflows/docs.yml', 'v1\n')
write(template, 'docs/template/x.md', '# x v1\n')
write(template, 'src/index.ts', 'export const v = 1\n')
commit(template, 'chore: t1')
git(template, 'tag', 'v9.9.9')

// The child: the T1 tree with no git history in common, plus its own customizations.
const child = join(tmp, 'child')
cpSync(template, child, { recursive: true, filter: src => !/\/\.git(?:\/|$)/.test(src) })
git(child, 'init', '-q', '-b', 'main')
write(child, 'package.json', pkg({ ...T1_SCRIPTS, lint: 'eslint .', dev: 'vite' }))
commit(child, 'chore: init')

// T2: the motivating case — a mechanic is deleted and the script that called it changes.
rmSync(join(template, 'scripts/docs/gen-llms.mts'))
const T2_SCRIPTS = { ...T1_SCRIPTS, 'docs:gen': 'automd', 'test:sync': 'node scripts/test-sync.mts' }
write(template, 'package.json', pkg(T2_SCRIPTS))
write(template, 'scripts/test-sync.mts', '// test\n')
write(template, 'scripts/sync-template.mts', REAL_SCRIPT)
write(template, '.github/workflows/docs.yml', 'v2\n')
write(template, 'docs/template/x.md', '# x v2\n')
write(template, 'src/index.ts', 'export const v = 2\n')
const T2 = commit(template, 'refactor(docs)!: drop gen-llms\n\nBREAKING CHANGE: docs:gen is now automd only; delete docs/llms.txt.\n')
const URL = pathToFileURL(template).href

// 1. Not a git repository.
{
  const nogit = join(tmp, 'nogit')
  write(nogit, 'scripts/sync-template.mts', REAL_SCRIPT)
  const r = run(nogit, URL)
  check('not-a-repo exits 1', r.status === 1, `status ${r.status}`)
  check('not-a-repo names the cause', r.stderr.includes('Not a git repository'))
}

// 2. First sync.
{
  const r = run(child, URL)
  check('first sync exits 0', r.status === 0, r.stderr)
  check('first sync says so', r.stdout.includes('first sync'))
  const s = staged(child)
  for (const want of ['M .github/workflows/docs.yml', 'D scripts/docs/gen-llms.mts', 'A scripts/test-sync.mts', 'M scripts/sync-template.mts', 'M docs/template/x.md', `A ${STATE}`])
    check(`first sync stages ${want}`, s.includes(want), s.join(', '))
  for (const never of ['src/index.ts', 'package.json'])
    check(`first sync leaves ${never} alone`, !s.some(l => l.endsWith(never)), s.join(', '))
  check('self-update is annotated', r.stdout.includes('new version runs next time'))
  const st = readState(child)
  check('state records the URL', st.url === URL, st.url ?? 'none')
  check('state records the template head', st.commit === T2, st.commit ?? 'none')
  check('docs:gen follow-up listed', r.stdout.includes('scripts.docs:gen'))
  check('docs:gen shows both values', r.stdout.includes('template: automd') && r.stdout.includes('yours:    automd && node scripts/docs/gen-llms.mts'))
  check('docs:gen notes the deleted file', r.stdout.includes('references scripts/docs/gen-llms.mts, which this sync deletes'))
  check('test:sync reported missing', r.stdout.includes('scripts.test:sync') && r.stdout.includes('missing here'))
  check('two-way mode says differs for lint', r.stdout.includes('scripts.lint  differs'))
  check('child-only script never mentioned', !r.stdout.includes('scripts.dev'))
  check('no template tags imported', git(child, 'tag', '-l').trim() === '', git(child, 'tag', '-l'))
  check('remote has no-tags set', git(child, 'config', 'remote.template.tagOpt').trim() === '--no-tags')
}

// 3. Up to date, with the docs:gen follow-up applied and lint kept customized.
{
  git(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(child, 'package.json', pkg({ ...T2_SCRIPTS, lint: 'eslint .', dev: 'vite' }))
  commit(child, 'chore: apply follow-ups')
  const r = run(child)
  check('up-to-date exits 0', r.status === 0, r.stderr)
  check('up-to-date reports unchanged', r.stdout.includes('unchanged since last sync'))
  check('up-to-date stages nothing', r.stdout.includes('Already up to date') && staged(child).length === 0, staged(child).join(', '))
  check('applied follow-up gone', !r.stdout.includes('scripts.docs:gen'))
  check('customized lint listed compactly', r.stdout.includes('Customized locally') && r.stdout.includes('scripts.lint') && !r.stdout.includes('scripts.lint  '))
}

// 4. A breaking template commit since the last sync.
write(template, 'scripts/docs/check-docs.mts', '// check v2\n')
write(template, 'package.json', pkg({ ...T2_SCRIPTS, 'docs:check': 'node scripts/docs/check-docs.mts --strict' }))
write(template, '.github/labels.yml', 'labels\n')
const T3 = commit(template, 'feat(docs)!: strict docs:check\n\nBREAKING CHANGE: docs:check now fails on stale review dates.\n')
{
  const r = run(child)
  check('commits-since exits 0', r.status === 0, r.stderr)
  check('commits-since counts one', r.stdout.includes('1 commit since last sync'))
  check('breaking commit marked', r.stdout.includes('! ') && r.stdout.includes('feat(docs)!: strict docs:check'))
  check('breaking paragraph printed', r.stdout.includes('BREAKING CHANGE: docs:check now fails on stale review dates.'))
  const s = staged(child)
  for (const want of ['A .github/labels.yml', 'M scripts/docs/check-docs.mts', `M ${STATE}`])
    check(`commits-since stages ${want}`, s.includes(want), s.join(', '))
  check('state advances to T3', readState(child).commit === T3)
  check('three-way mode names the upstream change', r.stdout.includes('scripts.docs:check  changed on the template since last sync'))
  git(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 5. Lost baseline: the recorded commit is not in the template's history.
{
  write(child, STATE, `${JSON.stringify({ url: URL, commit: 'd'.repeat(40) }, null, 2)}\n`)
  commit(child, 'chore: bad state')
  const r = run(child)
  check('lost baseline exits 0', r.status === 0, r.stderr)
  check('lost baseline explained', r.stdout.includes('not in its history'))
  check('lost baseline rewrites state', readState(child).commit === T3)
  git(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 6. Corrupt state file.
{
  write(child, STATE, '{not json\n')
  commit(child, 'chore: corrupt state')
  const r = run(child)
  check('corrupt state exits 0', r.status === 0, r.stderr)
  check('corrupt state warned', r.stderr.includes('unreadable'))
  check('corrupt state rewritten', readState(child).commit === T3)
  git(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 7. Dirty synced path refused.
{
  write(child, '.claude/skills/x/SKILL.md', '# x edited\n')
  const r = run(child)
  check('dirty path exits 1', r.status === 1, `status ${r.status}`)
  check('dirty path named', r.stderr.includes('Uncommitted changes') && r.stderr.includes('.claude/skills/x/SKILL.md'))
  git(child, 'checkout', '--', '.')
}

// 8. Bootstrap: a repo without the script runs an untracked copy of it.
{
  const fresh = join(tmp, 'fresh')
  mkdirSync(fresh)
  git(fresh, 'init', '-q', '-b', 'main')
  write(fresh, 'package.json', pkg({ build: 'tsc' }))
  commit(fresh, 'chore: init')
  write(fresh, 'scripts/sync-template.mts', REAL_SCRIPT)
  const r = run(fresh, URL)
  check('bootstrap exits 0', r.status === 0, r.stderr)
  check('bootstrap stages the script itself', staged(fresh).includes('A scripts/sync-template.mts'), staged(fresh).join(', '))
  check('bootstrap lists sync:template as missing', r.stdout.includes('scripts.sync:template') && r.stdout.includes('missing here'))
  // A repo with an older TRACKED copy bootstraps the same way: the fresh copy shows as
  // modified, and the script must exempt itself from its own dirty check.
  git(fresh, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(fresh, 'scripts/sync-template.mts', `${REAL_SCRIPT}// newer copy dropped in by hand\n`)
  const again = run(fresh, URL)
  check('modified self is exempt from the dirty check', again.status === 0, again.stderr)
  check('modified self is replaced by the template version', readFileSync(join(fresh, 'scripts/sync-template.mts'), 'utf8') === REAL_SCRIPT)
}

// 9. Unreachable template.
{
  const r = run(child, 'file:///nonexistent/roots')
  check('bad url exits 1', r.status === 1, `status ${r.status}`)
  check('bad url explained', r.stderr.includes('Could not fetch'))
  check('bad url leaves state alone', readState(child).url === URL)
}

// 10. No package.json in the child.
{
  const bare = join(tmp, 'bare')
  mkdirSync(bare)
  git(bare, 'init', '-q', '-b', 'main')
  write(bare, 'README.md', '# bare\n')
  commit(bare, 'chore: init')
  write(bare, 'scripts/sync-template.mts', REAL_SCRIPT)
  const r = run(bare, URL)
  check('no package.json exits 0', r.status === 0, r.stderr)
  check('no package.json skips follow-ups', r.stdout.includes('no package.json here'))
}

// 11. exclude / include from the state file; 12. URL taken from the state with no remote.
write(template, '.github/workflows/docs.yml', 'v3\n')
write(template, 'turbo.json', '{}\n')
commit(template, 'chore: turbo')
{
  write(child, STATE, `${JSON.stringify({ url: URL, commit: T3, exclude: ['.github/workflows/docs.yml'], include: ['turbo.json'] }, null, 2)}\n`)
  commit(child, 'chore: exclude and include')
  git(child, 'remote', 'remove', 'template')
  const r = run(child)
  check('exclude/include exits 0', r.status === 0, r.stderr)
  const s = staged(child)
  check('excluded path not staged', !s.includes('M .github/workflows/docs.yml'), s.join(', '))
  check('included path staged', s.includes('A turbo.json'), s.join(', '))
  check('url taken from state re-adds the remote', git(child, 'remote', 'get-url', 'template').trim() === URL)
  check('exclude survives the rewrite', readFileSync(join(child, STATE), 'utf8').includes('"exclude"'))
  git(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 13. Nothing to pull from a repo that is not a roots template.
{
  const other = join(tmp, 'other')
  mkdirSync(other)
  git(other, 'init', '-q', '-b', 'main')
  write(other, 'README.md', '# other\n')
  commit(other, 'chore: init')
  const r = run(child, pathToFileURL(other).href)
  check('non-template exits 1', r.status === 1, `status ${r.status}`)
  check('non-template explained', r.stderr.includes('Nothing to pull'))
  check('state untouched by a failed run', existsSync(join(child, STATE)) && readState(child).url === URL)
}

if (fails.length > 0) {
  console.error(`\n✖ sync fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ sync fixtures — ${checks} checks pass`)
