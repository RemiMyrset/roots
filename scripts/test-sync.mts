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

/** `git diff --cached --name-status` as "X path" lines, renames split into a deletion and an addition as the report prints them. */
function staged(cwd: string): string[] {
  const parts = gitSafe(cwd, 'diff', '--cached', '--no-renames', '--name-status', '-z').split('\0').filter(Boolean)
  const lines: string[] = []
  for (let i = 0; i < parts.length; i += 2)
    lines.push(`${(parts[i] ?? '').slice(0, 1)} ${parts[i + 1] ?? ''}`)
  return lines
}

interface State { url?: string, ref?: string, commit?: string, repo?: string, exclude?: unknown, include?: unknown }
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
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const pkg = (scripts: Record<string, string>): string => json({ name: 'fixture', scripts })
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
const settings = (deny: string[], hook: string, matcher = 'Bash'): string => `${JSON.stringify({ permissions: { allow: ['Bash(git status:*)'], deny }, hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: hook }] }] } }, null, 2)}\n`
write(template, '.claude/settings.json', settings(['Read(**/.env)'], 'node hooks.mts'))
write(template, '.github/workflows/ci.yml', 'ci v1\n')
write(template, '.github/workflows/docs.yml', 'v1\n')
write(template, '.codex/hooks.json', '{}\n')
write(template, '.gemini/settings.json', '{}\n')
write(template, '.claude/output-styles/writing.md', '---\nname: writing\n---\nrules v1\n')
write(template, 'docs/template/x.md', '# x v1\n')
write(template, 'docs/template/x[1].md', '# retired at T2; as a glob it also matches x1.md\n')
write(template, 'src/index.ts', 'export const v = 1\n')
// Once a synced path; the template stopped shipping it and dropped it from MECHANICS.
write(template, 'renovate.json', '{}\n')
const T1 = commit(template, 'chore: t1', T1_AT)
git(template, 'tag', 'v9.9.9')

// Consumers made from T1 with no git history in common, dated after T1 and before T2:
// `child` customizes package.json (so only the root-time inference can place it), two of its
// scripts naming a file T2 retires, and adds files of its own: a skill under a synced
// directory, a page the glob `x[1].md` matches, a directory an `include` names, and configs
// the glob `*.config.ts` matches. `copy` is pristine (its root tree equals T1's tree exactly).
const child = join(tmp, 'child')
copyTree(template, child)
git(child, 'init', '-q', '-b', 'main')
const CHECK_LLMS = 'node scripts/docs/check-docs.mts && node scripts/docs/gen-llms.mts --check'
write(child, 'package.json', pkg({ ...T1_SCRIPTS, 'docs:check': CHECK_LLMS, 'lint': 'eslint .', 'dev': 'vite', 'llms': 'node scripts/docs/gen-llms.mts' }))
write(child, '.claude/skills/own/SKILL.md', '# own\n')
write(child, 'docs/template/x1.md', '# own page\n')
write(child, 'config/lint.json', '{}\n')
write(child, 'eslint.config.ts', 'export default []\n')
write(child, 'packages/a/vitest.config.ts', 'export default {}\n')
commit(child, 'chore: init', COPY_AT)
const copy = join(tmp, 'copy')
copyTree(template, copy)
git(copy, 'init', '-q', '-b', 'main')
commit(copy, 'Initial commit', COPY_AT)

// T2: the motivating case — a mechanic is deleted and the script that called it changes;
// the agent-skills copy and the CI workflow change too.
rmSync(join(template, 'scripts/docs/gen-llms.mts'))
rmSync(join(template, 'docs/template/x[1].md'))
rmSync(join(template, 'renovate.json'))
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
write(fork, '.claude/skills/fork-own/SKILL.md', '# fork own\n')
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
  for (const want of ['M .github/workflows/ci.yml', 'M .github/workflows/docs.yml', 'D scripts/docs/gen-llms.mts', 'D docs/template/x[1].md', 'A scripts/test-sync.mts', 'M scripts/sync-template.mts', 'M docs/template/x.md', 'A .agents/skills/x/SKILL.md', `A ${STATE}`])
    check(`first sync stages ${want}`, s.includes(want), s.join(', '))
  for (const never of ['src/index.ts', 'package.json', '.claude/skills/own/SKILL.md', 'docs/template/x1.md'])
    check(`first sync leaves ${never} alone`, !s.some(l => l.endsWith(never)) && existsSync(join(child, never)), s.join(', '))
  // A copy byte-identical to the one the template shipped would be retired if the path were
  // still synced; out of MECHANICS it is the child's own, never staged and never mentioned.
  check('a path dropped from MECHANICS stays', !s.some(l => l.endsWith('renovate.json')) && existsSync(join(child, 'renovate.json')) && !r.stdout.includes('renovate.json'), r.stdout)
  check('agent skills copy is a plain file', existsSync(join(child, '.agents/skills/x/SKILL.md')) && gitSafe(child, 'ls-files', '-s', '--', '.agents/skills/x/SKILL.md').startsWith('100644'))
  check('self-update is annotated', r.stdout.includes('new version runs next time'))
  const st = readState(child)
  check('state records the URL', st.url === URL, st.url ?? 'none')
  check('state records the template head', st.commit === T2, st.commit ?? 'none')
  check('state has no ref when tracking main', st.ref === undefined)
  check('docs:gen follow-up listed', r.stdout.includes('scripts.docs:gen  changed on the template since the baseline'))
  check('docs:gen shows both values', r.stdout.includes('template: automd') && r.stdout.includes('yours:    automd && node scripts/docs/gen-llms.mts'))
  check('docs:gen notes the deleted file', r.stdout.includes('references scripts/docs/gen-llms.mts, which this sync deletes'))
  // A customized value, and an entry the template never had, still get the note: the file
  // they name is gone after this sync whoever owns the value.
  check('customized value naming a deleted file is listed with the note', r.stdout.includes(`  scripts.docs:check  customized locally\n    template: node scripts/docs/check-docs.mts\n    yours:    ${CHECK_LLMS}\n    note: yours references scripts/docs/gen-llms.mts, which this sync deletes\n`), r.stdout)
  check('own entry naming a deleted file is listed with the note', r.stdout.includes('  scripts.llms  customized locally\n    template: (not on the template)\n    yours:    node scripts/docs/gen-llms.mts\n    note: yours references scripts/docs/gen-llms.mts, which this sync deletes\n'), r.stdout)
  check('customized value with the note is not listed twice', !/Customized locally[^\n]*docs:check/.test(r.stdout), r.stdout)
  check('test:sync reported missing', r.stdout.includes('scripts.test:sync') && r.stdout.includes('missing here'))
  check('customized lint listed compactly on first sync', r.stdout.includes('Customized locally') && r.stdout.includes('scripts.lint') && !r.stdout.includes('scripts.lint  '))
  check('child-only script never mentioned', !r.stdout.includes('scripts.dev'))
  check('settings equal on first sync', r.stdout.includes('Settings: none new.'), r.stdout)
  check('no template tags imported', gitSafe(child, 'tag', '-l').trim() === '', gitSafe(child, 'tag', '-l'))
  check('remote has no-tags set', gitSafe(child, 'config', 'remote.template.tagOpt').trim() === '--no-tags')
  // A skill is two synced paths; discarding one leaves the other staged and the drift gate red.
  check('a staged skill path adds the mirror line to Next', r.stdout.includes('\n  pnpm docs:gen && git add .agents/skills '), r.stdout)
}

// 2b. First sync of a pristine copy: the root commit's tree is a template tree.
{
  const r = run(copy, URL)
  check('pristine copy exits 0', r.status === 0, r.detail)
  check('root-tree baseline inferred', r.stdout.includes(`Baseline: ${T1.slice(0, 7)} (root tree)`), r.stdout)
  check('pristine copy lists the commit since', r.stdout.includes('1 commit since the baseline'))
  check('pristine copy records the head', readState(copy).commit === T2)
}

// 2c. A copy of the template head: the first sync stages only the state file, and a second
// run before the commit meets that staged file and must not refuse its own work.
{
  const current = join(tmp, 'copy-head')
  copyTree(template, current)
  git(current, 'init', '-q', '-b', 'main')
  commit(current, 'Initial commit')
  const first = run(current, URL)
  check('head copy exits 0', first.status === 0, first.detail)
  check('head copy stages only the state file', staged(current).join(',') === `A ${STATE}`, staged(current).join(', '))
  check('head copy prints a Next block', first.stdout.includes('Next:'), first.stdout)
  // The sync stages only its own paths; the commit also needs every file a follow-up edited.
  check('Next says to stage the hand edits before the commit', /\n {2}git add <path> +# [^\n]+\n {2}git commit /.test(first.stdout), first.stdout)
  check('no staged skill path, no mirror line', !first.stdout.includes('pnpm docs:gen'), first.stdout)
  const again = run(current, URL)
  check('rerun before commit exits 0', again.status === 0, again.detail)
  check('rerun before commit reports unchanged', again.stdout.includes('unchanged since last sync'), again.stdout)
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
  check('up-to-date prints no Next block', !r.stdout.includes('Next:'), r.stdout)
  check('applied follow-up gone', !r.stdout.includes('scripts.docs:gen'))
  check('customized lint listed compactly', r.stdout.includes('Customized locally') && r.stdout.includes('scripts.lint') && !r.stdout.includes('scripts.lint  '))
}

// 4. A breaking template commit since the last sync; a template page is renamed, so the
// old page is retired and reported as a deletion beside the addition. The child's own
// agent files under synced directories, added after the last sync, stay.
git(template, 'mv', 'docs/template/x.md', 'docs/template/y.md')
write(template, 'scripts/docs/check-docs.mts', '// check v2\n')
write(template, 'package.json', pkg({ ...T2_SCRIPTS, 'docs:check': 'node scripts/docs/check-docs.mts --strict' }))
write(template, '.github/labels.yml', 'labels\n')
write(template, '.claude/settings.json', settings(['Read(**/.env)', 'Read(**/.pgpass)'], 'node hooks.mts --strict', 'Bash|Monitor'))
const T3 = commit(template, 'feat(docs)!: strict docs:check\n\nBREAKING CHANGE: docs:check now fails on stale review dates.\n', T3_AT)
const OWN = ['.claude/skills/own/SKILL.md', '.agents/skills/own/SKILL.md', '.claude/rules/api.md', '.claude/hooks/deny-prod-db.mts', 'docs/template/x1.md']
{
  write(child, '.agents/skills/own/SKILL.md', '# own\n')
  write(child, '.claude/rules/api.md', '# api rule\n')
  write(child, '.claude/hooks/deny-prod-db.mts', '// own guard\n')
  commit(child, 'feat: own agent files')
  const r = run(child)
  check('commits-since exits 0', r.status === 0, r.detail)
  check('commits-since counts one', r.stdout.includes('1 commit since last sync'))
  check('breaking commit marked', r.stdout.includes('! ') && r.stdout.includes('feat(docs)!: strict docs:check'))
  check('breaking paragraph printed', r.stdout.includes('BREAKING CHANGE: docs:check now fails on stale review dates.'))
  const s = staged(child)
  for (const want of ['A .github/labels.yml', 'M scripts/docs/check-docs.mts', 'D docs/template/x.md', 'A docs/template/y.md', `M ${STATE}`])
    check(`commits-since stages ${want}`, s.includes(want), s.join(', '))
  check('rename reported as a deletion and an addition', r.stdout.includes('  D  docs/template/x.md') && r.stdout.includes('  A  docs/template/y.md'), r.stdout)
  for (const own of OWN)
    check(`own file kept: ${own}`, !s.some(l => l.endsWith(own)) && existsSync(join(child, own)), s.join(', '))
  check('own files at paths the template never shipped are not listed as kept', !r.stdout.includes('Kept ('), r.stdout)
  check('state advances to T3', readState(child).commit === T3)
  check('three-way mode names the upstream change', r.stdout.includes('scripts.docs:check  changed on the template since last sync'))
  check('missing deny rule listed', r.stdout.includes('permissions.deny Read(**/.pgpass)  missing here'), r.stdout)
  check('present rules not listed', !r.stdout.includes('Read(**/.env)') && !r.stdout.includes('Bash(git status:*)'), r.stdout)
  check('hook the template replaced listed', r.stdout.includes('  hooks.PreToolUse  differs\n    template: matcher Bash|Monitor, command node hooks.mts --strict\n    yours:    matcher Bash, command node hooks.mts\n'), r.stdout)
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
  check('fork keeps its own skill', !s.some(l => l.endsWith('.claude/skills/fork-own/SKILL.md')) && existsSync(join(fork, '.claude/skills/fork-own/SKILL.md')), s.join(', '))
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

// 6. An invalid state file fails before anything is fetched or staged, so a hand-edit
// typo cannot silently drop the url or the lists; only an invalid commit is a first sync.
const VALID = { url: URL, commit: T3 }
function refused(name: string, body: string, why: string): void {
  write(child, STATE, body)
  commit(child, `chore: ${name}`)
  const r = run(child)
  check(`${name} exits 1`, r.status === 1, r.detail)
  check(`${name} names the problem`, r.stderr.startsWith(`✖ ${STATE} is invalid`) && r.stderr.includes(why), r.stderr)
  check(`${name} stages nothing`, staged(child).length === 0, staged(child).join(', '))
  check(`${name} leaves the state alone`, existsSync(join(child, STATE)) && readFileSync(join(child, STATE), 'utf8') === body)
  gitSafe(child, 'reset', '-q', '--hard')
}
refused('corrupt state', '{not json\n', 'not valid JSON')
refused('string exclude', json({ ...VALID, exclude: '.github/workflows/docs.yml' }), '"exclude"')
refused('glob include', json({ ...VALID, include: ['*.config.ts'] }), '*.config.ts')
check('glob include deletes nothing', existsSync(join(child, 'eslint.config.ts')) && existsSync(join(child, 'packages/a/vitest.config.ts')))
refused('dot include', json({ ...VALID, include: ['.'] }), '"."')
refused('parent include', json({ ...VALID, include: ['../x'] }), '"../x"')
refused('magic exclude', json({ ...VALID, exclude: [':(glob)**'] }), ':(glob)**')
refused('invalid url', json({ ...VALID, url: 'not a url' }), '"url"')
refused('invalid ref', json({ ...VALID, ref: '-x' }), '"ref"')

// 6b. A byte-order mark (Windows editors write one) is not an error in the state file,
// package.json, or .claude/settings.json.
{
  const BOM = '\uFEFF'
  const pkgText = readFileSync(join(child, 'package.json'), 'utf8')
  const settingsText = readFileSync(join(child, '.claude/settings.json'), 'utf8')
  write(child, STATE, `${BOM}${json(VALID)}`)
  write(child, 'package.json', `${BOM}${pkgText}`)
  write(child, '.claude/settings.json', `${BOM}${settingsText}`)
  commit(child, 'chore: byte-order marks')
  const r = run(child)
  check('byte-order mark exits 0 without a warning', r.status === 0 && r.stderr === '', r.detail)
  check('byte-order mark state is read', r.stdout.includes('unchanged since last sync') && staged(child).length === 0, r.stdout)
  check('byte-order mark package.json and settings are read', !r.stdout.includes('not valid JSON'), r.stdout)
  write(child, STATE, json(VALID))
  write(child, 'package.json', pkgText)
  write(child, '.claude/settings.json', settingsText)
  commit(child, 'chore: drop byte-order marks')
}

// 6c. An invalid commit alone is a first sync that keeps the url and both lists; an
// exclude entry that names no synced path is warned about.
{
  write(child, '.gemini/settings.json', '{ "own": true }\n')
  write(child, STATE, json({ url: URL, commit: 'nope', exclude: ['.gemini/settings.json', '.claude/skills/x'], include: ['config'] }))
  commit(child, 'chore: invalid commit')
  const r = run(child)
  check('invalid commit exits 0', r.status === 0, r.detail)
  check('invalid commit warned', r.stderr.includes('"commit"') && r.stderr.includes('first sync'), r.stderr)
  check('invalid commit is a first sync', r.stdout.includes('first sync'), r.stdout)
  check('invalid commit keeps the exclusion', !staged(child).some(l => l.endsWith('.gemini/settings.json')) && readFileSync(join(child, '.gemini/settings.json'), 'utf8').includes('own'), staged(child).join(', '))
  check('included path the template never shipped is kept', existsSync(join(child, 'config/lint.json')) && !staged(child).some(l => l.endsWith('config/lint.json')), staged(child).join(', '))
  check('unmatched exclude warned', r.stderr.includes('".claude/skills/x"') && r.stderr.includes('matches no synced path'), r.stderr)
  const st = readState(child)
  check('invalid commit keeps the lists', JSON.stringify(st.exclude) === '[".gemini/settings.json",".claude/skills/x"]' && JSON.stringify(st.include) === '["config"]', JSON.stringify(st))
  check('invalid commit records the head', st.commit === T3, st.commit ?? 'none')
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(child, '.gemini/settings.json', '{}\n')
  write(child, STATE, json(VALID))
  commit(child, 'chore: back to the plain state')
}

// 7. Dirty synced path refused, before any remote or fetch happens.
{
  write(child, '.claude/skills/x/SKILL.md', '# x edited\n')
  const r = run(child)
  check('dirty path exits 1', r.status === 1, `status ${r.status}`)
  check('dirty path named', r.stderr.includes('Uncommitted changes') && r.stderr.includes('.claude/skills/x/SKILL.md'))
  // Linked worktrees share one stash list, so the refusal must never send anyone to stash.
  check('dirty path says commit, never stash', r.stderr.includes('commit first') && !/stash/i.test(r.stderr), r.stderr)
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
  check('bad url carries git\'s reason', r.stderr.includes('git: fatal:'), r.stderr)
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
  write(child, STATE, json({ url: URL, commit: T3, exclude: ['.github/workflows/docs.yml'], include: ['turbo.json', 'config'] }))
  commit(child, 'chore: exclude and include')
  gitSafe(child, 'remote', 'remove', 'template')
  const r = run(child)
  check('exclude/include exits 0', r.status === 0, r.detail)
  const s = staged(child)
  check('excluded path not staged', !s.includes('M .github/workflows/docs.yml'), s.join(', '))
  check('included path staged', s.includes('A turbo.json'), s.join(', '))
  check('included path the template never shipped is kept', !s.some(l => l.endsWith('config/lint.json')) && existsSync(join(child, 'config/lint.json')), s.join(', '))
  check('url taken from state re-adds the remote', gitSafe(child, 'remote', 'get-url', 'template').trim() === URL)
  check('exclude survives the rewrite', readFileSync(join(child, STATE), 'utf8').includes('"exclude"'))
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 12b. A state written by hand before the first sync (url and exclude, no commit) is a
// configuration, not an error: its url beats a stale remote and the exclusion holds.
{
  const pre = join(tmp, 'preconfig')
  copyTree(template, pre)
  git(pre, 'init', '-q', '-b', 'main')
  write(pre, '.gemini/settings.json', '{ "own": true }\n')
  write(pre, STATE, json({ url: URL, exclude: ['.gemini/settings.json'] }))
  commit(pre, 'chore: init')
  git(pre, 'remote', 'add', 'template', 'file:///nonexistent/stale')
  const r = run(pre)
  check('pre-sync config exits 0', r.status === 0, r.detail)
  check('pre-sync config warns nothing', r.stderr === '', r.stderr)
  check('pre-sync config url beats a stale remote', r.stdout.startsWith(`Template: ${URL}\n`), r.stdout)
  check('pre-sync config exclusion holds', !staged(pre).some(l => l.endsWith('.gemini/settings.json')) && readFileSync(join(pre, '.gemini/settings.json'), 'utf8').includes('own'), staged(pre).join(', '))
  const st = readState(pre)
  check('pre-sync config keeps the exclusion and records the head', JSON.stringify(st.exclude) === '[".gemini/settings.json"]' && st.commit === T4, JSON.stringify(st))
}

// 12c. `.agents` is the generated mirror of `.claude/skills`: excluding one of the two alone
// stages a mirror that disagrees with its source on every sync, so it draws a warning.
{
  const half = join(tmp, 'half-excluded')
  copyTree(template, half)
  git(half, 'init', '-q', '-b', 'main')
  write(half, STATE, json({ url: URL, exclude: ['.claude/skills'] }))
  commit(half, 'chore: init')
  const r = run(half)
  check('one-sided skill exclude exits 0', r.status === 0, r.detail)
  check('one-sided skill exclude warned', r.stderr.includes('".claude/skills" without ".agents"') && r.stderr.includes('exclude both or neither'), r.stderr)
  gitSafe(half, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(half, STATE, json({ ...readState(half), exclude: ['.agents', '.claude/skills'] }))
  commit(half, 'chore: exclude the mirror too')
  const both = run(half)
  check('skill exclude of both sides warns nothing', both.status === 0 && both.stderr === '', both.detail)
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
  check('index untouched by a failed run', staged(child).length === 0, staged(child).join(', '))
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

// 14b. A fresh clone over file:// holds none of the template's commits, so syncing back to
// the tag must fetch the recorded commit by its hash to retire what the template added since.
{
  const clone = join(tmp, 'clone-fresh')
  git(tmp, 'clone', '-q', pathToFileURL(child).href, clone)
  check('fresh clone lacks the recorded commit', gitSafe(clone, 'cat-file', '-t', T4) === '')
  const r = run(clone, '--ref', 'v1.0.0')
  check('fresh clone pin exits 0', r.status === 0, r.detail)
  check('fresh clone pin explains syncing back', r.stdout.includes('is ahead of it'), r.stdout)
  const s = staged(clone)
  for (const want of ['D .github/labels.yml', 'D turbo.json'])
    check(`fresh clone pin stages ${want}`, s.includes(want), s.join(', '))
  for (const own of OWN)
    check(`fresh clone pin keeps own file: ${own}`, !s.some(l => l.endsWith(own)) && existsSync(join(clone, own)), s.join(', '))
  check('fresh clone pin lists nothing as kept', !r.stdout.includes('Kept'), r.stdout)
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
// shape plus three committed files: a byte-identical copy of one the template retired, so a
// deletion gets staged even with no baseline; one of its own at a path the template retired,
// which stays and is listed as kept; and one at a path the template never shipped, which
// stays unmentioned.
function bootstrapWithFilter(name: string, pattern: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, 'package.json', pkg({ build: 'tsc', lint: 'eslint .' }))
  write(dir, 'scripts/docs/gen-llms.mts', '// gen\n') // the template's copy, retired at T2
  write(dir, 'scripts/docs/own.mts', '// never on the template\n')
  write(dir, 'docs/template/x.md', '# own page at a path the template retired at T3\n')
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
  for (const want of ['A .github/workflows/ci.yml', 'A .claude/skills/x/SKILL.md', 'A scripts/sync-template.mts', 'D scripts/docs/gen-llms.mts', `A ${STATE}`])
    check(`one failed checkout still stages ${want}`, s.includes(want), s.join(', '))
  check('file the template never shipped is kept without a baseline', !s.some(l => l.endsWith('scripts/docs/own.mts')) && existsSync(join(dir, 'scripts/docs/own.mts')), s.join(', '))
  check('file the template never shipped is not listed as kept', !r.stdout.includes('scripts/docs/own.mts'), r.stdout)
  check('own file at a retired template path is kept without a baseline', !s.some(l => l.endsWith('docs/template/x.md')) && existsSync(join(dir, 'docs/template/x.md')), s.join(', '))
  check('own file at a retired template path is listed as kept', r.stdout.includes('\nKept (') && r.stdout.includes('\n  docs/template/x.md\n'), r.stdout)
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
  check('retired file staged for deletion', s.includes('D scripts/docs/gen-llms.mts'), s.join(', '))
  check('nothing but deletions staged', s.every(l => l.startsWith('D ')), s.join(', '))
  check('every failed checkout writes no state', !existsSync(join(dir, STATE)))
}

// 19. Settings follow-ups compare every hook registration, matcher included, and the
// output style: a child hook registered ahead of the template's is no difference, and a
// matcher-only change is one.
{
  const hook = (matcher: string, command: string): unknown => ({ matcher, hooks: [{ type: 'command', command }] })
  const permissions = { allow: ['Bash(git status:*)'], deny: ['Read(**/.env)', 'Read(**/.pgpass)'] }
  write(child, '.claude/settings.json', json({ permissions, hooks: { PreToolUse: [hook('Bash', 'node tools/fmt-hook.mts'), hook('Bash|Monitor', 'node hooks.mts --strict')] } }))
  commit(child, 'chore: own hook first')
  const same = run(child)
  check('own hook ahead of the template\'s is no difference', same.status === 0 && same.stdout.includes('Settings: none new.'), same.stdout)
  write(template, '.claude/settings.json', json({ outputStyle: 'writing', permissions, hooks: { PreToolUse: [hook('Bash|PowerShell', 'node hooks.mts --strict'), hook('Write', 'node write-guard.mts')] } }))
  commit(template, 'fix(hooks): guard powershell and writes')
  const r = run(child)
  check('settings change exits 0', r.status === 0, r.detail)
  check('output style missing here', r.stdout.includes('  outputStyle writing  missing here'), r.stdout)
  check('matcher-only change differs', r.stdout.includes('  hooks.PreToolUse  differs\n    template: matcher Bash|PowerShell, command node hooks.mts --strict\n    yours:    matcher Bash|Monitor, command node hooks.mts --strict\n'), r.stdout)
  check('second template hook missing here', r.stdout.includes('  hooks.PreToolUse  missing here\n    template: matcher Write, command node write-guard.mts\n'), r.stdout)
  check('own hook never mentioned', !r.stdout.includes('fmt-hook'), r.stdout)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 19b. A hook of the repository's own that shares a matcher with the template's is never
// paired with it: a hook the template adds beside it is "missing here", and a command the
// template changed pairs only with the registration the template shipped.
{
  const entry = (matcher: string, ...commands: string[]): unknown => ({ matcher, hooks: commands.map(command => ({ type: 'command', command })) })
  const permissions = { allow: ['Bash(git status:*)'], deny: ['Read(**/.env)', 'Read(**/.pgpass)'] }
  write(child, '.claude/settings.json', json({ outputStyle: 'writing', permissions, hooks: { PreToolUse: [entry('Bash|PowerShell', 'node hooks.mts --strict', 'node tools/fmt-hook.mts'), entry('Write', 'node write-guard.mts', 'node tools/own-write.mts')] } }))
  commit(child, 'chore: apply settings follow-ups')
  write(template, '.claude/settings.json', json({ outputStyle: 'writing', permissions, hooks: { PreToolUse: [entry('Bash|PowerShell', 'node hooks.mts --strict', 'node audit.mts'), entry('Write', 'node write-guard.mts --strict')] } }))
  commit(template, 'fix(hooks): audit, stricter writes')
  const r = run(child)
  check('own hooks sharing a matcher exit 0', r.status === 0, r.detail)
  check('added hook beside an own one is missing here, and the changed one pairs with the template\'s', r.stdout.includes('  hooks.PreToolUse  missing here\n    template: matcher Bash|PowerShell, command node audit.mts\n  hooks.PreToolUse  differs\n    template: matcher Write, command node write-guard.mts --strict\n    yours:    matcher Write, command node write-guard.mts\n\n'), r.stdout)
  check('own hooks sharing a matcher never mentioned', !r.stdout.includes('fmt-hook') && !r.stdout.includes('own-write'), r.stdout)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 20. The 40-commit cap hides only non-breaking commits: a breaking one past it is listed
// with its footer.
{
  write(template, 'docs/template/log.md', 'breaking\n')
  const breaking = commit(template, 'feat(agents)!: session-wide writing rules\n\nBREAKING CHANGE: add "outputStyle": "writing" to .claude/settings.json.\n')
  for (let i = 1; i <= 44; i++) {
    write(template, 'docs/template/log.md', `${i}\n`)
    commit(template, `docs: note ${i}`)
  }
  const r = run(child)
  check('long log exits 0', r.status === 0, r.detail)
  check('long log counts every commit', r.stdout.includes('45 commits since last sync'), r.stdout)
  check('breaking commit past the cap listed', r.stdout.includes(`  ! ${breaking.slice(0, 7)} feat(agents)!: session-wide writing rules\n`), r.stdout)
  check('its footer printed', r.stdout.includes('      BREAKING CHANGE: add "outputStyle": "writing" to .claude/settings.json.'), r.stdout)
  check('cap names what it hides', r.stdout.includes('  … and 4 more, none breaking\n'), r.stdout)
  check('cap still lists 40 others', r.stdout.includes('docs: note 5\n') && !r.stdout.includes('docs: note 4\n'), r.stdout)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 21. A merge commit is listed only when it is breaking: a PR-title merge carries the `!` and
// the footer while the commit it merges carries neither. A plain merge is left out.
{
  git(template, 'checkout', '-q', '-b', 'pr')
  write(template, 'docs/template/pr.md', 'pr\n')
  const side = commit(template, 'docs: rework a page')
  git(template, 'checkout', '-q', 'main')
  git(template, 'merge', '-q', '--no-ff', 'pr', '-m', 'feat(docs)!: strict docs check (#12)', '-m', 'BREAKING CHANGE: add "docs:check": "node scripts/docs/check-docs.mts --strict" to package.json.')
  const merge = git(template, 'rev-parse', 'HEAD').trim()
  git(template, 'checkout', '-q', '-b', 'plain')
  write(template, 'docs/template/plain.md', 'plain\n')
  commit(template, 'docs: plain page')
  git(template, 'checkout', '-q', 'main')
  git(template, 'merge', '-q', '--no-ff', 'plain', '-m', 'Merge branch \'plain\'')
  const r = run(child)
  check('merges exit 0', r.status === 0, r.detail)
  check('breaking merge listed with its footer', r.stdout.includes(`  ! ${merge.slice(0, 7)} feat(docs)!: strict docs check (#12)\n      BREAKING CHANGE: add "docs:check": "node scripts/docs/check-docs.mts --strict" to package.json.\n`), r.stdout)
  check('merged commit listed', r.stdout.includes(`    ${side.slice(0, 7)} docs: rework a page\n`), r.stdout)
  check('plain merge left out and not counted', !r.stdout.includes('Merge branch') && r.stdout.includes('3 commits since last sync'), r.stdout)
  check('count says how many merges it leaves out', r.stdout.includes('; 1 merge left out):\n'), r.stdout)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
}

// 22. The recorded commit is gone from the template (a force-push; here a URL for a copy that
// never had it): nothing the template may have shipped is deleted, not even a file of the
// repository's own at a path the template retired long before, and every file under a synced
// path that the template does not ship is listed as kept.
{
  git(template, 'branch', 'before')
  write(template, 'docs/template/experimental.md', '# experimental\n')
  commit(template, 'feat(docs): experimental page')
  run(child)
  gitSafe(child, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(child, 'docs/template/x.md', '# own page at a path the template retired at T3\n')
  commit(child, 'docs: own page')
  const rewritten = join(tmp, 'rewritten')
  git(tmp, 'clone', '-q', '--single-branch', '--branch', 'before', URL, rewritten)
  git(rewritten, 'branch', '-q', '-m', 'before', 'main')
  write(rewritten, 'docs/template/rewritten.md', '# rewritten\n')
  commit(rewritten, 'docs: rewritten history')
  const clone = join(tmp, 'clone-lost')
  git(tmp, 'clone', '-q', pathToFileURL(child).href, clone)
  const r = run(clone, pathToFileURL(rewritten).href)
  check('lost sync point exits 0', r.status === 0, r.detail)
  check('lost sync point says the diff is not complete', r.stdout.includes('not in its history') && r.stdout.includes('git cannot fetch it either') && !r.stdout.includes('complete regardless'), r.stdout)
  const s = staged(clone)
  check('lost sync point still stages the template head', s.includes('A docs/template/rewritten.md'), s.join(', '))
  check('lost sync point deletes nothing it cannot place', !s.some(l => l.endsWith('docs/template/experimental.md')) && existsSync(join(clone, 'docs/template/experimental.md')), s.join(', '))
  check('lost sync point keeps an own file at a path the template retired', !s.some(l => l.endsWith('docs/template/x.md')) && existsSync(join(clone, 'docs/template/x.md')), s.join(', '))
  const out = r.stdout.split('\n')
  const at = out.findIndex(l => l.startsWith('Kept ('))
  const kept = at < 0 ? [] : out.slice(at + 1)
  for (const file of ['docs/template/experimental.md', 'docs/template/x.md', ...OWN])
    check(`lost sync point lists ${file} as kept`, kept.includes(`  ${file}`), r.stdout)
}

// 23. A hook registration is the template's when any version of its settings held it, so one
// here that lags the sync point (a follow-up never applied) still pairs with its replacement,
// here after the template renames the hook file. The repository's own registration of the
// template's command, beside the template's, is never paired.
{
  const hooksTemplate = join(tmp, 'hooks-template')
  mkdirSync(hooksTemplate)
  git(hooksTemplate, 'init', '-q', '-b', 'main')
  const DISPATCH = 'node .claude/hooks/dispatch.mts'
  const hookSettings = (...entries: [string, string][]): string => json({ hooks: { PreToolUse: entries.map(([matcher, command]) => ({ matcher, hooks: [{ type: 'command', command }] })) } })
  write(hooksTemplate, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(hooksTemplate, '.claude/hooks/dispatch.mts', '// dispatch\n')
  write(hooksTemplate, '.claude/settings.json', hookSettings(['Bash', DISPATCH]))
  commit(hooksTemplate, 'chore: t1', T1_AT)
  const kid = join(tmp, 'hooks-child')
  copyTree(hooksTemplate, kid)
  git(kid, 'init', '-q', '-b', 'main')
  commit(kid, 'Initial commit', COPY_AT)
  write(kid, '.claude/settings.json', hookSettings(['Bash', DISPATCH], ['mcp__devbox__exec', DISPATCH]))
  commit(kid, 'feat: guard the devbox tool too')
  write(hooksTemplate, '.claude/settings.json', hookSettings(['Bash|PowerShell', DISPATCH]))
  commit(hooksTemplate, 'fix(hooks): guard powershell', T2_AT)
  const widened = run(kid, pathToFileURL(hooksTemplate).href)
  check('widened matcher exits 0', widened.status === 0, widened.detail)
  check('widened matcher pairs only the template\'s registration', widened.stdout.includes(`  hooks.PreToolUse  differs\n    template: matcher Bash|PowerShell, command ${DISPATCH}\n    yours:    matcher Bash, command ${DISPATCH}\n\n`), widened.stdout)
  check('own registration of the template\'s command never listed', !widened.stdout.includes('mcp__devbox__exec'), widened.stdout)
  gitSafe(kid, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  git(hooksTemplate, 'mv', '.claude/hooks/dispatch.mts', '.claude/hooks/guard.mts')
  write(hooksTemplate, '.claude/settings.json', hookSettings(['Bash|PowerShell', 'node .claude/hooks/guard.mts']))
  commit(hooksTemplate, 'refactor(hooks): rename dispatch to guard', T3_AT)
  const renamed = run(kid)
  check('renamed hook exits 0', renamed.status === 0, renamed.detail)
  const s = staged(kid)
  check('renamed hook file staged as a deletion and an addition', s.includes('D .claude/hooks/dispatch.mts') && s.includes('A .claude/hooks/guard.mts'), s.join(', '))
  check('registration older than the sync point pairs with its replacement', renamed.stdout.includes(`  hooks.PreToolUse  differs\n    template: matcher Bash|PowerShell, command node .claude/hooks/guard.mts\n    yours:    matcher Bash, command ${DISPATCH}\n\n`), renamed.stdout)
  check('own registration still never listed', !renamed.stdout.includes('mcp__devbox__exec'), renamed.stdout)
}

// 24. A template file that got here by another route than the sync point (an older copy of
// the script that recorded none, a sync while its path was excluded) is still the template's:
// a byte-identical copy is retired once the template retires it, an edited copy stays and is
// listed as kept, and the repository's own skill stays unmentioned.
{
  const routeTemplate = join(tmp, 'route-template')
  mkdirSync(routeTemplate)
  git(routeTemplate, 'init', '-q', '-b', 'main')
  write(routeTemplate, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(routeTemplate, 'docs/template/a.md', '# a v1\n')
  write(routeTemplate, '.claude/rules/tpl.md', '# tpl rule\n')
  commit(routeTemplate, 'chore: t1', T1_AT)
  const routeUrl = pathToFileURL(routeTemplate).href
  const kid = join(tmp, 'route-child')
  copyTree(routeTemplate, kid)
  git(kid, 'init', '-q', '-b', 'main')
  commit(kid, 'Initial commit', COPY_AT)
  write(kid, '.claude/skills/own/SKILL.md', '# own\n')
  commit(kid, 'feat: own skill')
  write(routeTemplate, '.claude/rules/legacy.md', '# legacy rule\n')
  write(routeTemplate, '.claude/hooks/deny-old.mts', '// a guard the template later retires\n')
  write(routeTemplate, 'docs/template/new.md', '# new page\n')
  commit(routeTemplate, 'feat: a rule, a guard, a page', T2_AT)
  git(kid, 'fetch', '-q', routeUrl, 'main')
  git(kid, 'checkout', 'FETCH_HEAD', '--', '.claude/rules', '.claude/hooks', 'docs/template')
  write(kid, 'docs/template/new.md', '# new page, edited here\n')
  commit(kid, 'chore: sync mechanics from template (older script)')
  git(routeTemplate, 'rm', '-q', '.claude/rules/legacy.md', '.claude/hooks/deny-old.mts', 'docs/template/new.md')
  commit(routeTemplate, 'refactor!: retire the rule, the guard, and the page', T3_AT)
  const r = run(kid, routeUrl)
  check('older-script copy exits 0', r.status === 0, r.detail)
  check('older-script copy has a root-tree baseline', r.stdout.includes('(root tree)'), r.stdout)
  const s = staged(kid)
  for (const want of ['D .claude/rules/legacy.md', 'D .claude/hooks/deny-old.mts'])
    check(`older-script copy stages ${want}`, s.includes(want), s.join(', '))
  check('edited copy of a retired page stays', !s.some(l => l.endsWith('docs/template/new.md')) && existsSync(join(kid, 'docs/template/new.md')), s.join(', '))
  check('edited copy of a retired page is listed as kept', r.stdout.includes('\nKept (') && r.stdout.includes('\n  docs/template/new.md\n'), r.stdout)
  check('own skill stays unmentioned', !s.some(l => l.endsWith('.claude/skills/own/SKILL.md')) && existsSync(join(kid, '.claude/skills/own/SKILL.md')) && !r.stdout.includes('.claude/skills/own'), r.stdout)
  gitSafe(kid, 'commit', '-q', '-m', 'chore: sync mechanics from template')

  write(routeTemplate, '.claude/rules/extra.md', '# extra rule\n')
  commit(routeTemplate, 'feat: an extra rule', T4_AT)
  run(kid)
  gitSafe(kid, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(kid, STATE, json({ url: routeUrl, commit: readState(kid).commit, exclude: ['.claude/rules'] }))
  commit(kid, 'chore: exclude the rules')
  git(routeTemplate, 'rm', '-q', '.claude/rules/extra.md')
  commit(routeTemplate, 'refactor: retire the extra rule')
  const excluded = run(kid)
  check('excluded path keeps the rule the template retired', excluded.status === 0 && !staged(kid).some(l => l.endsWith('.claude/rules/extra.md')), excluded.detail)
  gitSafe(kid, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  write(routeTemplate, 'docs/template/a.md', '# a v2\n')
  commit(routeTemplate, 'docs: a v2')
  write(kid, STATE, json({ url: routeUrl, commit: readState(kid).commit }))
  commit(kid, 'chore: sync the rules again')
  const back = run(kid)
  check('dropped exclusion exits 0', back.status === 0, back.detail)
  check('dropped exclusion retires the rule the template retired meanwhile', staged(kid).includes('D .claude/rules/extra.md'), staged(kid).join(', '))
}

// 25. A fork used as a template: its state file records its own sync from upstream, and "Use
// this template" copies that file into each repository made from it. There it came with the
// first commit and names another repository as its writer, so the sync takes the fork as the
// template, as a first sync, instead of reverting the fork's customizations from upstream. A
// clone with another origin, or a history squashed into one commit, is not a copy.
{
  const upstream = join(tmp, 'fork-upstream')
  mkdirSync(upstream)
  git(upstream, 'init', '-q', '-b', 'main')
  write(upstream, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(upstream, '.claude/skills/x/SKILL.md', '# x\n')
  commit(upstream, 'chore: t1', T1_AT)
  const UPSTREAM = pathToFileURL(upstream).href
  const acme = join(tmp, 'acme')
  git(tmp, 'clone', '-q', UPSTREAM, acme)
  const ACME_URL = pathToFileURL(acme).href
  git(acme, 'remote', 'set-url', 'origin', ACME_URL)
  write(acme, '.claude/skills/x/SKILL.md', '# x, the acme way\n')
  commit(acme, 'feat: acme skill')
  // Made from the fork before the fork's own first sync, so it syncs later with no state file.
  const early = join(tmp, 'acme-early')
  copyTree(acme, early)
  git(early, 'init', '-q', '-b', 'main')
  commit(early, 'Initial commit')
  git(early, 'remote', 'add', 'origin', 'file:///example/acme-early')
  const synced = run(acme, UPSTREAM)
  check('fork syncs from upstream', synced.status === 0, synced.detail)
  gitSafe(acme, 'restore', '--staged', '--worktree', '--', '.claude/skills/x/SKILL.md')
  gitSafe(acme, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  const forkState = readState(acme)
  check('fork records itself as the writer', forkState.url === UPSTREAM && forkState.repo === ACME_URL, JSON.stringify(forkState))
  check('fork says which URL it recorded as itself', synced.stdout.includes(`Recorded this repository as ${ACME_URL} ("repo" in ${STATE})`), synced.stdout)
  const acmeHead = git(acme, 'rev-parse', 'HEAD').trim()

  // The fork's state file is its sync point with upstream, never a file to restore here: taking
  // it would point this repository's next sync at upstream.
  const fromEarly = run(early, ACME_URL)
  check('copy made before the fork synced exits 0', fromEarly.status === 0 && fromEarly.stdout.includes('(root tree)'), fromEarly.detail)
  check('the fork\'s state file is never a file to restore', !fromEarly.stdout.includes(`  ${STATE}  missing here`), fromEarly.stdout)
  check('copy made before the fork synced lists no file', fromEarly.stdout.includes('Files: none new.'), fromEarly.stdout)
  const earlyState = readState(early)
  check('copy made before the fork synced records the fork and itself', earlyState.url === ACME_URL && earlyState.commit === acmeHead && earlyState.repo === 'file:///example/acme-early', JSON.stringify(earlyState))

  const app = join(tmp, 'acme-app')
  copyTree(acme, app)
  git(app, 'init', '-q', '-b', 'main')
  commit(app, 'Initial commit')
  git(app, 'remote', 'add', 'origin', 'file:///example/acme-app')
  const r = run(app)
  check('copy of a fork exits 0', r.status === 0, r.detail)
  check('copy of a fork says whose state file it holds', r.stderr.includes('came with this repository\'s first commit') && r.stderr.includes(ACME_URL), r.stderr)
  check('copy of a fork syncs from the fork', r.stdout.startsWith(`Template: ${ACME_URL}\n`), r.stdout)
  check('copy of a fork runs a first sync', r.stdout.includes('first sync') && r.stdout.includes(`Baseline: ${acmeHead.slice(0, 7)} (root tree)`), r.stdout)
  check('copy of a fork keeps the fork\'s customization', !staged(app).some(l => l.includes('skills/x/SKILL.md')) && readFileSync(join(app, '.claude/skills/x/SKILL.md'), 'utf8') === '# x, the acme way\n', staged(app).join(', '))
  const own = readState(app)
  check('copy of a fork records the fork and itself', own.url === ACME_URL && own.commit === acmeHead && own.repo === 'file:///example/acme-app', JSON.stringify(own))
  check('copy of a fork says which URL it recorded as itself', r.stdout.includes('Recorded this repository as file:///example/acme-app'), r.stdout)
  const again = run(app)
  check('copy of a fork rerun before commit is its own', again.status === 0 && again.stderr === '' && again.stdout.includes('unchanged since last sync'), again.detail)
  check('a recorded writer is announced once', !again.stdout.includes('Recorded this repository'), again.stdout)
  gitSafe(app, 'commit', '-q', '-m', 'chore: sync mechanics from template')

  const clone = join(tmp, 'acme-app-clone')
  git(tmp, 'clone', '-q', pathToFileURL(app).href, clone)
  const cloned = run(clone)
  check('clone with another origin keeps the recorded template', cloned.status === 0 && cloned.stderr === '' && cloned.stdout.startsWith(`Template: ${ACME_URL}\n`) && cloned.stdout.includes('unchanged since last sync'), cloned.detail)
  check('clone with another origin keeps the recorded writer', staged(clone).length === 0 && readState(clone).repo === 'file:///example/acme-app', staged(clone).join(', '))
  write(clone, STATE, json({ url: ACME_URL, commit: acmeHead }))
  commit(clone, 'chore: a state file from an older script')
  git(clone, 'remote', 'set-url', 'origin', 'https://ghp-token@example.com/acme/app.git')
  const older = run(clone)
  check('state file with no writer records this origin once, credentials dropped', older.status === 0 && older.stdout.includes('unchanged since last sync') && staged(clone).includes(`M ${STATE}`) && readState(clone).repo === 'https://example.com/acme/app.git', `${older.detail}; ${JSON.stringify(readState(clone))}`)
  check('the writer taken from a contributor\'s origin is announced for review', older.stdout.includes('Recorded this repository as https://example.com/acme/app.git') && older.stdout.includes('personal fork'), older.stdout)

  const squashed = join(tmp, 'acme-app-squashed')
  copyTree(app, squashed)
  git(squashed, 'init', '-q', '-b', 'main')
  commit(squashed, 'chore: squash history')
  git(squashed, 'remote', 'add', 'origin', 'file:///example/acme-app')
  const flat = run(squashed)
  check('squashed history with its own state file is not a copy', flat.status === 0 && flat.stderr === '' && flat.stdout.includes('unchanged since last sync'), flat.detail)

  const legacy = join(tmp, 'acme-legacy')
  copyTree(acme, legacy)
  write(legacy, STATE, json({ url: UPSTREAM, commit: forkState.commit, exclude: ['.gemini/settings.json'] }))
  git(legacy, 'init', '-q', '-b', 'main')
  commit(legacy, 'Initial commit')
  const old = run(legacy)
  check('copy of an unnamed writer exits 0', old.status === 0, old.detail)
  check('copy of an unnamed writer says to pass the template', old.stderr.includes('came with this repository\'s first commit') && old.stderr.includes('pass its URL'), old.stderr)
  check('copy of an unnamed writer runs a first sync from the recorded url', old.stdout.startsWith(`Template: ${UPSTREAM}\n`) && old.stdout.includes('first sync'), old.stdout)
  check('copy of an unnamed writer keeps the lists', JSON.stringify(readState(legacy).exclude) === '[".gemini/settings.json"]', JSON.stringify(readState(legacy)))
  gitSafe(legacy, 'restore', '--staged', '--worktree', '--', '.claude/skills/x/SKILL.md')
  const rerun = run(legacy)
  check('copy with no origin, rerun before commit, reads its own sync point', rerun.status === 0 && rerun.stderr === '' && rerun.stdout.includes('unchanged since last sync'), rerun.detail)
}

// 26. What a synced gate needs beyond the synced paths is reported three-way like the scripts:
// packageManager and the devDependencies, lint-staged, and simple-git-hooks blocks of
// package.json, the top-level settings of pnpm-workspace.yaml (catalog, allowBuilds,
// trustPolicyExclude, scalars), and a file the template added outside the synced paths. A value
// changed on both sides is labelled so, with the baseline's value. The template's own records,
// release history, samples, and synced files are never listed, nor is the repository's own
// entry, its package globs, or a flow-style value.
{
  const depsTemplate = join(tmp, 'deps-template')
  mkdirSync(depsTemplate)
  git(depsTemplate, 'init', '-q', '-b', 'main')
  const manifest = (devDependencies: Record<string, string>, preCommit: string, lintStaged: Record<string, unknown>, packageManager = 'pnpm@11.0.0', scripts: Record<string, string> = { lint: 'eslint .' }): string =>
    json({ 'name': 'fixture', packageManager, 'engines': { node: '>=24' }, scripts, devDependencies, 'simple-git-hooks': { 'pre-commit': preCommit }, 'lint-staged': lintStaged })
  const T1_SETTINGS = 'allowBuilds:\n  esbuild: true\n\nminimumReleaseAge: 2880\n\ntrustPolicyExclude:\n  - vite@5.4.21\n'
  const workspace = (catalog: Record<string, string>, settings = T1_SETTINGS): string =>
    `${settings}packages:\n  - packages/*\n\n# Catalog-first: every version lives here once.\ncatalog:\n${Object.entries(catalog).map(([name, range]) => `  ${name.startsWith('@') ? `'${name}'` : name}: ${range}\n`).join('')}`
  write(depsTemplate, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(depsTemplate, 'package.json', manifest({ 'eslint': 'catalog:', 'lint-staged': 'catalog:', 'vitepress': 'catalog:' }, 'pnpm lint-staged', { '*.ts': 'eslint --fix' }))
  write(depsTemplate, 'pnpm-workspace.yaml', workspace({ '@types/node': '^24.0.0', 'eslint': '^9.0.0', 'lint-staged': '^16.0.0', 'vitepress': '^1.6.0' }))
  write(depsTemplate, '.claude/rules/tpl.md', '# tpl rule\n')
  commit(depsTemplate, 'chore: t1', T1_AT)
  const depsUrl = pathToFileURL(depsTemplate).href
  const kid = join(tmp, 'deps-child')
  copyTree(depsTemplate, kid)
  git(kid, 'init', '-q', '-b', 'main')
  commit(kid, 'Initial commit', COPY_AT)
  // Its own pnpm (`corepack use pnpm@latest`), and its own secrets scan before the template has one.
  write(kid, 'package.json', manifest({ 'eslint': 'catalog:', 'lint-staged': 'catalog:', 'zod': 'catalog:' }, 'pnpm lint-staged', { '*.ts': 'eslint --fix' }, 'pnpm@11.5.0', { 'lint': 'eslint .', 'lint:secrets': 'secretlint .' }))
  write(kid, 'pnpm-workspace.yaml', `${workspace({ '@types/node': '^24.0.0', 'eslint': '^9.1.0', 'lint-staged': '^16.0.0' }, T1_SETTINGS.replace('2880', '1440'))}  zod: ^3.0.0 # own\n`)
  commit(kid, 'chore: own dependencies')
  write(depsTemplate, 'package.json', manifest({ 'eslint': 'catalog:', 'lint-staged': 'catalog:', 'secretlint': 'catalog:', 'vitepress': 'catalog:' }, 'CI=1 pnpm lint-staged', { '*.ts': 'eslint --fix', '*': ['secretlint --no-glob'] }, 'pnpm@11.9.0', { 'lint': 'eslint .', 'lint:secrets': 'secretlint --maskSecrets .' }))
  const T2_SETTINGS = 'allowBuilds:\n  \'@parcel/watcher\': false\n  esbuild: true\n\nminimumReleaseAge: 2880\nonlyBuiltDependencies: [esbuild]\nshellEmulator: true # scripts run alike on Windows\n\ntrustPolicyExclude:\n  - vite@5.4.21\n  - vite@5.4.22 # the next one\n'
  write(depsTemplate, 'pnpm-workspace.yaml', workspace({ '@types/node': '^24.5.0', 'eslint': '^9.0.0', 'lint-staged': '^16.0.0', 'secretlint': '^13.0.0', 'vitepress': '^1.6.0' }, T2_SETTINGS))
  write(depsTemplate, '.secretlintrc.json', '{ "rules": [] }\n')
  write(depsTemplate, '.claude/rules/secrets.md', '# secrets rule\n')
  write(depsTemplate, 'docs/internal/decisions/20260102-secretlint.md', '# Scan for secrets\n')
  write(depsTemplate, 'packages/example/src/secret.ts', 'export const s = 1\n')
  write(depsTemplate, 'CHANGELOG.md', '# Changelog\n')
  const added = commit(depsTemplate, 'feat(lint): scan for secrets', T2_AT)
  const r = run(kid, depsUrl)
  check('gate needs exit 0', r.status === 0, r.detail)
  check('gate needs have a root-tree baseline', r.stdout.includes('(root tree)'), r.stdout)
  check('devDependency the template added is missing here', r.stdout.includes('  devDependencies.secretlint  missing here\n    template: catalog:\n'), r.stdout)
  check('lint-staged entry the template added is missing here', r.stdout.includes('  lint-staged.*  missing here\n    template: ["secretlint --no-glob"]\n'), r.stdout)
  check('git hook the template changed is listed with both values', r.stdout.includes('  simple-git-hooks.pre-commit  changed on the template since the baseline\n    template: CI=1 pnpm lint-staged\n    yours:    pnpm lint-staged\n'), r.stdout)
  check('devDependency removed here is customized', r.stdout.includes('devDependencies.vitepress (absent here)'), r.stdout)
  check('catalog entry the template added is missing here', r.stdout.includes('  catalog.secretlint  missing here\n    template: ^13.0.0\n'), r.stdout)
  check('catalog range the template changed is listed with both values', r.stdout.includes('  catalog.@types/node  changed on the template since the baseline\n    template: ^24.5.0\n    yours:    ^24.0.0\n'), r.stdout)
  check('catalog ranges changed or removed here are customized', r.stdout.includes('catalog.eslint, catalog.vitepress (absent here)'), r.stdout)
  check('entries of the repository\'s own never mentioned', !r.stdout.includes('zod'), r.stdout)
  check('packageManager changed on both sides is labelled so, with the baseline value', r.stdout.includes('  packageManager  changed on both sides since the baseline\n    base:     pnpm@11.0.0\n    template: pnpm@11.9.0\n    yours:    pnpm@11.5.0\n'), r.stdout)
  check('script the template added and this repository already has is changed on both sides', r.stdout.includes('  scripts.lint:secrets  changed on both sides since the baseline\n    base:     (absent)\n    template: secretlint --maskSecrets .\n    yours:    secretlint .\n'), r.stdout)
  check('allowBuilds entry the template added is missing here', r.stdout.includes('  allowBuilds.@parcel/watcher  missing here\n    template: false\n'), r.stdout)
  check('workspace setting the template added is missing here, its comment dropped', r.stdout.includes('  shellEmulator  missing here\n    template: true\n'), r.stdout)
  check('trustPolicyExclude item the template added is missing here', r.stdout.includes('  trustPolicyExclude.vite@5.4.22  missing here\n    template: - vite@5.4.22\n'), r.stdout)
  check('workspace setting changed here is customized', r.stdout.includes('Customized locally (unchanged on the template since the baseline): minimumReleaseAge, catalog.eslint'), r.stdout)
  for (const never of ['packages', 'onlyBuiltDependencies', 'allowBuilds.esbuild', 'trustPolicyExclude.vite@5.4.21', 'engines.node'])
    check(`setting the same on both sides or not read is never listed: ${never}`, !r.stdout.includes(`  ${never}  `), r.stdout)
  check('file the template added outside the synced paths is listed', r.stdout.includes(`  .secretlintrc.json  missing here\n    git restore --source=${added.slice(0, 7)} --staged --worktree -- .secretlintrc.json\n`), r.stdout)
  for (const never of ['docs/internal/decisions/20260102-secretlint.md', 'packages/example/src/secret.ts', '.claude/rules/secrets.md', 'CHANGELOG.md'])
    check(`added file never listed: ${never}`, !r.stdout.includes(`  ${never}  missing here`), r.stdout)
  gitSafe(kid, 'restore', `--source=${added.slice(0, 7)}`, '--staged', '--worktree', '--', '.secretlintrc.json')
  check('the printed command fetches the file', readFileSync(join(kid, '.secretlintrc.json'), 'utf8') === '{ "rules": [] }\n')
  // A worktree-only restore leaves the file untracked, so a plain commit would leave it out.
  check('the printed command stages the file', gitSafe(kid, 'diff', '--cached', '--name-only').split('\n').includes('.secretlintrc.json'), gitSafe(kid, 'status', '--porcelain'))
  gitSafe(kid, 'commit', '-q', '-m', 'chore: sync mechanics from template')
  const again = run(kid)
  check('gate needs rerun lists no file', again.status === 0 && again.stdout.includes('Files: none new.'), again.stdout)
  const bare = join(tmp, 'deps-bare')
  mkdirSync(bare)
  git(bare, 'init', '-q', '-b', 'main')
  write(bare, 'package.json', manifest({}, 'true', {}))
  commit(bare, 'chore: init')
  write(bare, 'scripts/sync-template.mts', REAL_SCRIPT)
  const none = run(bare, depsUrl)
  check('no baseline exits 0', none.status === 0, none.detail)
  check('no baseline lists every template devDependency two-way', none.stdout.includes('  devDependencies.secretlint  missing here\n') && none.stdout.includes('  devDependencies.eslint  missing here\n'), none.stdout)
  check('no pnpm-workspace.yaml skips the workspace settings', none.stdout.includes('Workspace: skipped — no pnpm-workspace.yaml here.'), none.stdout)
  check('no baseline skips the files', none.stdout.includes('Files: skipped — '), none.stdout)
}

// 27. A shallow clone cuts the parents off its oldest commit, so the commit that wrote the state
// file there looks like a root commit. Its state file, written by the script before behavior 25
// and so naming no writer, is still this repository's own: the sync starts at the recorded
// commit and lists the breaking one since.
{
  const shallowTemplate = join(tmp, 'shallow-template')
  mkdirSync(shallowTemplate)
  git(shallowTemplate, 'init', '-q', '-b', 'main')
  write(shallowTemplate, 'scripts/sync-template.mts', REAL_SCRIPT)
  write(shallowTemplate, '.claude/skills/x/SKILL.md', '# x\n')
  const recorded = commit(shallowTemplate, 'chore: t1', T1_AT)
  const shallowUrl = pathToFileURL(shallowTemplate).href
  const kid = join(tmp, 'shallow-child')
  copyTree(shallowTemplate, kid)
  git(kid, 'init', '-q', '-b', 'main')
  write(kid, STATE, json({ url: shallowUrl, commit: recorded }))
  commit(kid, 'Initial commit', COPY_AT)
  write(kid, 'src/app.ts', 'export const app = true\n')
  commit(kid, 'feat: own work', COPY_AT)
  write(shallowTemplate, '.claude/skills/x/SKILL.md', '# x v2\n')
  commit(shallowTemplate, 'feat!: new required config\n\nBREAKING CHANGE: add foo to package.json by hand.\n', T2_AT)
  const shallow = join(tmp, 'shallow-clone')
  git(tmp, 'clone', '-q', '--depth', '1', pathToFileURL(kid).href, shallow)
  const r = run(shallow)
  check('shallow clone exits 0', r.status === 0, r.detail)
  check('shallow clone reads its own state file', r.stderr === '' && !r.stdout.includes('first sync'), r.detail)
  check('shallow clone lists the breaking commit since the sync point', r.stdout.includes('1 commit since last sync') && r.stdout.includes('BREAKING CHANGE: add foo to package.json by hand.'), r.stdout)
}

if (fails.length > 0) {
  console.error(`\n✖ sync fixtures — ${fails.length} of ${checks} checks failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ sync fixtures — ${checks} checks pass`)
