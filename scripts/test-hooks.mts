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
import { resolveHead, segments, tokenize } from '../.claude/hooks/_lexer.mts'
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
// A child may protect another branch than main (guards.md, Push protection), and Claude Code
// exports that list into this process. So every case runs with PROTECTED_BRANCHES=main unless
// it sets or unsets the variable, and the one case that reads the real settings.json pushes to
// the first branch that file protects (a `*` filled in; `main` when it sets none).
const realList = (JSON.parse(readFileSync(join(HOOKS, '..', 'settings.json'), 'utf8')) as { env?: { PROTECTED_BRANCHES?: unknown } }).env?.PROTECTED_BRANCHES
const REAL_PROTECTED = (typeof realList === 'string' ? realList : '').split(',').map(p => p.trim()).find(Boolean)?.replace(/\*/g, 'x') ?? 'main'
const B = 'deny-hook-bypass.mts'

// Codex and Gemini CLI register the same dispatcher. Their payloads carry other
// top-level fields and, for Gemini, another tool name; the guards read only
// tool_input.command, so these shapes must deny and allow exactly like Claude Code.
const CODEX = { cwd: process.cwd(), hook_event_name: 'PreToolUse', model: 'x', permission_mode: 'default', session_id: 's', tool_use_id: 't', transcript_path: null, turn_id: 'u' }
const GEMINI = { cwd: process.cwd(), hook_event_name: 'BeforeTool', session_id: 's', timestamp: '2026-01-01T00:00:00Z', transcript_path: '/tmp/t.json' }
// Claude Code's Monitor tool runs a shell command under the Bash permission rules, or opens a
// WebSocket (`ws`, never combined with `command`), which runs no shell and has nothing to judge.
function monitor(input: Record<string, unknown>, tool = 'Monitor'): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { description: 'd', timeout_ms: 300000, ...input } })
}

const CASES: Case[] = [
  // --- deny-non-pnpm: this repo is pnpm-only ---------------------------------
  // Windows launchers, any case, and a corepack or dlx version name the same program.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm.cmd install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'NPM install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'yarn.cmd add foo' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bun.exe install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm.ps1 install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '\'C:\\nodejs\\npm.cmd\' install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'corepack yarn@1 add foo' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm dlx npm@10 install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm.cmd approve-builds' },
  { guard: P, expect: D, cmd: 'git.exe push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'CAT .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'busybox cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm.cmd install' },
  { guard: P, expect: A, cmd: 'git.exe push origin feat/x' },
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
  // A flag on a dlx line, the settings behind the flags, and an exported pnpm_config variable.
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm dlx --allow-build=esbuild create-vite' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm dlx --allow-build esbuild create-vite@latest my-app' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm --allow-build=esbuild dlx create-vite' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm config set --location project allowBuilds \'{"esbuild":true}\' --json' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm config set onlyBuiltDependencies esbuild' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'export pnpm_config_dangerously_allow_all_builds=true; pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'export CI=1 PNPM_CONFIG_ALLOW_BUILDS=esbuild' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'declare -x pnpm_config_dangerously_allow_all_builds=true' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm dlx create-vite my-app --template vanilla-ts' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm config set store-dir ~/.pnpm-store' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'export CI=1; pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'grep -n allowBuilds pnpm-workspace.yaml' },

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
  // `@` is HEAD, `heads/main` is main, and git takes a unique prefix of a long option.
  { guard: P, expect: D, cmd: 'git push origin @', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push -u origin @', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin @:main', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin heads/main', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin feat/x:heads/main', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin HEAD:heads/main', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --al origin', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --mirr origin', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --m origin', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --branch origin', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --del origin main', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin @', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push -u origin @', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin heads/feat/x', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push --force-w origin feat/x', cwd: ON_FEAT }, //   --force-with-lease
  { guard: P, expect: A, cmd: 'git push --del origin feat/x', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push --ta origin', cwd: ON_MAIN }, //                 --tags
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
  { guard: P, expect: D, cmd: `git push origin ${REAL_PROTECTED}`, unset: ['PROTECTED_BRANCHES'] }, // the real settings.json
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
  { guard: B, expect: D, cmd: 'export CI=1 SKIP_SIMPLE_GIT_HOOKS=1; git commit -m x' },
  { guard: B, expect: D, cmd: 'declare -x SKIP_SIMPLE_GIT_HOOKS=1; git commit -m x' },
  { guard: B, expect: D, cmd: 'typeset -gx HUSKY=0; git push origin feat/x' },
  { guard: B, expect: A, cmd: 'declare SKIP_SIMPLE_GIT_HOOKS=1; git commit -m x' }, // not exported: git never sees it
  { guard: B, expect: A, cmd: 'export CI=1; git commit -m x' },
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

  // --- lexer: substitution inside double quotes runs a command, as bash runs it ------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'V="$(npm view react version)"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'echo "$(cat .env)"' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'x="$(pnpm approve-builds)"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'git commit -m "docs: never run `npm install`"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'TOKEN="$(cat ~/.npmrc)"' },
  { guard: P, expect: D, cmd: 'echo "$(git push origin main)"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'curl -s -H "Authorization: Bearer $(grep API_TOKEN .env | cut -d= -f2)" https://api.example.com/me' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo "$(echo "$(npm install)")"' }, // nested quotes inside the substitution
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'echo "`cat .env`"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo "a; npm install | b"' }, //   ; and | stay literal in quotes
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'git commit -m \'docs: never run `npm install`\'' }, // single quotes run nothing
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo "\\$(npm install) \\`npm i\\`"' }, // escaped, so literal
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'V="$(pnpm view react version)"' },
  // A target that is only a substitution names the current branch; one inside a name is unknown.
  { guard: P, expect: D, cmd: 'git push -u origin "$(git branch --show-current)"', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin $(git rev-parse --abbrev-ref HEAD)', cwd: ON_MAIN },
  { guard: P, expect: A, cmd: 'git push -u origin "$(git branch --show-current)"', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin HEAD:"$(git branch --show-current)"', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin "feat/$(date +%s)"', cwd: ON_FEAT },

  // --- lexer: a `#` comment and a heredoc body are data, so their quotes open nothing -------
  { guard: P, expect: D, cmd: '# Make sure we\'re up to date first\ngit push origin main' },
  { guard: P, expect: D, cmd: '# Check that it\'s clean\ngit status\ngit push', cwd: ON_MAIN },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '# Install the project\'s deps\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo hi # it\'s fine\nnpm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat > notes.md <<\'EOF\'\nIt\'s done.\nEOF\ncat .env' },
  { guard: P, expect: D, cmd: 'git commit -m "$(cat <<\'EOF\'\nfix: handle 12" displays\nEOF\n)" && git push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<-EOF\n\tIt\'s\n\tEOF\nnpm install' }, //  <<- drops the tabs
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<"EOF"\nIt\'s\nEOF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\\EOF\nIt\'s\nEOF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat << EOF\nIt\'s\nEOF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<A <<\'B\'\nIt\'s\nA\nIt\'s\nB\nnpm install' }, // two bodies, in order
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<< EOF\nnpm install\nEOF' }, //       a here-string, not a heredoc
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $((1<<2))\nnpm install\n2' }, //       a shift, not a heredoc
  // `#` opens a comment only at the start of a word.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a#b; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${#x}; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $#; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo hi # ; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo hi\t# ; npm install' }, //  a tab is a blank too
  // Only a space or a tab ends a word; bash reads a `#` after any other space-like byte as text.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a\u00A0#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a\u2003#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a\r#x; npm install' },
  { guard: P, expect: D, cmd: 'echo a\f#x; git push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'echo a\v#x; cat .env' },
  { guard: P, expect: A, cmd: 'git push origin feat/x # dont push main' },
  // A `(` inside `[[ … ]]` or glued to a word (an extglob) groups text, so a `#` after it is text.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'while read -r p; do [[ $p =~ ^(#|$) ]] && continue; npm install "$p"; done < deps.txt' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'while IFS= read -r l; do [[ $l =~ ^[[:space:]]*(#|$) ]] && continue; npm install "$l"; done < f' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ "#" =~ (#|a) ]] && npm install' },
  { guard: P, expect: D, cmd: '[[ "#" =~ (#|a) ]] && git push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '[[ "#" =~ (#|a) ]] && cat .env' },
  { guard: B, expect: D, cmd: '[[ "#" =~ (#|a) ]] && git commit --no-verify -m x' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: '[[ "#" =~ (#|a) ]] && pnpm approve-builds' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ "a" == @(#|a) ]] && npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ a &&\n (#) ]] && npm install' }, //   `[[` spans the newline
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ -n <(npm install) ]]' }, //         a process substitution still runs
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'if(npm install) then :; fi' }, //     a reserved word, then a subshell
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{(npm install)}' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a # it\'s b\n); npm install' }, //  an array's `#` is a comment
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo [[ # ; npm install' }, //         `[[` as an argument opens nothing
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '[[ $l =~ ^(npm|yarn) ]] && echo legacy' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '[[ $f == @(*.ts|*.mts) ]] && pnpm exec eslint "$f"' },
  // A body a shell reads is commands; an unquoted delimiter still runs the body's substitutions.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sh <<EOF\ncat .env\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\' | bash\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF > notes.md\n$(npm install)\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF\nrun `npm install` first\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'cat <<EOF\nrun \\`npm install\\` first, it\'s $HOME\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'source .venv/bin/activate && cat > notes.md <<\'EOF\'\nnpm install\nEOF' }, // the shell is not in its pipeline
  // A pipeline that continues after a line ending in `|`, or a group piped on, reaches a shell
  // after the body; a launcher with no command starts one that reads it.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF |\nnpm install\nEOF\nbash' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\' | # to a shell\nnpm install\nEOF\nbash' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{ cat <<EOF\nnpm install\nEOF\n} | bash' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '( cat <<EOF\nnpm install\nEOF\n) | bash' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{ cat <<EOF; } | bash\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo "$(cat <<\'EOF\'\nnpm install\nEOF\n)" | bash' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash <<< "$(cat <<\'EOF\'\nnpm install\nEOF\n)"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -s <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sudo -i <<\'EOF\'\ncat .env\nEOF' },
  { guard: P, expect: D, cmd: 'su <<\'EOF\'\ngit push origin main\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo su <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'doas -s <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'busybox sh <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'ash <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash.exe <<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'cat <<EOF &&\nnpm install\nEOF\nbash' }, //        `&&` ends the pipeline: cat prints it
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'cat > notes.md <<\'EOF\'\nnpm install\nEOF\nbash scripts/x.sh' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '{ cat <<\'EOF\'\nnpm install\nEOF\n} > notes.md; bash x.sh' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'git commit -F - <<\'EOF\' && bash scripts/after.sh\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'sudo tee /etc/app.conf <<\'EOF\'\nnpm install\nEOF' },
  // A substitution a shell runs as its script, or under `-c` or `eval`, reads its heredoc as
  // commands; one handed to a shell script as an argument is data.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash <(cat <<\'EOF\'\nnpm install\nEOF\n)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'source <(cat <<\'EOF\'\nnpm install\nEOF\n)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash -s < <(cat <<\'EOF\'\nnpm install\nEOF\n)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash -o pipefail -c "$(cat <<\'EOF\'\nnpm install\nEOF\n)"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "$(cat <<\'EOF\'\nnpm install\nEOF\n)"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'bash <(echo "$(cat <<\'EOF\'\nnpm install\nEOF\n)")' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'bash x.sh "$(cat <<\'EOF\'\nnpm install\nEOF\n)"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'sh ./pr-body.sh --body "$(cat <<\'EOF\'\n- run `npm install`\nEOF\n)"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'diff <(cat <<\'EOF\'\nnpm install\nEOF\n) b.txt' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'bash <(cat <<\'EOF\'\ncat <<\'X\'\nnpm install\nX\nEOF\n)' }, // the script prints it

  // --- redirections are not arguments: `2>&1` and `> log` never become a refspec ----------
  { guard: P, expect: D, cmd: 'git push origin 2>&1', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin 2>&1 | tail -5', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin 2>/dev/null', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin > /tmp/log', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push > /tmp/log', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin &>/dev/null', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin # to the feature branch', cwd: ON_MAIN },
  { guard: P, expect: A, cmd: 'git push 2>/dev/null', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push >/dev/null 2>&1', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push -u origin feat/x 2>&1 | tail -3', cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '&>/dev/null npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a\\>&npm install' }, // an escaped > is text, so & separates

  // --- deny-secret-reads: a glob that can expand to a secret reads it ---------------------
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head -n 50 .env*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -h API_KEY .env*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head .env?' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .en[v]' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .e*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.ssh/id_*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.ssh/*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.aws/*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.docker/*.json' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/.kube/*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name ".env*" -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep foo *' }, //               a leading * never matches a dotfile
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat src/*.ts */package.json' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat ~/.ssh/*.pub' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .prettierrc*' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep \'[a-z]*\' notes.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'ls .env*' }, //                 lists names, reads nothing
  // Only a glob bash expands can reach a file: a quoted or escaped one is a pattern or a name.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep foo .*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ".env"*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/".ssh"/*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \\.env*' }, //               the escaped dot is still a dot
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep x < .env*' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -rn "import .* from" packages' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -o \'"version": ".*"\' package.json' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'pnpm test 2>&1 | grep -E "FAIL .*"' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -rEn "process\\.env\\.[A-Z_]*" packages' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -o \'id_[a-z0-9]*\' data.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'awk \'/.* failed/ {print $1}\' v.log' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'diff -r -x \'.*\' a b' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat \'.env*\'' }, //              one file literally named `.env*`
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat .env\\*' },
  // find matches a -name or -path pattern itself, quoted or not; a negated or pruned one
  // keeps what it matches out of the walk. The program -exec runs is not judged.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find ~/.ssh -name \'id_*\' -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -iname \'.ENV*\' -exec cat {} \\;' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . ! ! -name \'.env*\' -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name \'.env*\' -prune -exec cat {} +' }, // no -o: the match still runs
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -exec cat .env* \\;' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name \'.env*\' -exec ls -la {} \\;' }, // documented over-block
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -type f -not -path \'*/.*\' -exec grep -l "TODO" {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . ! -path \'*/.*\' -type f -exec wc -l {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -not \\( -path \'*/.*\' \\) -exec grep -l x {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -path \'*/.*\' -prune -o -name \'*.md\' -exec wc -l {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . \\( -path ./node_modules -o -path \'*/.*\' \\) -prune -o -type f -exec grep -l x {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -name \'*.md\' -exec grep -l ".*" {} +' },
  // A test keeps its files out only when nothing else in its branch lets a match fall through.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name \'.env*\' -type d -prune -o -type f -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -type d -name \'.env*\' -prune -o -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . -name \'.env*\' -path \'./a/*\' -prune -o -type f -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find . \\( -name \'.env*\' -o -type f \\) -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'find -L . -maxdepth 2 -name \'.env*\' -type f -exec head {} \\;' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -name \'.env*\' -o -path ./x -prune -o -type f -exec cat {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . \\( -name node_modules -o -name \'.*\' \\) -prune -o -type f -exec grep -l TODO {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -path \'*/.*\' -prune -o -type f -print -exec wc -l {} +' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'find . -name .git -prune -o -type f -exec grep -l TODO {} +' },
  // A glob can also reach a file under a secrets directory or with a key extension.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat secret?/api.txt' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat secrets*/api.txt' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat Secret[s]/api.txt' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat certs/server.pe?' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat certs/server.[p]em' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat certs/*.pe*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'head certs/*.pe?' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat keystore.jk?' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat server.ke?' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat tsconfig.*' }, //          an extension that opens with *
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat docs/*.p?' }, //           no key extension has two letters
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat */package.json scripts/*.mts' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'head -n 20 src/*.[jt]s' },

  // --- the release script's body, run through pnpm or pnpx ----------------------------
  { guard: P, expect: D, cmd: 'pnpm changelogen --release --push --no-github' },
  { guard: P, expect: D, cmd: 'pnpm run changelogen --push' },
  { guard: P, expect: D, cmd: 'pnpx changelogen --push' },
  { guard: P, expect: A, cmd: 'pnpm changelogen --release' },

  // --- dispatch: the registered hook fans out to every guard --------------------
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install' },
  { guard: 'dispatch.mts', expect: D, cmd: 'pnpm approve-builds' },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git commit --no-verify -m x' },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install && git push origin feat/x' },
  // Claude Code's heredoc commit and PR forms: a quoted-delimiter body is data for every guard.
  { guard: 'dispatch.mts', expect: A, cmd: 'git commit -m "$(cat <<\'EOF\'\nfix: never run npm install; it\'s banned\n\ncat .env and git push origin main are denied too\n`pnpm approve-builds` --no-verify\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"' },
  { guard: 'dispatch.mts', expect: A, cmd: 'gh pr create --title "fix: x" --body "$(cat <<\'EOF\'\n## Summary\n- run `npm install` and `cat .env`\n- git push origin main\nEOF\n)"' },
  { guard: 'dispatch.mts', expect: A, cmd: 'cat > notes.md <<\'EOF\'\nnpm install\ncat .env\ngit push origin main\nEOF' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git commit -m "$(cat <<\'EOF\'\nfix: x\nEOF\n)" --no-verify' },
  { guard: 'dispatch.mts', expect: D, cmd: '# Make sure we\'re up to date first\ngit push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin 2>&1 | tail -5', cwd: ON_MAIN },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env*' },
  // Same dispatcher, Codex-shaped and Gemini-shaped payloads.
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin main', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install', tool: 'Bash', extra: CODEX },
  { guard: 'dispatch.mts', expect: D, cmd: 'npm install', tool: 'run_shell_command', extra: GEMINI },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env', tool: 'run_shell_command', extra: GEMINI },
  { guard: 'dispatch.mts', expect: A, cmd: 'pnpm install', tool: 'run_shell_command', extra: GEMINI },
  // Monitor-shaped payloads: a command is judged like Bash; a WebSocket watch passes.
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: npm install>', raw: monitor({ command: 'npm install' }) },
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: cat .env>', raw: monitor({ command: 'tail -f .env' }) },
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: push main>', raw: monitor({ command: 'until git push origin main; do sleep 5; done' }) },
  { guard: 'dispatch.mts', expect: A, cmd: '<monitor: pnpm dev>', raw: monitor({ command: 'pnpm dev 2>&1 | grep --line-buffered -E "ready|error"' }) },
  { guard: 'dispatch.mts', expect: A, cmd: '<monitor: ws>', raw: monitor({ ws: { url: 'wss://events.example.com/stream' } }) },
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: ws with bad command>', raw: monitor({ ws: { url: 'wss://x' }, command: ['npm', 'i'] }) },
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: ws not an object>', raw: monitor({ ws: 'wss://x' }) },
  { guard: 'dispatch.mts', expect: D, cmd: '<monitor: neither>', raw: monitor({}) },
  { guard: 'dispatch.mts', expect: D, cmd: '<bash: ws shape>', raw: monitor({ ws: { url: 'wss://x' } }, 'Bash') }, // only Monitor opens sockets

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
  { cmd: 'npm.cmd install', head: 'npm' }, //                  launcher suffix stripped
  { cmd: '\'C:\\nodejs\\NPM.EXE\' i', head: 'npm' }, //         either separator, any case
  { cmd: 'corepack yarn@1 add x', head: 'yarn' }, //           version suffix stripped
  { cmd: 'busybox sh -s', head: 'sh' }, //                     busybox runs its applet
]

// The session-start hook prints the writing rules as SessionStart context for Codex and
// Gemini. It never reads the payload, never blocks, and never exits non-zero; the style body
// arrives without frontmatter or CR, and stays short (Codex's additionalContextLimit defaults to
// 2,500 tokens, about 10,000 characters; 8,000 leaves headroom). SENTINEL is the file's last line, so prose edits do not break the suite.
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
  if (ctx.length > 8000)
    out.push(`context is ${ctx.length} chars; keep the writing rules under 8000`)
  if (stderr !== '')
    out.push(`unexpected stderr: ${stderr.slice(0, 80)}`)
  return out
}

// The registrations each vendor reads, checked structurally, since no fixture can run the
// tools themselves: Gemini matches lifecycle hooks by exact source string (a regex alternation
// never fires) and tool hooks by regex, and its deprecated tools.allowed turns every unlisted shell
// command into a hard deny, even in YOLO mode; Codex filters SessionStart by source name, and a
// matcher that skips `clear` or `compact` drops the writing rules after /clear or compaction;
// Claude Code's hook matcher must name every tool that runs a shell command (Monitor uses the
// Bash allow rules), its command must use the braced `${CLAUDE_PROJECT_DIR}` that PowerShell
// understands, and its Read deny rules reach the home directory only through `~/` (a `**/` rule
// anchors at the working directory); and a Claude allow rule's trailing `:*` is a
// space-wildcard, so `Bash(pnpm test:*)` never matches a `test:hooks` script — colon scripts are
// listed one by one, and a wildcard before the last word matches nothing at all.
const REPO = join(HOOKS, '..', '..')
interface Registration { matcher?: string, hooks?: { command?: string }[] }
interface Hooks { SessionStart?: Registration[], BeforeTool?: Registration[], PreToolUse?: Registration[] }
const gemini = JSON.parse(readFileSync(join(REPO, '.gemini', 'settings.json'), 'utf8')) as { hooks?: Hooks, tools?: { allowed?: string[] } }
const codex = JSON.parse(readFileSync(join(REPO, '.codex', 'hooks.json'), 'utf8')) as { hooks?: Hooks }
const claude = JSON.parse(readFileSync(join(HOOKS, '..', 'settings.json'), 'utf8')) as { permissions?: { allow?: string[], deny?: string[] }, hooks?: Hooks }
const scriptNames = Object.keys((JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {})
const CODEX_SOURCES: readonly string[] = ['startup', 'resume', 'clear', 'compact']
const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'Monitor']
// The credentials a developer machine holds in the home directory, outside any repository.
const HOME_CREDENTIALS: readonly string[] = ['.ssh/id_*', '.aws/credentials', '.config/gh/hosts.yml', '.git-credentials', '.kube/config', '.docker/config.json', '.pgpass', '.netrc', '_netrc', '.npmrc']
const structural: string[] = []
for (const e of gemini.hooks?.SessionStart ?? []) {
  if (e.matcher !== undefined)
    structural.push(`.gemini/settings.json: SessionStart matcher "${e.matcher}" never fires (exact-string match); omit the matcher`)
}
for (const e of gemini.hooks?.BeforeTool ?? []) {
  if (e.matcher !== 'run_shell_command')
    structural.push(`.gemini/settings.json: BeforeTool matcher "${e.matcher ?? ''}" is not run_shell_command`)
}
if (gemini.tools?.allowed !== undefined)
  structural.push('.gemini/settings.json: tools.allowed is deprecated and denies every shell command it does not list, even in YOLO mode; leave it out')
for (const e of codex.hooks?.SessionStart ?? []) {
  const sources = (e.matcher ?? '').split('|').filter(Boolean)
  for (const source of sources) {
    if (!CODEX_SOURCES.includes(source))
      structural.push(`.codex/hooks.json: SessionStart matcher "${source}" is not a Codex session source`)
  }
  const skipped = CODEX_SOURCES.filter(s => !sources.includes(s))
  if (sources.length > 0 && skipped.length > 0)
    structural.push(`.codex/hooks.json: SessionStart matcher "${e.matcher ?? ''}" skips ${skipped.join(', ')}, so the writing rules vanish there; omit the matcher`)
}
for (const e of codex.hooks?.PreToolUse ?? []) {
  if (e.matcher !== 'Bash')
    structural.push(`.codex/hooks.json: PreToolUse matcher "${e.matcher ?? ''}" is not Bash`)
}
for (const e of claude.hooks?.PreToolUse ?? []) {
  for (const tool of SHELL_TOOLS) {
    if (!(e.matcher ?? '').split('|').includes(tool))
      structural.push(`.claude/settings.json: PreToolUse matcher "${e.matcher ?? ''}" leaves the ${tool} tool unguarded`)
  }
  for (const h of e.hooks ?? []) {
    if ((h.command ?? '').includes('$CLAUDE_PROJECT_DIR'))
      structural.push(`.claude/settings.json: PreToolUse command ${h.command ?? ''} uses the bare $CLAUDE_PROJECT_DIR, which PowerShell resolves to nothing; write \${CLAUDE_PROJECT_DIR}`)
  }
}
for (const name of HOME_CREDENTIALS) {
  if (!(claude.permissions?.deny ?? []).includes(`Read(~/${name})`))
    structural.push(`.claude/settings.json: no Read(~/${name}) deny rule; a **/ rule never reaches the home directory`)
}
for (const rule of claude.permissions?.allow ?? []) {
  const body = /^Bash\((.*)\)$/.exec(rule)?.[1]
  if (body === undefined)
    continue
  const words = body.split(' ')
  if (words.slice(0, -1).some(w => w.includes('*')))
    structural.push(`.claude/settings.json: allow rule ${rule} has a wildcard before its last word and matches nothing`)
  const colon = /^pnpm (\S+):\*$/.exec(body)
  if (colon && scriptNames.some(n => n.startsWith(`${colon[1]}:`)))
    structural.push(`.claude/settings.json: allow rule ${rule} never matches the ${colon[1]}:* scripts (":*" is a space-wildcard); list each script`)
}

const fails: string[] = []
for (const p of structural)
  fails.push(`[registrations] ${p}`)
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
// A run of digits once made tokenize() backtrack quadratically: 100k digits took seconds, past
// the dispatcher's own timeout, and a shell check per heredoc did the same over thousands of
// heredocs. The lexer is a linear scan, so each of these stays far under budget.
const BUDGET: Record<string, string> = {
  '100k digits': `echo ${'1'.repeat(100_000)}`,
  '5000 heredocs on one line': `cat${' <<A'.repeat(5000)}\nA\n`,
  '2500 heredocs in one pipeline': `${'cat <<A |'.repeat(2500)} cat\nA\n`,
  '5000 heredocs after ;': `${'cat <<A;'.repeat(5000)}\nA\n`,
  '2000 substitutions with a heredoc': `bash x.sh "${'$(cat <<A\nA\n)'.repeat(2000)}"`,
  '50k glued parentheses': `echo ${'@('.repeat(50_000)}`,
  '20k conditionals': `${'[[ a ]] && '.repeat(20_000)}true`,
  '5000 heredocs in nested groups': `${'{ cat <<A\nA\n'.repeat(5000)}${'}\n'.repeat(5000)}`,
  '2000 heredocs in nested substitutions': `echo ${'"$(cat <<A\nA\n'.repeat(2000)}${')"'.repeat(2000)} | cat`,
  '5000 heredocs in a continued pipeline': `${'cat <<A |\nA\n'.repeat(5000)}cat`,
}
for (const [name, cmd] of Object.entries(BUDGET)) {
  const started = performance.now()
  for (const seg of segments(cmd))
    resolveHead(tokenize(seg))
  const took = performance.now() - started
  if (took > 500)
    fails.push(`[lexer] ${name} took ${Math.round(took)} ms, want under 500`)
}
for (const c of CASES) {
  const env: Record<string, string | undefined> = { ...process.env, PROTECTED_BRANCHES: 'main', ...c.env }
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

// A dispatcher that cannot start must still deny: every harness blocks only on exit 2 and runs
// the tool call on any other failure. Node told not to strip types fails the way a node too old
// for .mts does, an empty project directory stands in for a missing file, and a PATH without
// node for a missing node. Each registration runs the way its harness runs it: Claude Code hands
// its command to sh, or to PowerShell when Git Bash is missing, after putting the project path
// in for the placeholder; Codex and Gemini run the root script through pnpm from a
// subdirectory, and Gemini parses stdout, so it stays empty. A shell or a pnpm this machine
// lacks is skipped and named in the summary.
interface LaunchCase { name: string, cmd: string, expect: 0 | 2, env?: Record<string, string>, project?: string }
const EMPTY_PROJECT = join(tmp, 'empty-project')
mkdirSync(EMPTY_PROJECT)
const LAUNCH_CASES: LaunchCase[] = [
  { name: 'deny', cmd: 'npm install', expect: D },
  { name: 'allow', cmd: 'pnpm install', expect: A },
  { name: 'node cannot load .mts', cmd: 'pnpm install', expect: D, env: { NODE_OPTIONS: '--no-experimental-strip-types' } },
  { name: 'dispatcher missing', cmd: 'pnpm install', expect: D, project: EMPTY_PROJECT },
]
const PLACEHOLDER = ['$', '{CLAUDE_PROJECT_DIR}'].join('')
const claudeCommands = (claude.hooks?.PreToolUse ?? []).flatMap(e => e.hooks ?? []).map(h => h.command ?? '').filter(c => c.includes('dispatch.mts'))
const payload = (cmd: string): string => JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } })
const runs = (bin: string, args: string[]): boolean => spawnSync(bin, args, { stdio: 'ignore', timeout: 20_000 }).status === 0
const launchSkipped: string[] = []
let launchRuns = 0
function launched(where: string, c: LaunchCase, status: number | null, stdout = ''): void {
  launchRuns++
  if (status !== c.expect)
    fails.push(`[launch] ${where}, ${c.name}: got ${status ?? 'null'}, want ${c.expect}`)
  if (stdout !== '')
    fails.push(`[launch] ${where}, ${c.name}: stdout should be empty, got ${stdout.slice(0, 80)}`)
}
if (claudeCommands.length === 0)
  fails.push('[launch] .claude/settings.json registers no PreToolUse command that runs dispatch.mts')
for (const shell of ['sh', 'pwsh', 'powershell']) {
  const ok = shell === 'sh' ? runs('sh', ['-c', 'exit 0']) : runs(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])
  if (!ok) {
    launchSkipped.push(shell)
    continue
  }
  for (const command of claudeCommands) {
    for (const c of LAUNCH_CASES) {
      const project = c.project ?? REPO
      const env = { ...process.env, PROTECTED_BRANCHES: 'main', ...c.env, CLAUDE_PROJECT_DIR: project }
      const args = shell === 'sh' ? ['-c', command] : ['-NoProfile', '-NonInteractive', '-Command', command.replaceAll(PLACEHOLDER, project)]
      launched(`Claude Code under ${shell}`, c, spawnSync(shell, args, { input: payload(c.cmd), env, timeout: 20_000 }).status)
    }
    if (shell === 'sh' && process.platform !== 'win32') {
      const c: LaunchCase = { name: 'node not installed', cmd: 'pnpm install', expect: D }
      const env = { ...process.env, PATH: EMPTY_PROJECT, CLAUDE_PROJECT_DIR: REPO }
      launched('Claude Code under sh', c, spawnSync('/bin/sh', ['-c', command], { input: payload(c.cmd), env, timeout: 20_000 }).status)
    }
  }
}
if (spawnSync('pnpm --version', { shell: true, stdio: 'ignore', timeout: 20_000 }).status === 0) {
  for (const c of LAUNCH_CASES.filter(l => l.project === undefined)) {
    const env = { ...process.env, PROTECTED_BRANCHES: 'main', ...c.env }
    const r = spawnSync('pnpm -w --silent run guards', { shell: true, cwd: HOOKS, input: payload(c.cmd), env, encoding: 'utf8', timeout: 30_000 })
    launched('Codex and Gemini through pnpm', c, r.status, r.stdout)
  }
}
else {
  launchSkipped.push('pnpm')
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
  console.error(`\n✖ hook fixtures — ${fails.length} of ${CASES.length + LEXER_CASES.length + Object.keys(BUDGET).length + SESSION_CASES.length + launchRuns + 2} failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
const skippedNote = launchSkipped.length > 0 ? ` (${launchSkipped.join(', ')} not installed, skipped)` : ''
console.log(`✔ hook fixtures — ${CASES.length} guard cases + ${LEXER_CASES.length} lexer cases + ${Object.keys(BUDGET).length} lexer time budgets + ${SESSION_CASES.length} session cases + ${launchRuns} launch runs${skippedNote} + both stdin timeouts + the three registrations pass`)
