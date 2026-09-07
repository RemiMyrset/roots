/**
 * The done gate: runs every check CI runs, in CI order, and stops at the first
 * failure naming the gate. `pnpm verify` is what "done" means in AGENTS.md; the
 * individual commands stay listed there for targeted runs, and `pnpm verify <gate>`
 * resumes at a named gate after a fix. Runs from the repository root whatever the
 * cwd. Node builtins only, so it runs in any repo it is synced into. The
 * generated-docs drift check needs a git checkout; outside one it is skipped with a
 * note rather than failing. Gates marked template mechanics test code synced from
 * the roots template: a failure there means re-sync, not a bug in this repo.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

interface Gate {
  name: string
  run: () => boolean
  /** Template mechanics synced from roots: a failure means re-sync (or report upstream), not a bug in this repo's code. */
  template?: true
}

function pnpm(...args: string[]): boolean {
  const r = spawnSync(PNPM, args, { stdio: 'inherit' })
  if (r.error) {
    console.error(`  could not run ${PNPM}: ${r.error.message} — install pnpm (corepack enable on node 24, or npm i -g pnpm)`)
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
const from = process.argv[2]
const start = from === undefined ? 0 : GATES.findIndex(g => script(g) === from)
if (start === -1) {
  console.error(`✖ verify — unknown gate "${from}". Gates: ${GATES.map(script).join(', ')}`)
  process.exit(1)
}

for (const gate of GATES.slice(start)) {
  console.log(`\n▶ ${gate.name}${gate.template ? '  (template mechanics)' : ''}`)
  if (!gate.run()) {
    console.error(`\n✖ verify — failed at ${gate.name}. Fix it, then resume with: pnpm verify ${script(gate)}`)
    if (gate.template)
      console.error('  This gate tests mechanics synced from the roots template, not this repo\'s code: run `pnpm sync:template` to pick up the fix, or report it upstream — do not patch the synced files here.')
    process.exit(1)
  }
}
console.log(`\n✔ verify — ${GATES.length - start} gates pass`)
