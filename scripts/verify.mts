/**
 * The done gate: runs every check CI runs, in CI order, and stops at the first
 * failure naming the gate. `pnpm verify` is what "done" means in AGENTS.md; the
 * individual commands stay listed there for targeted runs, `pnpm verify <gate>`
 * resumes at a named gate after a fix, and `pnpm verify --only <gate>` runs that one
 * gate (CI runs it on both runners as a smoke test of this script's own spawn path).
 * The first gate is the frozen-lockfile install CI starts with, so a stale lockfile
 * fails here and not only in CI. Runs from the repository root whatever the cwd. Node builtins only, so it runs in any repo it is synced into. The
 * generated-docs drift check needs a git checkout: outside one, or without git, it is
 * skipped with a note; any other git failure, such as git refusing a checkout another
 * user owns, fails it, since a skip there would pass stale generated docs. Gates marked
 * template mechanics test code synced from the roots template: a failure there means
 * re-sync, unless it names a file this repo owns.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

// On Windows, pnpm is a `.cmd` shim, and node refuses to spawn a batch file without a shell
// (EINVAL since the CVE-2024-27980 fix), while a `shell: true` spawn with args is deprecated
// (DEP0190). So the gate runs through `cmd.exe /c` there, the form the node docs recommend;
// every argument is a script name from this file, never user input, so no quoting is needed.
const WIN = process.platform === 'win32'
const PNPM = WIN ? 'cmd.exe' : 'pnpm'

interface Gate {
  name: string
  run: () => boolean
  /** Template mechanics synced from roots: a failure means re-sync or report upstream, unless it names a file this repo owns. */
  template?: true
}

function pnpm(...args: string[]): boolean {
  const argv = WIN ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')] : args
  const r = spawnSync(PNPM, argv, { stdio: 'inherit' })
  if (r.error) {
    console.error(`  could not run pnpm ${args.join(' ')}: ${r.error.message} — install pnpm (corepack enable on node 24, or npm i -g pnpm)`)
    return false
  }
  return r.status === 0
}

/**
 * `git status --porcelain`, or why there is none: `skip` when git is missing or this is no
 * git checkout, `error` for any other failure. Git runs in the C locale so its "not a git
 * repository" message is matched whatever the user's language.
 */
function porcelain(): { status: string } | { skip: string } | { error: string } {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (r.error)
    return (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? { skip: 'git is not installed' } : { error: r.error.message }
  if (r.status === 0)
    return { status: r.stdout }
  if (/\bnot a git repository\b/.test(r.stderr))
    return { skip: 'not a git checkout' }
  return { error: r.stderr.trim() || `git status exited with ${r.status}` }
}

/** Prints why the drift check could not read git status, with the fix for the common cause. */
function gitFailed(error: string): false {
  console.error(`git status failed, so the drift check cannot compare the generated docs:\n${error}`)
  console.error('  If git calls the ownership dubious (a checkout owned by another user, as in some containers),')
  console.error('  mark it safe: git config --global --add safe.directory <path of this checkout>')
  return false
}

// Run from the repository root regardless of cwd; where git finds no checkout, stay put (the
// drift gate then skips itself, or fails when git refused the checkout).
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
if (top.status === 0 && top.stdout.trim())
  process.chdir(top.stdout.trim())

const GATES: Gate[] = [
  { name: 'install (frozen lockfile)', run: () => pnpm('install', '--frozen-lockfile', '--prefer-offline') },
  { name: 'typecheck', run: () => pnpm('typecheck') },
  { name: 'lint', run: () => pnpm('lint') },
  { name: 'lint:secrets', run: () => pnpm('lint:secrets') },
  { name: 'boundaries', run: () => pnpm('boundaries') },
  { name: 'test', run: () => pnpm('test') },
  { name: 'test:hooks', run: () => pnpm('test:hooks'), template: true },
  { name: 'test:sync', run: () => pnpm('test:sync'), template: true },
  { name: 'test:docs', run: () => pnpm('test:docs'), template: true },
  { name: 'test:gates', run: () => pnpm('test:gates'), template: true },
  { name: 'build', run: () => pnpm('build') },
  {
    name: 'docs:gen (no drift)',
    run: () => {
      const before = porcelain()
      if ('error' in before)
        return gitFailed(before.error)
      if (!pnpm('docs:gen'))
        return false
      if ('skip' in before) {
        console.log(`  (drift check skipped: ${before.skip})`)
        return true
      }
      const after = porcelain()
      if (!('status' in after))
        return gitFailed('error' in after ? after.error : after.skip)
      if (after.status !== before.status) {
        console.error('Generated docs are stale — commit the regenerated output:')
        console.error(after.status)
        return false
      }
      return true
    },
  },
  { name: 'docs:check', run: () => pnpm('docs:check') },
  { name: 'docs:portability', run: () => pnpm('docs:portability') },
  { name: 'docs:internal:build', run: () => pnpm('docs:internal:build') },
  { name: 'docs:public:build', run: () => pnpm('docs:public:build') },
]

const script = (g: Gate): string => g.name.split(' ')[0]!
// `pnpm verify [<gate>]` resumes at a gate; `pnpm verify --only <gate>` runs just that one.
const argv = process.argv.slice(2)
const onlyAt = argv.indexOf('--only')
const only = onlyAt === -1 ? undefined : argv[onlyAt + 1]
const wanted = onlyAt === -1 ? argv[0] : only
const start = wanted === undefined ? 0 : GATES.findIndex(g => script(g) === wanted)
if (start === -1 || (onlyAt !== -1 && only === undefined)) {
  console.error(`✖ verify — unknown gate "${wanted ?? ''}". Gates: ${GATES.map(script).join(', ')}`)
  process.exit(1)
}
const selected = onlyAt === -1 ? GATES.slice(start) : [GATES[start]!]

for (const gate of selected) {
  console.log(`\n▶ ${gate.name}${gate.template ? '  (template mechanics)' : ''}`)
  if (!gate.run()) {
    console.error(`\n✖ verify — failed at ${gate.name}. Fix it, then resume with: pnpm verify ${script(gate)}`)
    if (gate.template) {
      console.error('  This gate tests mechanics synced from the roots template. If the failure names a file this repo owns (its own workflow, AGENTS.md, .claude/settings.json, package.json), fix that file here.')
      console.error('  If it names only synced files, the fix belongs in the template: in a child, run `pnpm sync:template` to pick it up or report it upstream, and do not patch the synced files.')
    }
    process.exit(1)
  }
}
console.log(`\n✔ verify — ${selected.length} gate${selected.length === 1 ? '' : 's'} pass`)
