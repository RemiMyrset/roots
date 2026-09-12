/**
 * Regression suite for scripts/sync-template.mts. Builds a throwaway "template" repo
 * with a small, date-controlled commit history and several throwaway consumers — a
 * "Use this template" copy with no shared history, a pristine copy, a fork, a repo that
 * predates the script, two whose checkouts a required smudge filter makes git abort —
 * runs the real script inside each against a file:// URL, and asserts exit codes, the
 * inferred baseline, staged paths, skipped paths, the state file, and the printed
 * follow-ups. Runs in CI on Ubuntu and Windows via `pnpm test:sync`. Node
 * builtins only; git is isolated from the developer's config so signing or hooks cannot
 * interfere. No symlinks anywhere, so no platform privileges are needed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SCRIPT = join(import.meta.dirname, 'sync-template.mts')
const REAL_SCRIPT = readFileSync(SCRIPT, 'utf8')
const STATE = '.template-sync.json'

const tmp = mkdtempSync(join(tmpdir(), 'sync-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
const gitconfig = join(tmp, 'gitconfig')
writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' }

// Fixture commit times, so the root-time baseline inference has something to bite on.
const T1_AT = '2026-01-01T00:00:00Z'
const COPY_AT = '2026-01-01T12:00:00Z'
const T2_AT = '2026-01-02T00:00:00Z'
const T3_AT = '2026-01-03T00:00:00Z'
const T4_AT = '2026-01-04T00:00:00Z'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** git for assertions and follow-on commits: never throws, returns '' on failure, so a failed sync reports instead of crashing the suite. */
function gitSafe(cwd: string, ...args: string[]): string {
  try {
    return git(cwd, ...args)
  }
  catch {
    return ''
  }
}

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function commit(dir: string, message: string, date?: string): string {
  const env = date === undefined ? ENV : { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  execFileSync('git', ['add', '-A'], { cwd: dir, env, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env, stdio: 'ignore' })
  return git(dir, 'rev-parse', 'HEAD').trim()
}

/** Copies a working tree without its .git directory (segment-aware, so it works with Windows separators). */
function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, filter: src => !src.split(sep).includes('.git') })
}

interface Run { status: number | null, stdout: string, stderr: string, detail: string }
function run(cwd: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts/sync-template.mts'), ...args], { cwd, env: ENV, encoding: 'utf8' })
  const detail = `exit ${r.status ?? `null (${r.error?.message ?? 'no error'})`}; stderr: ${(r.stderr ?? '').trim()}; stdout: ${(r.stdout ?? '').trim().slice(0, 600)}`
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', detail }
}

/** `git diff --cached --name-status` as "X path" lines (rename entries collapse to their destination). */
function staged(cwd: string): string[] {
  const parts = gitSafe(cwd, 'diff', '--cached', '--name-status', '-z').split('\0').filter(Boolean)
  const lines: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const status = (parts[i] ?? '').slice(0, 1)
    if (status === 'R' || status === 'C')
      i++
    lines.push(`${status} ${parts[i + 1] ?? ''}`)
  }
  return lines
}

interface State { url?: string, ref?: string, commit?: string }
function readState(cwd: string): State {
  try {
    return JSON.parse(readFileSync(join(cwd, STATE), 'utf8')) as State
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
const settings = (deny: string[], hook: string): string => `${JSON.stringify({ permissions: { allow: ['Bash(git status:*)'], deny }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hook }] }] } }, null, 2)}\n`
write(template, '.claude/settings.json', settings(['Read(**/.env)'], 'node hooks.mts'))
write(template, '.github/workflows/ci.yml', 'ci v1\n')
write(template, '.github/workflows/docs.yml', 'v1\n')
write(template, '.codex/hooks.json', '{}\n')
write(template, '.gemini/settings.json', '{}\n')
write(template, '.claude/output-styles/writing.md', '---\nname: writing\n---\nrules v1\n')
write(template, 'docs/template/x.md', '# x v1\n')
write(template, 'src/index.ts', 'export const v = 1\n')
const T1 = commit(template, 'chore: t1', T1_AT)
git(template, 'tag', 'v9.9.9')

// Consumers made from T1 with no git history in common, dated after T1 and before T2:
// `child` customizes package.json (so only the root-time inference can place it),
// `copy` is pristine (its root tree equals T1's tree exactly).
const child = join(tmp, 'child')
copyTree(template, child)
git(child, 'init', '-q', '-b', 'main')
write(child, 'package.json', pkg({ ...T1_SCRIPTS, lint: 'eslint .', dev: 'vite' }))
commit(child, 'chore: init', COPY_AT)
const copy = join(tmp, 'copy')
copyTree(template, copy)
git(copy, 'init', '-q', '-b', 'main')
commit(copy, 'Initial commit', COPY_AT)

// T2: the motivating case — a mechanic is deleted and the script that called it changes;
// the agent-skills copy and the CI workflow change too.
rmSync(join(template, 'scripts/docs/gen-llms.mts'))
const T2_SCRIPTS = { ...T1_SCRIPTS, 'docs:gen': 'automd', 'test:sync': 'node scripts/test-sync.mts' }
write(template, 'package.json', pkg(T2_SCRIPTS))
write(template, 'scripts/test-sync.mts', '// test\n')
write(template, 'scripts/sync-template.mts', REAL_SCRIPT)
write(template, '.github/workflows/ci.yml', 'ci v2\n')
write(template, '.github/workflows/docs.yml', 'v2\n')
write(template, '.agents/skills/x/SKILL.md', '# x\n')
write(template, 'docs/template/x.md', '# x v2\n')
write(template, 'src/index.ts', 'export const v = 2\n')
const T2 = commit(template, 'refactor(docs)!: drop gen-llms\n\nBREAKING CHANGE: docs:gen is now automd only; delete docs/llms.txt.\n', T2_AT)
const URL = pathToFileURL(template).href

// A fork shares history with the template (merge-base is T2); its origin must not look
// like the template, or the self-guard refuses.
const fork = join(tmp, 'fork')
git(tmp, 'clone', '-q', template, fork)
git(fork, 'remote', 'set-url', 'origin', 'file:///example/fork')
write(fork, 'src/app.ts', 'export const app = true\n')
commit(fork, 'feat: own work')

// 1. Not a git repository.
{
  const nogit = join(tmp, 'nogit')
  write(nogit, 'scripts/sync-template.mts', REAL_SCRIPT)
  const r = run(nogit, URL)
  check('not-a-repo exits 1', r.status === 1, `status ${r.status}`)
  check('not-a-repo names the cause', r.stderr.includes('Not a git repository'))
}

// 2. First sync of a customized template copy: baseline inferred from the root commit's time.
{
  const r = run(child, URL)
  check('first sync exits 0', r.status === 0, r.detail)
  check('first sync says so', r.stdout.includes('first sync'))
  check('root-time baseline inferred', r.stdout.includes(`Baseline: ${T1.slice(0, 7)} (root time)`), r.stdout)
  check('one commit since the baseline', r.stdout.includes('1 commit since the baseline'))
  check('breaking commit marked on first sync', r.stdout.includes('! ') && r.stdout.includes('refactor(docs)!: drop gen-llms'))
  const s = staged(child)
  for (const want of ['M .github/workflows/ci.yml', 'M .github/workflows/docs.yml', 'D scripts/docs/gen-llms.mts', 'A scripts/test-sync.mts', 'M scripts/sync-template.mts', 'M docs/template/x.md', 'A .agents/skills/x/SKILL.md', `A ${STATE}`])
    check(`first sync stages ${want}`, s.includes(want), s.join(', '))
  for (const never of ['src/index.ts', 'package.json'])
    check(`first sync leaves ${never} alone`, !s.some(l => l.endsWith(never)), s.join(', '))
  check('agent skills copy is a plain file', existsSync(join(child, '.agents/skills/x/SKILL.md')) && gitSafe(child, 'ls-files', '-s', '--', '.agents/skills/x/SKILL.md').startsWith('100644'))
  check('self-update is annotated', r.stdout.includes('new version runs next time'))
  const st = readState(child)
  check('state records the URL', st.url === URL, st.url ?? 'none')
  check('state records the template head', st.commit === T2, st.commit ?? 'none')
  check('state has no ref when tracking main', st.ref === undefined)
  check('docs:gen follow-up listed', r.stdout.includes('scripts.docs:gen  changed on the template since the baseline'))
  check('docs:gen shows both values', r.stdout.includes('template: automd') && r.stdout.includes('yours:    automd && node scripts/docs/gen-llms.mts'))
  check('docs:gen notes the deleted file', r.stdout.includes('references scripts/docs/gen-llms.mts, which this sync deletes'))
  check('test:sync reported missing', r.stdout.includes('scripts.test:sync') && r.stdout.includes('missing here'))
  check('customized lint listed compactly on first sync', r.stdout.includes('Customized locally') && r.stdout.includes('scripts.lint') && !r.stdout.includes('scripts.lint  '))
  check('child-only script never mentioned', !r.stdout.includes('scripts.dev'))
  check('settings equal on first sync', r.stdout.includes('Settings: none new.'), r.stdout)
  check('no template tags imported', gitSafe(child, 'tag', '-l').trim() === '', gitSafe(child, 'tag', '-l'))
  check('remote has no-tags set', gitSafe(child, 'config', 'remote.template.tagOpt').trim() === '--no-tags')
}

// 2b. First sync of a pristine copy: the root commit's tree is a template tree.
{
  const r = run(copy, URL)
  check('pristine copy exits 0', r.status === 0, r.detail)
  check('root-tree baseline inferred', r.stdout.includes(`Baseline: ${T1.slice(0, 7)} (root tree)`), r.stdout)
  check('pristine copy lists the commit since', r.stdout.includes('1 commit since the baseline'))
  check('pristine copy records the head', readState(copy).commit === T2)
}

// 3. Up to date, with the docs:gen follow-up applied and lint kept customized.
{
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(child, 'package.json', pkg({ ...T2_SCRIPTS, lint: 'eslint .', dev: 'vite' }))
  commit(child, 'chore: apply follow-ups')
  const r = run(child)
  check('up-to-date exits 0', r.status === 0, r.detail)
  check('up-to-date reports unchanged', r.stdout.includes('unchanged since last sync'))
  check('up-to-date prints no baseline line', !r.stdout.includes('Baseline:'))
  check('up-to-date stages nothing', r.stdout.includes('Already up to date') && staged(child).length === 0, staged(child).join(', '))
  check('applied follow-up gone', !r.stdout.includes('scripts.docs:gen'))
  check('customized lint listed compactly', r.stdout.includes('Customized locally') && r.stdout.includes('scripts.lint') && !r.stdout.includes('scripts.lint  '))
}

// 4. A breaking template commit since the last sync; a template page is renamed, so the
// staged rename is reported by its destination.
git(template, 'mv', 'docs/template/x.md', 'docs/template/y.md')
write(template, 'scripts/docs/check-docs.mts', '// check v2\n')
write(template, 'package.json', pkg({ ...T2_SCRIPTS, 'docs:check': 'node scripts/docs/check-docs.mts --strict' }))
write(template, '.github/labels.yml', 'labels\n')
write(template, '.claude/settings.json', settings(['Read(**/.env)', 'Read(**/.pgpass)'], 'node hooks.mts --strict'))
const T3 = commit(template, 'feat(docs)!: strict docs:check\n\nBREAKING CHANGE: docs:check now fails on stale review dates.\n', T3_AT)
{
  const r = run(child)
  check('commits-since exits 0', r.status === 0, r.detail)
  check('commits-since counts one', r.stdout.includes('1 commit since last sync'))
  check('breaking commit marked', r.stdout.includes('! ') && r.stdout.includes('feat(docs)!: strict docs:check'))
  check('breaking paragraph printed', r.stdout.includes('BREAKING CHANGE: docs:check now fails on stale review dates.'))
  const s = staged(child)
  for (const want of ['A .github/labels.yml', 'M scripts/docs/check-docs.mts', 'R docs/template/y.md', `M ${STATE}`])
    check(`commits-since stages ${want}`, s.includes(want), s.join(', '))
  check('rename reported by its destination', r.stdout.includes('  R  docs/template/y.md') && !r.stdout.includes('  R  docs/template/x.md'), r.stdout)
  check('state advances to T3', readState(child).commit === T3)
  check('three-way mode names the upstream change', r.stdout.includes('scripts.docs:check  changed on the template since last sync'))
  check('missing deny rule listed', r.stdout.includes('permissions.deny Read(**/.pgpass)  missing here'), r.stdout)
  check('present rules not listed', !r.stdout.includes('Read(**/.env)') && !r.stdout.includes('Bash(git status:*)'), r.stdout)
  check('changed hook command listed', r.stdout.includes('hooks.PreToolUse command  differs') && r.stdout.includes('template: node hooks.mts --strict') && r.stdout.includes('yours:    node hooks.mts'), r.stdout)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 4b. A fork: shared history gives an exact baseline, and its own files are untouched.
{
  const r = run(fork, URL)
  check('fork exits 0', r.status === 0, r.detail)
  check('shared-history baseline inferred', r.stdout.includes(`Baseline: ${T2.slice(0, 7)} (shared history)`), r.stdout)
  check('fork lists the commit since', r.stdout.includes('1 commit since the baseline'))
  const s = staged(fork)
  for (const want of ['A .github/labels.yml', 'M scripts/docs/check-docs.mts', `A ${STATE}`])
    check(`fork stages ${want}`, s.includes(want), s.join(', '))
  check('fork keeps its own file', !s.some(l => l.endsWith('src/app.ts')) && existsSync(join(fork, 'src/app.ts')))
}

// 5. Lost baseline: the recorded commit is not in the template's history.
{
  write(child, STATE, `${JSON.stringify({ url: URL, commit: 'd'.repeat(40) }, null, 2)}\n`)
  commit(child, 'chore: bad state')
  const r = run(child)
  check('lost baseline exits 0', r.status === 0, r.detail)
  check('lost baseline explained', r.stdout.includes('not in its history'))
  check('lost baseline rewrites state', readState(child).commit === T3)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 6. Corrupt state file.
{
  write(child, STATE, '{not json\n')
  commit(child, 'chore: corrupt state')
  const r = run(child)
  check('corrupt state exits 0', r.status === 0, r.detail)
  check('corrupt state warned', r.stderr.includes('unreadable'))
  check('corrupt state rewritten', readState(child).commit === T3)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 7. Dirty synced path refused, before any remote or fetch happens.
{
  write(child, '.claude/skills/x/SKILL.md', '# x edited\n')
  const r = run(child)
  check('dirty path exits 1', r.status === 1, `status ${r.status}`)
  check('dirty path named', r.stderr.includes('Uncommitted changes') && r.stderr.includes('.claude/skills/x/SKILL.md'))
  check('failures carry the mark', r.stderr.startsWith('✖ '))
  gitSafe(child, 'checkout', '--', '.')
}

// 8. Bootstrap: a repo without the script runs an untracked copy of it; no baseline can be inferred.
{
  const fresh = join(tmp, 'fresh')
  mkdirSync(fresh)
  git(fresh, 'init', '-q', '-b', 'main')
  write(fresh, 'package.json', pkg({ build: 'tsc', lint: 'eslint .' }))
  commit(fresh, 'chore: init')
  write(fresh, 'scripts/sync-template.mts', REAL_SCRIPT)
  const r = run(fresh, URL)
  check('bootstrap exits 0', r.status === 0, r.detail)
  check('bootstrap has no baseline', r.stdout.includes('Baseline: none'))
  check('bootstrap stages the script itself', staged(fresh).includes('A scripts/sync-template.mts'), staged(fresh).join(', '))
  check('bootstrap lists sync:template as missing', r.stdout.includes('scripts.sync:template') && r.stdout.includes('missing here'))
  check('two-way mode says differs for lint', r.stdout.includes('scripts.lint  differs'))
  check('no settings file skips the settings block', r.stdout.includes('Settings: skipped — no .claude/settings.json here.'), r.stdout)
  // A repo with an older TRACKED copy bootstraps the same way: the fresh copy shows as
  // modified, and the script must exempt itself from its own dirty check.
  gitSafe(fresh, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(fresh, 'scripts/sync-template.mts', `${REAL_SCRIPT}// newer copy dropped in by hand\n`)
  const again = run(fresh, URL)
  check('modified self is exempt from the dirty check', again.status === 0, again.detail)
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
  check('no package.json exits 0', r.status === 0, r.detail)
  check('no package.json skips follow-ups', r.stdout.includes('no package.json here'))
  check('no package.json has no baseline', r.stdout.includes('Baseline: none'))
}

// 11. exclude / include from the state file; 12. URL taken from the state with no remote.
write(template, '.github/workflows/docs.yml', 'v3\n')
write(template, 'turbo.json', '{}\n')
const T4 = commit(template, 'chore: turbo', T4_AT)
{
  write(child, STATE, `${JSON.stringify({ url: URL, commit: T3, exclude: ['.github/workflows/docs.yml'], include: ['turbo.json'] }, null, 2)}\n`)
  commit(child, 'chore: exclude and include')
  gitSafe(child, 'remote', 'remove', 'template')
  const r = run(child)
  check('exclude/include exits 0', r.status === 0, r.detail)
  const s = staged(child)
  check('excluded path not staged', !s.includes('M .github/workflows/docs.yml'), s.join(', '))
  check('included path staged', s.includes('A turbo.json'), s.join(', '))
  check('url taken from state re-adds the remote', gitSafe(child, 'remote', 'get-url', 'template').trim() === URL)
  check('exclude survives the rewrite', readFileSync(join(child, STATE), 'utf8').includes('"exclude"'))
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
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

// 14. Pinning a template tag, syncing back to it, and unpinning again.
git(template, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', T2)
{
  const r = run(child, URL, '--ref', 'v1.0.0')
  check('tag pin exits 0', r.status === 0, r.detail)
  check('tag pin labels the ref', r.stdout.includes('template/v1.0.0 (tag)'))
  check('tag pin explains syncing back', r.stdout.includes('is ahead of it'))
  const s = staged(child)
  for (const want of ['D .github/labels.yml', 'M scripts/docs/check-docs.mts'])
    check(`tag pin stages ${want}`, s.includes(want), s.join(', '))
  const st = readState(child)
  check('tag pin records the tag commit', st.commit === T2)
  check('tag pin records the ref', st.ref === 'v1.0.0')
  check('tag pin creates no local tag', gitSafe(child, 'tag', '-l').trim() === '')
  check('tag lives in the private namespace', gitSafe(child, 'rev-parse', '--verify', 'refs/template-tags/v1.0.0^{commit}').trim() === T2)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  const again = run(child)
  check('pinned rerun stays on the tag', again.status === 0 && again.stdout.includes('unchanged since last sync') && again.stdout.includes('(tag)'), again.stdout)
  const unpin = run(child, '--ref', 'main')
  check('unpin exits 0', unpin.status === 0, unpin.detail)
  check('unpin lists the commits since the tag', unpin.stdout.includes('2 commits since last sync') && unpin.stdout.includes('feat(docs)!: strict docs:check') && unpin.stdout.includes('chore: turbo'))
  const after = readState(child)
  check('unpin records the branch head', after.commit === T4)
  check('unpin drops the ref key', after.ref === undefined)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 15. Refused input leaves the state alone.
{
  const before = readFileSync(join(child, STATE), 'utf8')
  const bad = run(child, '--ref', '-x')
  check('suspicious ref refused', bad.status === 1 && bad.stderr.includes('Refusing suspicious ref'), bad.stderr)
  const nope = run(child, '--ref', 'nope')
  check('unknown ref fails to fetch', nope.status === 1 && nope.stderr.includes('Could not fetch'), nope.stderr)
  const bogus = run(child, '--bogus')
  check('unknown option refused', bogus.status === 1 && bogus.stderr.includes('Unknown option'), bogus.stderr)
  check('refused input leaves state alone', readFileSync(join(child, STATE), 'utf8') === before)
}

// 16. The template itself refuses to sync from itself.
{
  gitSafe(template, 'remote', 'add', 'origin', URL)
  const r = run(template, URL)
  check('template self-guard exits 1', r.status === 1, `status ${r.status}`)
  check('template self-guard explained', r.stderr.includes('template itself'))
}

// 17 and 18. A checkout git aborts (behavior 23, the abort case). A required smudge filter
// that exits 1 makes git die on the first file it writes under the matching pattern. The
// smudge command carries a space so git runs it through `sh -c`, where `exit` is a builtin
// on every platform; the clean side is `cat` and required, so `git add`, `git rm`, and
// `git status` on the consumer's own files keep working. The consumer is case 8's bootstrap
// shape plus one committed file under scripts/docs, so a deletion gets staged.
function bootstrapWithFilter(name: string, pattern: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, 'package.json', pkg({ build: 'tsc', lint: 'eslint .' }))
  write(dir, 'scripts/docs/retired.mts', '// not on the template\n')
  commit(dir, 'chore: init')
  write(dir, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(dir, '.git/info/attributes', `${pattern} filter=boom\n`)
  git(dir, 'config', 'filter.boom.smudge', 'exit 1')
  git(dir, 'config', 'filter.boom.clean', 'cat')
  git(dir, 'config', 'filter.boom.required', 'true')
  return dir
}

// 17. One synced path fails: it is listed under Skipped, the rest is staged, exit 0.
{
  const dir = bootstrapWithFilter('boom-one', 'scripts/docs/**')
  const r = run(dir, URL)
  check('one failed checkout exits 0', r.status === 0, r.detail)
  check('one failed checkout prints the Skipped header', r.stdout.includes('Skipped (git checkout failed — fix and re-run):'), r.stdout)
  check('skipped line names the path and the git reason', r.stdout.includes('  scripts/docs  ') && r.stdout.includes('filter'), r.stdout)
  const s = staged(dir)
  for (const want of ['A .github/workflows/ci.yml', 'A .claude/skills/x/SKILL.md', 'A scripts/sync-template.mts', 'D scripts/docs/retired.mts', `A ${STATE}`])
    check(`one failed checkout still stages ${want}`, s.includes(want), s.join(', '))
  check('skipped path is neither staged nor written', !s.some(l => l.endsWith('scripts/docs/check-docs.mts')) && !existsSync(join(dir, 'scripts/docs/check-docs.mts')), s.join(', '))
  check('one failed checkout records the head', readState(dir).commit === T4)
}

// 18. Every synced path fails: exit 1 with the list, no state file, and the retired file
// already staged for deletion.
{
  const dir = bootstrapWithFilter('boom-all', '*')
  const r = run(dir, URL)
  check('every failed checkout exits 1', r.status === 1, r.detail)
  check('every failed checkout explained', r.stderr.includes('Could not check out any synced path') && r.stderr.includes('scripts/docs  '), r.stderr)
  const s = staged(dir)
  check('retired file staged for deletion', s.includes('D scripts/docs/retired.mts'), s.join(', '))
  check('nothing but deletions staged', s.every(l => l.startsWith('D ')), s.join(', '))
  check('every failed checkout writes no state', !existsSync(join(dir, STATE)))
}

if (fails.length > 0) {
  console.error(`\n✖ sync fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ sync fixtures — ${checks} checks pass`)
