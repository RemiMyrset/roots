/**
 * Regression suite for the .claude/hooks PreToolUse guards. Pipes crafted tool-call
 * JSON to each guard and asserts its exit code (2 = deny, 0 = allow). Runs in CI via
 * `pnpm test:hooks` so a guard bypass can never ship silently again — every case below
 * is a line an agent might plausibly type. Node builtins only; no deps. Node 24 runs
 * this `.mts` natively.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

type Guard = 'deny-non-pnpm.sh' | 'deny-build-scripts.sh' | 'deny-secret-reads.sh'
interface Case { guard: Guard, expect: 0 | 2, cmd: string }

const HOOKS = join(import.meta.dirname, '..', '.claude', 'hooks')
const D = 2 // deny
const A = 0 // allow

const CASES: Case[] = [
  // --- deny-non-pnpm: this repo is pnpm-only ---------------------------------
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '/usr/bin/npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'yarn add foo' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'bunx cowsay' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '(npm install)' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'foo; npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'foo && npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'echo hi | npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '$(npm install)' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'pnpm exec npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'pnpm --filter x exec npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'pnpm --filter x dlx npm i' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'sudo -u root npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'timeout 5 npm i' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '! npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'until npm install; do sleep 1; done' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'if npm test; then echo ok; fi' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'npm install evil command -v x' }, // pass-7 probe bypass regression
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'yarn add command -v foo' }, //       pass-7 probe bypass regression
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'pnpm install' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'pnpm --filter @acme/core test' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'pnpm exec eslint .' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'command -v npm' }, //           presence probe, runs nothing
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'if command -v npm; then echo yes; fi' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'git commit -m "fix (npm bug)"' }, // quoted mention
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'echo "(npm)"' },

  // --- deny-build-scripts: no dependency build-script enabling ---------------
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'pnpm approve-builds' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'pnpm --filter x approve-builds' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'sudo pnpm approve-builds' },
  { guard: 'deny-build-scripts.sh', expect: A, cmd: 'pnpm install' },
  { guard: 'deny-build-scripts.sh', expect: A, cmd: 'echo "(pnpm approve-builds)"' },

  // --- deny-secret-reads: no shell reads of secret files ---------------------
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat /home/app/.env.production' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'sort .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'head secrets/token' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat Secrets/token' }, //  secrets/ match is case-insensitive
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat SECRETS/token' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat key.pem' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'pnpm exec cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: '/usr/bin/pnpm exec cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'corepack pnpm exec cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'find . -name .env -exec cat {} +' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'find secrets -exec cat {} +' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'sudo -u root cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'if cat .env; then echo hi; fi' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .env command -v x' }, //   pass-7 probe bypass regression
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'grep secret .env command -v' }, // pass-7 probe bypass regression
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'od -o .env' }, //               pass-7 -o bypass regression
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'strings -o .env' }, //          pass-7 -o bypass regression
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'grep foo -o .env' }, //         pass-7 -o bypass regression
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'sort -o out.txt .env' }, //     input .env still scanned
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'cat README.md' },
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'cat .env.example' },
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'git commit -m "note about .env"' },
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'command -v cat .env' }, //      probe: .env is an ignored arg
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'sort -o .env.out data.txt' }, // .env.out is the output target

  // --- pass-9 regressions: the 5 bypass classes the deep fuzz found -----------
  // (1) timeout -s SIGNAL value-flag
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'timeout -s KILL 5 npm install' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'timeout -s KILL 5 pnpm approve-builds' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'timeout -s TERM 5 cat .env' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'timeout -s KILL 5 pnpm install' },
  // (2) glued redirect operators
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'npm</dev/null install' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'pnpm</dev/null approve-builds' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat<.env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat <>.env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'head<key.pem' },
  // (3) diff family readers
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'diff .env.example .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cmp -l .env /dev/null' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'fmt .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'sdiff .env x' },
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'diff a.txt b.txt' },
  // (4) unlisted exec wrappers
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'setsid npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'stdbuf -oL npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'doas npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'runuser -u x npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'flock /tmp/l npm install' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'stdbuf -oL cat .env' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'setsid pnpm approve-builds' },
  // (5) nested pnpm exec
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'pnpm exec pnpm exec npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'pnpm dlx pnpm dlx npm i' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'pnpm exec pnpm exec cat .env' },

  // --- pass-10 (audit 7): per-wrapper flag-arity bypass class ------------------
  // Boolean wrapper flags a single global VALUE_FLAG wrongly treated as value-taking,
  // swallowing the real head. Now per-wrapper (WRAP_VALUE_FLAGS): these stay boolean.
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'sudo -k npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'sudo -n npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'sudo -s npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'flock -n /tmp/l npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'flock -s /tmp/l npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'flock -u /tmp/l npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'doas -n npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'env -i npm install' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'sudo -k pnpm approve-builds' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: 'flock -n /tmp/l pnpm approve-builds' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'sudo -k cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'flock -n /tmp/l cat .env' },
  // Under-consume: a real value-flag absent from the old set left its arg as the head.
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'sudo -p prompt npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'xargs -a list npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'exec -a name npm install' },
  // taskset positional mask, both spellings (bare mask and -c cpu-list).
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'taskset 0x1 npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'taskset -c 0-3 npm install' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'taskset 0x1 cat .env' },
  // Defensive: a duration-less timeout must not swallow the banned head as its "duration".
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: 'timeout npm install' },
  // Controls: legitimate value-flag uses must still ALLOW (pin against over-correction).
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'sudo -u root pnpm install' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'flock -w 5 /tmp/l pnpm install' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'nice -n 10 pnpm install' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: 'taskset -c 0-3 pnpm install' },

  // --- pass-10 (audit 7): path-prefixed listed-wrapper bypass class ------------
  // skip() matched WRAP on the raw token but heads use base(); a path-prefixed wrapper
  // was never skipped. Now all wrapper decisions base()-normalize.
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '/usr/bin/sudo npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '/usr/bin/env npm install' },
  { guard: 'deny-non-pnpm.sh', expect: D, cmd: '/bin/nice npm install' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: '/usr/bin/sudo cat .env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: '/usr/bin/env cat .env' },
  { guard: 'deny-build-scripts.sh', expect: D, cmd: '/usr/bin/sudo pnpm approve-builds' },
  { guard: 'deny-non-pnpm.sh', expect: A, cmd: '/usr/bin/pnpm install' }, // path-prefixed pnpm still allowed

  // --- pass-10 (audit 7): over-block tighten — .env prefix must not catch .environment,
  // but real env-secret files (.envrc direnv, .env.local) stay denied.
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'cat .environment' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .envrc' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .env.local' },
  // --- pass-11 (audit 8): editor/backup copies are byte-identical secrets — must stay denied.
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .env~' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .envrc.bak' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .envrc~' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .env.production.bak' },
  // --- pass-12 (audit 9): .env match is case-insensitive (parity with *.pem/*.key).
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .ENV' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .Env' },
  { guard: 'deny-secret-reads.sh', expect: D, cmd: 'cat .ENV.LOCAL' },
  { guard: 'deny-secret-reads.sh', expect: A, cmd: 'cat .ENVIRONMENT' }, // not a secret; must stay allowed
]

const fails: string[] = []
for (const c of CASES) {
  const json = JSON.stringify({ tool_input: { command: c.cmd } })
  const r = spawnSync('bash', [join(HOOKS, c.guard)], { input: json })
  if (r.status !== c.expect)
    fails.push(`[${c.guard}] got ${r.status ?? 'null'}, want ${c.expect}: ${c.cmd}`)
}

if (fails.length > 0) {
  console.error(`\n✖ hook fixtures — ${fails.length} of ${CASES.length} failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ hook fixtures — ${CASES.length} guard cases pass (deny/allow correct)`)
