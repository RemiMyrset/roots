import type { GuardContext, Verdict } from '../.claude/hooks/_lexer.mts'
/**
 * Regression suite for the .claude/hooks agent guards and the session-start hook. Calls each
 * guard's verdict() in-process with a crafted command and context and asserts deny or allow;
 * pipes crafted tool-call JSON to the dispatcher that Claude Code actually registers and
 * asserts the exit code (2 = deny, 0 = allow); pipes session payloads to the session-start
 * hook and asserts the context it prints. Runs in CI via `pnpm test:hooks` so a
 * guard bypass can never ship silently again — every case below is a line an agent might
 * plausibly type. Node builtins only; no deps. Node 24 runs this `.mts` natively.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { resolveHead, tokenize } from '../.claude/hooks/_lexer.mts'
import { verdict as buildScripts } from '../.claude/hooks/deny-build-scripts.mts'
import { verdict as hookBypass } from '../.claude/hooks/deny-hook-bypass.mts'
import { verdict as nonPnpm } from '../.claude/hooks/deny-non-pnpm.mts'
import { verdict as pushProtected } from '../.claude/hooks/deny-push-protected.mts'
import { verdict as secretReads } from '../.claude/hooks/deny-secret-reads.mts'

type Guard = 'deny-non-pnpm.mts' | 'deny-build-scripts.mts' | 'deny-secret-reads.mts' | 'deny-push-protected.mts' | 'deny-hook-bypass.mts' | 'dispatch.mts'
interface Case { guard: Guard, expect: 0 | 2, cmd: string, env?: Record<string, string>, unset?: string[], cwd?: string, tool?: string, extra?: Record<string, unknown>, hooksDir?: string, raw?: string }

// The guards under test, in-process; the dispatcher is spawned because its contract is a process.
const VERDICTS: Record<Exclude<Guard, 'dispatch.mts'>, Verdict> = {
  'deny-non-pnpm.mts': nonPnpm,
  'deny-build-scripts.mts': buildScripts,
  'deny-secret-reads.mts': secretReads,
  'deny-push-protected.mts': pushProtected,
  'deny-hook-bypass.mts': hookBypass,
}

const HOOKS = join(import.meta.dirname, '..', '.claude', 'hooks')
const D = 2 // deny
const A = 0 // allow

// Throwaway checkouts for the push guard's implicit-target resolution (`git push`, `HEAD`):
// one on `main`, one on a feature branch, one detached. Created up front, removed at exit.
const tmp = mkdtempSync(join(tmpdir(), 'hooks-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
function checkout(name: string, branch: string, detach = false): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  const git = (...args: string[]): void => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' })
    if (r.status !== 0)
      throw new Error(`git ${args.join(' ')} failed in ${dir}`)
  }
  git('init', '-q', '-b', branch)
  if (detach) {
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('checkout', '-q', '--detach')
  }
  return dir
}
const ON_MAIN = checkout('on-main', 'main')
const ON_FEAT = checkout('on-feat', 'feat/x')
const DETACHED = checkout('detached', 'main', true)
const P = 'deny-push-protected.mts'

// A copy of .claude/ whose settings.json protects release/* instead of main: with the env
// var unset, the push guard must read the list from the file (Codex and Gemini never set it).
const SETTINGS_CLAUDE = join(tmp, 'settings-claude')
cpSync(join(HOOKS, '..'), SETTINGS_CLAUDE, { recursive: true })
writeFileSync(join(SETTINGS_CLAUDE, 'settings.json'), JSON.stringify({ env: { PROTECTED_BRANCHES: 'release/*' } }))
const SETTINGS_HOOKS = join(SETTINGS_CLAUDE, 'hooks')
const B = 'deny-hook-bypass.mts'

// Codex and Gemini CLI register the same dispatcher. Their payloads carry other
// top-level fields and, for Gemini, another tool name; the guards read only
// tool_input.command, so these shapes must deny and allow exactly like Claude Code.
const CODEX = { cwd: process.cwd(), hook_event_name: 'PreToolUse', model: 'x', permission_mode: 'default', session_id: 's', tool_use_id: 't', transcript_path: null, turn_id: 'u' }
const GEMINI = { cwd: process.cwd(), hook_event_name: 'BeforeTool', session_id: 's', timestamp: '2026-01-01T00:00:00Z', transcript_path: '/tmp/t.json' }

const CASES: Case[] = [
  // --- deny-non-pnpm: this repo is pnpm-only ---------------------------------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/usr/bin/npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'yarn add foo' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bunx cowsay' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '(npm install)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'foo; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'foo && npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo hi | npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '$(npm install)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm exec npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm --filter x exec npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm --filter x dlx npm i' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -u root npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'timeout 5 npm i' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '! npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'until npm install; do sleep 1; done' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'if npm test; then echo ok; fi' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm install evil command -v x' }, // pass-7 probe bypass regression
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'yarn add command -v foo' }, //       pass-7 probe bypass regression
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm --filter @acme/core test' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm exec eslint .' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'command -v npm' }, //           presence probe, runs nothing
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'if command -v npm; then echo yes; fi' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'git commit -m "fix (npm bug)"' }, // quoted mention
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo "(npm)"' },

  // --- deny-build-scripts: no dependency build-script enabling ---------------
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm --filter x approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'sudo pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm install' },

  // --- deny-secret-reads: keystores, netrc, npmrc join the secret set --------------
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat cert.p12' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head client.pfx' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat release.jks' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat CERT.PFX' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .netrc' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.netrc' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat _netrc' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .npmrc' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.npmrc' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat p12.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .netrc.md' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat npmrc-notes.md' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat pfx/README.md' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'echo "(pnpm approve-builds)"' },

  // --- deny-secret-reads: no shell reads of secret files ---------------------
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat /home/app/.env.production' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sort .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head secrets/token' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat Secrets/token' }, //  secrets/ match is case-insensitive
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat SECRETS/token' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat key.pem' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'pnpm exec cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '/usr/bin/pnpm exec cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'corepack pnpm exec cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name .env -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find secrets -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sudo -u root cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'if cat .env; then echo hi; fi' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env command -v x' }, //   pass-7 probe bypass regression
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep secret .env command -v' }, // pass-7 probe bypass regression
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'od -o .env' }, //               pass-7 -o bypass regression
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'strings -o .env' }, //          pass-7 -o bypass regression
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep foo -o .env' }, //         pass-7 -o bypass regression
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sort -o out.txt .env' }, //     input .env still scanned
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat README.md' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .env.example' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git commit -m "note about .env"' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'command -v cat .env' }, //      probe: .env is an ignored arg
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'sort -o .env.out data.txt' }, // .env.out is the output target

  // --- pass-9 regressions: the 5 bypass classes the deep fuzz found -----------
  // (1) timeout -s SIGNAL value-flag
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'timeout -s KILL 5 npm install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'timeout -s KILL 5 pnpm approve-builds' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'timeout -s TERM 5 cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'timeout -s KILL 5 pnpm install' },
  // (2) glued redirect operators
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm</dev/null install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm</dev/null approve-builds' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat<.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat <>.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head<key.pem' },
  // (3) diff family readers
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'diff .env.example .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cmp -l .env /dev/null' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'fmt .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sdiff .env x' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'diff a.txt b.txt' },
  // (4) unlisted exec wrappers
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'setsid npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'stdbuf -oL npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'doas npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -u x npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock /tmp/l npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'stdbuf -oL cat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'setsid pnpm approve-builds' },
  // (5) nested pnpm exec
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm exec pnpm exec npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm dlx pnpm dlx npm i' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'pnpm exec pnpm exec cat .env' },

  // --- pass-10 (audit 7): per-wrapper flag-arity bypass class ------------------
  // Boolean wrapper flags a single global VALUE_FLAG wrongly treated as value-taking,
  // swallowing the real head. Now per-wrapper (WRAP_VALUE_FLAGS): these stay boolean.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -k npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -n npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -s npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock -n /tmp/l npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock -s /tmp/l npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock -u /tmp/l npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'doas -n npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -i npm install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'sudo -k pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'flock -n /tmp/l pnpm approve-builds' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sudo -k cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'flock -n /tmp/l cat .env' },
  // Under-consume: a real value-flag absent from the old set left its arg as the head.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -p prompt npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'xargs -a list npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'exec -a name npm install' },
  // taskset positional mask, both spellings (bare mask and -c cpu-list).
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'taskset 0x1 npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'taskset -c 0-3 npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'taskset 0x1 cat .env' },
  // Defensive: a duration-less timeout must not swallow the banned head as its "duration".
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'timeout npm install' },
  // Controls: legitimate value-flag uses must still ALLOW (pin against over-correction).
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'sudo -u root pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'flock -w 5 /tmp/l pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'nice -n 10 pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'taskset -c 0-3 pnpm install' },

  // --- pass-10 (audit 7): path-prefixed listed-wrapper bypass class ------------
  // skip() matched WRAP on the raw token but heads use base(); a path-prefixed wrapper
  // was never skipped. Now all wrapper decisions base()-normalize.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/usr/bin/sudo npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/usr/bin/env npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/bin/nice npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '/usr/bin/sudo cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '/usr/bin/env cat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: '/usr/bin/sudo pnpm approve-builds' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '/usr/bin/pnpm install' }, // path-prefixed pnpm still allowed

  // --- pass-10 (audit 7): over-block tighten — .env prefix must not catch .environment,
  // but real env-secret files (.envrc direnv, .env.local) stay denied.
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .environment' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .envrc' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env.local' },
  // --- pass-11 (audit 8): editor/backup copies are byte-identical secrets — must stay denied.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env~' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .envrc.bak' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .envrc~' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env.production.bak' },
  // --- pass-12 (audit 9): .env match is case-insensitive (parity with *.pem/*.key).
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .ENV' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .Env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .ENV.LOCAL' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .ENVIRONMENT' }, // not a secret; must stay allowed
  // --- pass-13 (audit 10): credentials that live outside the repo, on the developer machine.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.ssh/id_rsa' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.ssh/id_ed25519' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat id_ecdsa.bak' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head -c 100 /home/x/.ssh/id_dsa' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.aws/credentials' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat $HOME/.aws/credentials' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.config/gh/hosts.yml' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.git-credentials' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.kube/config' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.docker/config.json' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.pgpass' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep token < ~/.config/gh/hosts.yml' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat ~/.ssh/id_rsa.pub' }, //    the public half
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat ~/.ssh/config' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat credentials.md' }, //       no .aws parent
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat config' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat docs/config.json' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat hosts.yml' },
  // mise as a wrapper: `mise x tool@ver -- cmd` and `mise exec -- cmd` resolve to cmd.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise x node@24 -- npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise exec node@24 npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise x -- yarn add x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'mise exec -- cat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'mise x pnpm@12 -- pnpm approve-builds' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'mise x pnpm@12.3.4 -- pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'mise install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'mise run build' },
  // --- audit round 2: quoted multi-word messages, mise value flags, changelogen spellings,
  // URL/path remotes, quoted Windows paths.
  { guard: B, expect: D, cmd: 'git commit -m "fix the build" --no-verify' }, // -m once swallowed the flag
  { guard: B, expect: D, cmd: 'git commit -m \'two words\' -n' },
  { guard: B, expect: D, cmd: 'git commit -F "my notes.txt" --no-verify' },
  { guard: B, expect: D, cmd: 'git commit -a -m "a b" --no-verify' },
  { guard: B, expect: A, cmd: 'git commit -m "two words"' },
  { guard: B, expect: A, cmd: 'git commit -m "fix the build" -s' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise x -C /tmp -- npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise exec --cd /tmp node@24 npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'mise x -E prod -- cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'mise x -C /tmp -- pnpm install' },
  { guard: P, expect: D, cmd: 'npx -y changelogen --push' },
  { guard: P, expect: D, cmd: 'npx --yes changelogen --release --push' },
  { guard: P, expect: D, cmd: 'pnpm dlx changelogen@latest --push' },
  { guard: P, expect: D, cmd: 'npx changelogen@0.6.2 --release --push' },
  { guard: P, expect: A, cmd: 'npx -y changelogen' },
  { guard: P, expect: D, cmd: 'git push https://example.com/x.git HEAD:tmp' },
  { guard: P, expect: D, cmd: 'git push git@example.com:x/y.git main:keep' },
  { guard: P, expect: D, cmd: 'git push ../other-repo feat/x' },
  { guard: P, expect: A, cmd: 'git push upstream feat/x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\repo\\.env\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat "C:\\repo\\.env"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'secrets\\token\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\Users\\me\\.ssh\\id_rsa\'' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'echo "a\\nb"' },

  // --- deny-push-protected: no pushes to protected branches (default: main) ----
  // Explicit targets. The REMOTE side of a refspec is what lands on the branch.
  { guard: P, expect: D, cmd: 'git push origin main' },
  { guard: P, expect: D, cmd: 'git push -u origin main' },
  { guard: P, expect: D, cmd: 'git push origin HEAD:main' },
  { guard: P, expect: D, cmd: 'git push origin feat/x:main' },
  { guard: P, expect: D, cmd: 'git push origin refs/heads/main' },
  { guard: P, expect: D, cmd: 'git push origin feat/x:refs/heads/main' },
  { guard: P, expect: D, cmd: 'git push origin main feat/x' }, // one protected target is enough
  { guard: P, expect: D, cmd: 'git push origin :main' }, //       delete via empty source
  { guard: P, expect: D, cmd: 'git push origin --delete main' },
  { guard: P, expect: D, cmd: 'git push -d origin main' },
  { guard: P, expect: D, cmd: 'git push --force-with-lease origin main' }, // lease never unlocks a protected branch
  { guard: P, expect: D, cmd: 'git -C . push origin main' }, //         git global options before the subcommand
  { guard: P, expect: D, cmd: 'git -c push.default=simple push origin main' },
  { guard: P, expect: D, cmd: 'git push -o ci.skip origin main' }, //    push value-option before the remote
  { guard: P, expect: D, cmd: 'cd x && git push origin main' }, //      every segment is checked
  { guard: P, expect: D, cmd: 'sudo git push origin main' },
  { guard: P, expect: D, cmd: 'pnpm exec git push origin main' },
  { guard: P, expect: D, cmd: 'git push "origin" "main"' },
  { guard: P, expect: A, cmd: 'git push origin feat/x' },
  { guard: P, expect: A, cmd: 'git push -u origin feat/x' },
  { guard: P, expect: A, cmd: 'git push origin feat/x:feat/y' },
  { guard: P, expect: A, cmd: 'git push origin main:feat/x' }, //       source main is fine; target is not protected
  { guard: P, expect: A, cmd: 'git push --force-with-lease origin feat/x' },
  { guard: P, expect: A, cmd: 'git push --force-with-lease=feat/x:abc origin feat/x' },
  { guard: P, expect: A, cmd: 'git push --force-if-includes --force-with-lease origin feat/x' },
  { guard: P, expect: A, cmd: 'git push origin --delete feat/x' },
  { guard: P, expect: A, cmd: 'git push origin :feat/x' },
  { guard: P, expect: A, cmd: 'git push origin v1.0.0' }, //            a tag ref, not a protected branch
  { guard: P, expect: A, cmd: 'git push origin --tags' }, //            tags only, no branch push
  { guard: P, expect: A, cmd: 'git push --tags origin' },
  { guard: P, expect: A, cmd: 'git push origin refs/tags/v1.0.0' },
  { guard: P, expect: A, cmd: 'git push -o ci.skip origin feat/x' },
  { guard: P, expect: A, cmd: 'git pull origin main' }, //              not a push
  { guard: P, expect: A, cmd: 'git fetch origin main' },
  { guard: P, expect: A, cmd: 'git commit -m "push to main"' }, //     a quoted mention
  { guard: P, expect: A, cmd: 'git log origin/main..HEAD' },
  { guard: P, expect: A, cmd: 'echo git push origin main' }, //         head is echo, not git
  { guard: P, expect: A, cmd: 'command -v git push origin main' }, //   presence probe
  // Always denied regardless of target: whole-repo pushes and bare force.
  { guard: P, expect: D, cmd: 'git push --all' },
  { guard: P, expect: D, cmd: 'git push origin --all' },
  { guard: P, expect: D, cmd: 'git push --branches origin' },
  { guard: P, expect: D, cmd: 'git push --mirror origin' },
  { guard: P, expect: D, cmd: 'git push --force origin feat/x' },
  { guard: P, expect: D, cmd: 'git push -f origin feat/x' },
  { guard: P, expect: D, cmd: 'git push -fu origin feat/x' }, //       clustered short flags
  { guard: P, expect: D, cmd: 'git push origin +feat/x' }, //         refspec `+` is a force push
  { guard: P, expect: D, cmd: 'git push origin +feat/x:feat/x' },
  // Implicit targets resolve through the CURRENT branch of the cwd.
  { guard: P, expect: D, cmd: 'git push', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push -u origin HEAD', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin HEAD:feat/x main', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push -u origin HEAD', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin HEAD:feat/y', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin --tags', cwd: ON_MAIN }, // tags only: no branch target to resolve
  // A wildcard refspec can match a protected branch; the guard cannot evaluate it, so deny.
  { guard: P, expect: D, cmd: 'git push origin \'refs/heads/*:refs/heads/*\'', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin \'refs/heads/*\'', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin \'feat/*:feat/*\'', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin feat/star', cwd: ON_FEAT }, // no glob, no protected target
  // --recurse-submodules takes only the =value spelling; the bare word must not eat the remote.
  { guard: P, expect: D, cmd: 'git push --recurse-submodules origin main', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push --recurse-submodules=check origin feat/x', cwd: ON_FEAT },
  // Unresolvable target fails closed: detached HEAD, or no checkout at all.
  { guard: P, expect: D, cmd: 'git push', cwd: DETACHED },
  { guard: P, expect: D, cmd: 'git push origin HEAD', cwd: DETACHED },
  { guard: P, expect: D, cmd: 'git push', cwd: tmp },
  // PROTECTED_BRANCHES overrides the default: comma-separated globs, full match.
  { guard: P, expect: D, cmd: 'git push origin release/1.x', env: { PROTECTED_BRANCHES: 'main,release/*' } },
  { guard: P, expect: D, cmd: 'git push origin main', env: { PROTECTED_BRANCHES: 'main, release/*' } },
  { guard: P, expect: A, cmd: 'git push origin release-notes', env: { PROTECTED_BRANCHES: 'main,release/*' } },
  { guard: P, expect: A, cmd: 'git push origin main', env: { PROTECTED_BRANCHES: 'develop' } },
  { guard: P, expect: D, cmd: 'git push origin develop', env: { PROTECTED_BRANCHES: 'develop' } },
  { guard: P, expect: A, cmd: 'git push origin maintenance', env: { PROTECTED_BRANCHES: 'main' } }, // full match, not prefix
  { guard: P, expect: D, cmd: 'git push origin main', env: { PROTECTED_BRANCHES: '' } }, //  empty means default
  // No env var at all: the list comes from .claude/settings.json next to the hooks.
  { guard: P, expect: D, cmd: 'git push origin release/1.x', unset: ['PROTECTED_BRANCHES'], hooksDir: SETTINGS_HOOKS },
  { guard: P, expect: A, cmd: 'git push origin main', unset: ['PROTECTED_BRANCHES'], hooksDir: SETTINGS_HOOKS },
  { guard: P, expect: D, cmd: 'git push origin main', unset: ['PROTECTED_BRANCHES'] }, // the real settings.json protects main
  // The release script pushes from inside changelogen; a `git push` rule never sees it.
  { guard: P, expect: D, cmd: 'pnpm release' },
  { guard: P, expect: D, cmd: 'pnpm run release' },
  { guard: P, expect: D, cmd: 'pnpm release --minor' },
  { guard: P, expect: D, cmd: 'pnpm --filter x release' },
  { guard: P, expect: D, cmd: 'pnpm exec changelogen --release --push' },
  { guard: P, expect: D, cmd: 'pnpm dlx changelogen --push' },
  { guard: P, expect: D, cmd: 'npx changelogen --release --push' },
  { guard: P, expect: D, cmd: 'changelogen --release --push --no-github' },
  { guard: P, expect: A, cmd: 'pnpm exec changelogen' }, //             preview, no push
  { guard: P, expect: A, cmd: 'pnpm exec changelogen --release' }, //   local bump + tag, no push
  { guard: P, expect: A, cmd: 'pnpm build' },
  { guard: P, expect: A, cmd: 'git commit -m "chore: release notes"' },
  { guard: P, expect: A, cmd: 'git commit -m "changelogen --push"' }, // a quoted mention

  // --- deny-hook-bypass: fix the failing hook, never skip it ----------------------
  { guard: B, expect: D, cmd: 'git commit --no-verify -m "x"' },
  { guard: B, expect: D, cmd: 'git commit -m "x" --no-verify' },
  { guard: B, expect: D, cmd: 'git commit --no-veri -m x' }, // git accepts the unique abbreviation
  { guard: B, expect: D, cmd: 'git commit -n -m x' },
  { guard: B, expect: D, cmd: 'git commit -anm x' },
  { guard: B, expect: D, cmd: 'git push --no-verify origin feat/x' },
  { guard: B, expect: D, cmd: 'git merge --no-verify feat/x' },
  { guard: B, expect: D, cmd: 'git -c core.hooksPath=/dev/null commit -m x' },
  { guard: B, expect: D, cmd: 'git -C . -c core.hookspath=/tmp commit -m x' },
  { guard: B, expect: D, cmd: 'SKIP_SIMPLE_GIT_HOOKS=1 git commit -m x' },
  { guard: B, expect: D, cmd: 'env SKIP_SIMPLE_GIT_HOOKS=1 git commit -m x' },
  { guard: B, expect: D, cmd: 'HUSKY=0 git push origin feat/x' },
  { guard: B, expect: D, cmd: 'export SKIP_SIMPLE_GIT_HOOKS=1; git commit -m x' },
  { guard: B, expect: D, cmd: 'pnpm build && git commit --no-verify -m x' },
  { guard: B, expect: A, cmd: 'git commit -m x' },
  { guard: B, expect: A, cmd: 'git commit -am "fix: no --no-verify here"' }, // quoted mention
  { guard: B, expect: A, cmd: 'git commit -m "use -n carefully"' },
  { guard: B, expect: A, cmd: 'git push -n origin feat/x' }, // push -n is --dry-run
  { guard: B, expect: A, cmd: 'git log -n 5' },
  { guard: B, expect: A, cmd: 'git commit --no-edit' },
  { guard: B, expect: A, cmd: 'git commit --no-status -m x' },
  { guard: B, expect: A, cmd: 'git -c user.name=t commit -m x' },
  { guard: B, expect: A, cmd: 'HUSKY=1 git commit -m x' },
  // A quote closed mid-token defeats the span heuristic; the guard then scans every token.
  { guard: B, expect: D, cmd: 'git commit -m "fix: x "y --no-verify' },
  { guard: B, expect: D, cmd: 'git commit -m "unterminated --no-verify' },
  { guard: B, expect: D, cmd: 'git commit -m "oops -n' },
  { guard: B, expect: A, cmd: 'git commit -m "unterminated message' },
  { guard: B, expect: A, cmd: 'git commit -m "it\'s fine"' },
  { guard: B, expect: A, cmd: 'git commit -m "say \'hi\' -n"' },

  // --- dispatch: the registered hook fans out to every guard --------------------
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install' },
  { guard: 'dispatch.mts', expect: D, cmd: 'pnpm approve-builds' },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git commit --no-verify -m x' },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install && git push origin feat/x' },
  // Same dispatcher, Codex-shaped and Gemini-shaped payloads.
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin main', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install', tool: 'run_shell_command', extra: GEMINI },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env', tool: 'run_shell_command', extra: GEMINI },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install', tool: 'run_shell_command', extra: GEMINI },

  // --- fail closed: unparseable or shapeless hook input is denied, never allowed ----
  { guard: 'dispatch.mts', expect: D, cmd: '<raw: empty>', raw: '' },
  { guard: 'dispatch.mts', expect: D, cmd: '<raw: truncated>', raw: '{' },
  { guard: 'dispatch.mts', expect: D, cmd: '<raw: null tool_input>', raw: '{"tool_input":null}' },
  { guard: 'dispatch.mts', expect: D, cmd: '<raw: no tool_input>', raw: '{"tool_name":"Bash"}' },
  { guard: 'dispatch.mts', expect: D, cmd: '<raw: command not a string>', raw: '{"tool_input":{"command":["npm","i"]}}' },
  { guard: 'dispatch.mts', expect: A, cmd: '<raw: empty command>', raw: '{"tool_input":{"command":""}}' }, // a string, nothing to run
]

// Direct lexer pins: WRAP / WRAP_VALUE_FLAGS / POSITIONAL_MODE / wouldHideHead / leadIndex all
// resolve through resolveHead(), so a table change shows up here before it shows up as a bypass.
interface LexerCase { cmd: string, head: string, probe?: boolean }
const LEXER_CASES: LexerCase[] = [
  { cmd: 'npm install', head: 'npm' },
  { cmd: '', head: '' },
  { cmd: 'echo npm i', head: 'echo' },
  { cmd: 'pnpm -C dir exec npm i', head: 'npm' }, //         PNPM_VALUE_FLAG then exec unwrap
  { cmd: 'pnpm exec pnpm exec npm i', head: 'npm' }, //      nested unwrap
  { cmd: 'pnpm run build', head: 'pnpm' }, //                no unwrap without exec/dlx/x
  { cmd: 'xargs -I{} npm i', head: 'npm' }, //               glued value flag stays a flag
  { cmd: 'xargs -I {} npm i', head: 'npm' }, //              separate value consumed
  { cmd: 'VAR=a VAR=b npm i', head: 'npm' },
  { cmd: '2>&1 npm i', head: 'npm' }, //                     digit-prefixed redirect token
  { cmd: 'npm</dev/null install', head: 'npm' }, //          glued redirect peeled
  { cmd: 'timeout -k 5 5 npm i', head: 'npm' }, //           value flag + mandatory positional
  { cmd: 'timeout npm i', head: 'npm' }, //                  wouldHideHead refuses the positional
  { cmd: 'sudo -n npm i', head: 'npm' }, //                  boolean for sudo
  { cmd: 'nice -n 10 npm i', head: 'npm' }, //               value-taking for nice
  { cmd: 'nice -n 10 pnpm i', head: 'pnpm' },
  { cmd: 'taskset 0x1 npm i', head: 'npm' }, //              unless-value: bare mask
  { cmd: 'taskset -c 0-3 npm i', head: 'npm' }, //           unless-value: flag form
  { cmd: 'flock -w 5 /tmp/l npm i', head: 'npm' },
  { cmd: '/usr/bin/env npm i', head: 'npm' }, //             base()-normalised wrapper
  { cmd: 'stdbuf -oL npm install', head: 'npm' },
  { cmd: '{ npm i', head: 'npm' },
  { cmd: 'command -v npm', head: 'npm', probe: true },
  { cmd: 'if command -v npm', head: 'npm', probe: true },
  { cmd: 'mise x node@24 -- npm i', head: 'npm' }, //           tool spec, then the separator
  { cmd: 'mise x pnpm@12.3.4 -- pnpm install', head: 'pnpm' },
  { cmd: 'mise exec node@24 npm i', head: 'npm' }, //           no separator
  { cmd: 'mise x -- cat .env', head: 'cat' },
  { cmd: 'mise x --quiet node@24 -- npm i', head: 'npm' },
  { cmd: 'mise run build', head: 'mise' }, //                   not a wrapper subcommand
  { cmd: 'mise install', head: 'mise' },
  { cmd: 'mise x -C /tmp -- npm i', head: 'npm' }, //           value flag consumed
  { cmd: 'mise x --cd /tmp node@24 npm i', head: 'npm' },
  { cmd: 'mise exec -E prod -j 4 -- npm i', head: 'npm' },
  { cmd: 'mise x -C npm -- pnpm i', head: 'npm' }, //           a value that is a banned head is not consumed
  { cmd: 'cat \'C:\\repo\\.env\'', head: 'cat' },
]

// The session-start hook prints the writing rules as SessionStart context for Codex and
// Gemini. It never reads the payload, never blocks, and never exits non-zero; the style body
// arrives without frontmatter or CR, and stays short (Codex caps injected context near
// 2,500 tokens). SENTINEL is the file's last line, so prose edits do not break the suite.
const SESSION = 'session-start.mts'
const STYLE_TEXT = readFileSync(join(HOOKS, '..', 'output-styles', 'writing.md'), 'utf8')
const SENTINEL = STYLE_TEXT.trim().split('\n').at(-1)!.trim()
const NOSTYLE_CLAUDE = join(tmp, 'nostyle-claude')
cpSync(join(HOOKS, '..'), NOSTYLE_CLAUDE, { recursive: true })
rmSync(join(NOSTYLE_CLAUDE, 'output-styles', 'writing.md'))
const CRLF_CLAUDE = join(tmp, 'crlf-claude')
cpSync(join(HOOKS, '..'), CRLF_CLAUDE, { recursive: true })
writeFileSync(join(CRLF_CLAUDE, 'output-styles', 'writing.md'), STYLE_TEXT.replace(/\r?\n/g, '\r\n'))

interface SessionCase { name: string, raw: string, hooksDir?: string, context: boolean }
const SESSION_CASES: SessionCase[] = [
  { name: 'claude startup', raw: '{"hook_event_name":"SessionStart","source":"startup"}', context: true },
  { name: 'codex resume', raw: JSON.stringify({ ...CODEX, hook_event_name: 'SessionStart', source: 'resume' }), context: true },
  { name: 'gemini clear', raw: JSON.stringify({ ...GEMINI, hook_event_name: 'SessionStart', source: 'clear' }), context: true },
  { name: 'empty stdin', raw: '', context: true },
  { name: 'truncated json', raw: '{', context: true },
  { name: 'pre-tool shape', raw: '{"tool_input":null}', context: true },
  { name: 'style file missing', raw: '{"hook_event_name":"SessionStart"}', hooksDir: join(NOSTYLE_CLAUDE, 'hooks'), context: false },
  { name: 'crlf style file', raw: '{"hook_event_name":"SessionStart"}', hooksDir: join(CRLF_CLAUDE, 'hooks'), context: true },
]

interface SessionOutput { hookSpecificOutput?: { hookEventName?: string, additionalContext?: string } }
/** Problems with one session-hook run, empty when it printed the expected context (or none). */
function sessionProblems(c: SessionCase, status: number | null, stdout: string, stderr: string): string[] {
  if (status !== 0)
    return [`exit ${status ?? 'null'}, want 0`]
  if (!c.context) {
    const out: string[] = []
    if (stdout.trim() !== '')
      out.push('stdout should be empty without a style file')
    if (!stderr.includes('writing.md'))
      out.push('stderr should name writing.md')
    return out
  }
  let parsed: SessionOutput
  try {
    parsed = JSON.parse(stdout) as SessionOutput
  }
  catch {
    return [`stdout is not JSON: ${stdout.slice(0, 80)}`]
  }
  const out: string[] = []
  const ctx = parsed.hookSpecificOutput?.additionalContext
  if (parsed.hookSpecificOutput?.hookEventName !== 'SessionStart')
    out.push('hookEventName should be SessionStart')
  if (typeof ctx !== 'string')
    return [...out, 'additionalContext missing']
  if (!ctx.includes(SENTINEL))
    out.push('context should end with the style body')
  if (ctx.startsWith('---') || ctx.includes('keep-coding-instructions'))
    out.push('context should not carry the frontmatter')
  if (ctx.includes('\r'))
    out.push('context should not carry CR')
  if (ctx.length > 4000)
    out.push(`context is ${ctx.length} chars; keep the writing rules under 4000`)
  if (stderr !== '')
    out.push(`unexpected stderr: ${stderr.slice(0, 80)}`)
  return out
}

const fails: string[] = []
for (const c of SESSION_CASES) {
  const r = spawnSync(process.execPath, [join(c.hooksDir ?? HOOKS, SESSION)], { input: c.raw, encoding: 'utf8' })
  for (const p of sessionProblems(c, r.status, r.stdout, r.stderr))
    fails.push(`[${SESSION}] ${c.name}: ${p}`)
}
for (const c of LEXER_CASES) {
  const got = resolveHead(tokenize(c.cmd))
  if (got.head !== c.head || got.probe !== (c.probe ?? false))
    fails.push(`[lexer] ${JSON.stringify(c.cmd)}: head=${got.head} probe=${got.probe}, want head=${c.head} probe=${c.probe ?? false}`)
}
for (const c of CASES) {
  const env: Record<string, string | undefined> = { ...process.env, ...c.env }
  for (const name of c.unset ?? [])
    delete env[name]
  if (c.guard === 'dispatch.mts') {
    const json = c.raw ?? JSON.stringify({ ...c.extra, tool_name: c.tool ?? 'Bash', tool_input: { command: c.cmd } })
    const r = spawnSync(process.execPath, [join(c.hooksDir ?? HOOKS, c.guard)], { input: json, cwd: c.cwd ?? process.cwd(), env })
    if (r.status !== c.expect)
      fails.push(`[${c.guard}] got ${r.status ?? 'null'}, want ${c.expect}: ${c.cmd}`)
    continue
  }
  const ctx: GuardContext = { cwd: c.cwd ?? process.cwd(), env, settingsFile: join(c.hooksDir ?? HOOKS, '..', 'settings.json') }
  const why = VERDICTS[c.guard](c.cmd, ctx)
  const got = why === null ? A : D
  if (got !== c.expect)
    fails.push(`[${c.guard}] got ${got}${why ? ` (${why})` : ''}, want ${c.expect}: ${c.cmd}`)
}

// A harness that opens stdin and never closes it must not hang the tool call: the dispatcher
// denies after its timeout, the session hook still prints its context and exits 0. Async on
// purpose — spawnSync would close the child's stdin. Both start before either is awaited, so
// the suite waits once for the 5s backstop, not twice.
const hung = spawn(process.execPath, [join(HOOKS, 'dispatch.mts')], { stdio: ['pipe', 'ignore', 'ignore'] })
const hungSession = spawn(process.execPath, [join(HOOKS, SESSION)], { stdio: ['pipe', 'pipe', 'ignore'] })
let hungSessionOut = ''
hungSession.stdout.on('data', (d) => {
  hungSessionOut += d
})
const [hungStatus, hungSessionStatus] = await Promise.all([
  new Promise<number | null>(resolve => hung.on('exit', resolve)),
  new Promise<number | null>(resolve => hungSession.on('close', resolve)),
])
if (hungStatus !== 2)
  fails.push(`[dispatch.mts] stdin never closed: got ${hungStatus ?? 'null'}, want 2 (timeout deny)`)
for (const p of sessionProblems({ name: 'stdin never closed', raw: '', context: true }, hungSessionStatus, hungSessionOut, ''))
  fails.push(`[${SESSION}] stdin never closed: ${p}`)

if (fails.length > 0) {
  console.error(`\n✖ hook fixtures — ${fails.length} of ${CASES.length + LEXER_CASES.length + SESSION_CASES.length + 2} failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ hook fixtures — ${CASES.length} guard cases + ${LEXER_CASES.length} lexer cases + ${SESSION_CASES.length} session cases + both stdin timeouts pass`)
