/**
 * The done gate: runs every check CI runs, in CI order, and stops at the first
 * failure naming the gate. `pnpm verify` is what "done" means in AGENTS.md; the
 * individual commands stay listed there for targeted runs. Node builtins only,
 * so it runs in any repo it is synced into. The generated-docs drift check needs
 * a git checkout; outside one it is skipped with a note rather than failing.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

interface Gate {
  name: string
  run: () => boolean
}

function pnpm(...args: string[]): boolean {
  const r = spawnSync(PNPM, args, { stdio: 'inherit' })
  return r.status === 0
}

function porcelain(): string | null {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}

const GATES: Gate[] = [
  { name: 'typecheck', run: () => pnpm('typecheck') },
  { name: 'lint', run: () => pnpm('lint') },
  { name: 'lint:secrets', run: () => pnpm('lint:secrets') },
  { name: 'test', run: () => pnpm('test') },
  { name: 'test:hooks', run: () => pnpm('test:hooks') },
  { name: 'test:sync', run: () => pnpm('test:sync') },
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

for (const gate of GATES) {
  console.log(`\n▶ ${gate.name}`)
  if (!gate.run()) {
    console.error(`\n✖ verify — failed at ${gate.name}. Fix it, then re-run pnpm verify.`)
    process.exit(1)
  }
}
console.log(`\n✔ verify — ${GATES.length} gates pass`)
