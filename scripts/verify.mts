/**
 * The done gate: runs every check CI runs, in CI order, and stops at the first
 * failure naming the gate. `pnpm verify` is what "done" means in AGENTS.md; the
 * individual commands stay listed there for targeted runs, `pnpm verify <gate>`
 * resumes at a named gate after a fix, and `pnpm verify --only <gate>` runs that one
 * gate (CI runs it on both runners as a smoke test of this script's own spawn path).
 * The first gate is the frozen-lockfile install CI starts with, so a stale lockfile
 * fails here and not only in CI. Runs from the repository root whatever the cwd. Node builtins only, so it runs in any repo it is synced into. The
 * generated-docs drift check needs a git checkout; outside one it is skipped with a
 * note rather than failing. Gates marked template mechanics test code synced from
 * the roots template: a failure there means re-sync, not a bug in this repo.
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
  /** Template mechanics synced from roots: a failure means re-sync (or report upstream), not a bug in this repo's code. */
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

function porcelain(): string | null {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}

// Run from the repository root regardless of cwd; outside a checkout stay put (the drift
// gate then skips itself).
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
if (top.status === 0 && top.stdout.trim())
  process.chdir(top.stdout.trim())

const GATES: Gate[] = [
  { name: 'install (frozen lockfile)', run: () => pnpm('install', '--frozen-lockfile', '--prefer-offline') },
  { name: 'typecheck', run: () => pnpm('typecheck') },
  { name: 'lint', run: () => pnpm('lint') },
  { name: 'lint:secrets', run: () => pnpm('lint:secrets') },
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
      if (!pnpm('docs:gen'))
        return false
      const after = porcelain()
      if (before === null || after === null) {
        console.log('  (drift check skipped: not a git checkout)')
        return true
      }
      if (after !== before) {
        console.error('Generated docs are stale — commit the regenerated output:')
        console.error(after)
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
    if (gate.template)
      console.error('  This gate tests mechanics synced from the roots template, not this repo\'s code: run `pnpm sync:template` to pick up the fix, or report it upstream — do not patch the synced files here.')
    process.exit(1)
  }
}
console.log(`\n✔ verify — ${selected.length} gate${selected.length === 1 ? '' : 's'} pass`)
