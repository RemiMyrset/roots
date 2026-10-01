import type { GuardContext, Verdict } from '../.claude/hooks/_lexer.mts'
/**
 * Regression suite for the .claude/hooks agent guards and the session-start hook. Calls each
 * guard's verdict() in-process with a crafted command and context and asserts deny or allow;
 * pipes crafted tool-call JSON to the dispatcher and asserts the exit code (2 = deny, 0 =
 * allow), both directly and through the command each registration holds, run the way its tool
 * runs it, always from a copy of .claude/, which holds the template's guards alone unless a
 * case adds one; pipes session payloads to the session-start hook and asserts the context it
 * prints. Runs in CI via `pnpm test:hooks` so a
 * guard bypass can never ship silently again — every case below is a line an agent might
 * plausibly type. Node builtins only; no deps. Node 24 runs this `.mts` natively.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { resolveHead, segments, tokenize } from '../.claude/hooks/_lexer.mts'
import { verdict as buildScripts } from '../.claude/hooks/deny-build-scripts.mts'
import { verdict as hookBypass } from '../.claude/hooks/deny-hook-bypass.mts'
import { verdict as nonPnpm } from '../.claude/hooks/deny-non-pnpm.mts'
import { verdict as pushProtected } from '../.claude/hooks/deny-push-protected.mts'
import { verdict as secretReads } from '../.claude/hooks/deny-secret-reads.mts'

// A git hook or `git rebase --exec` exports GIT_DIR and its kin, which would aim every git this
// suite starts, the push guard's included, at the repository running it: drop them first.
for (const key of Object.keys(process.env).filter(k => /^GIT_/i.test(k)))
  delete process.env[key]

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
const REPO = join(HOOKS, '..', '..')
const D = 2 // deny
const A = 0 // allow

// Throwaway checkouts for the push guard's implicit-target resolution (`git push`, `HEAD`):
// one on `main`, one on a feature branch, one detached, each with `origin` and `upstream`
// configured, since the guard allows only a remote the cwd configures. Created up front,
// removed at exit.
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
  git('remote', 'add', 'origin', 'https://example.com/origin.git')
  git('remote', 'add', 'upstream', 'https://example.com/upstream.git')
  if (detach) {
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('checkout', '-q', '--detach')
  }
  return dir
}
const ON_MAIN = checkout('on-main', 'main')
const ON_FEAT = checkout('on-feat', 'feat/x')
const DETACHED = checkout('detached', 'main', true)
// A case without a cwd runs on the feature branch, so its verdict never depends on the branch
// or the remotes of the checkout running the suite.
const DEFAULT_CWD = ON_FEAT
const P = 'deny-push-protected.mts'

// Every dispatcher run uses a copy of .claude/ holding only what the fixtures read: hooks/,
// output-styles/, and settings.json, never the skills or a Claude Code worktree under
// .claude/worktrees, which can hold a gigabyte of node_modules. Its hooks/ keeps only the
// template's own guards, the keys of VERDICTS, so a new template guard joins VERDICTS too. A
// child may add a deny-*.mts of its own (sync-template.md), which the dispatcher would load and
// which can deny an allow case written for the template's guards; the child tests it in its own
// suite. Returns `dest`.
function claudeCopy(dest: string, from = join(HOOKS, '..')): string {
  const own = (src: string): boolean => /^deny-.*\.mts$/.test(basename(src)) && !Object.hasOwn(VERDICTS, basename(src))
  cpSync(join(from, 'hooks'), join(dest, 'hooks'), { recursive: true, filter: src => !own(src) })
  cpSync(join(from, 'output-styles'), join(dest, 'output-styles'), { recursive: true })
  cpSync(join(from, 'settings.json'), join(dest, 'settings.json'))
  return dest
}
// The project the dispatcher cases and the registration launches run in: that copy beside the
// root package.json and pnpm-workspace.yaml, so `pnpm -w run guards` from its hooks/ and Claude
// Code's `${CLAUDE_PROJECT_DIR}` both reach the copy's dispatcher. Never installed: every guard
// registration tells pnpm not to install first.
const TEMPLATE_PROJECT = join(tmp, 'template-project')
const TEMPLATE_HOOKS = join(claudeCopy(join(TEMPLATE_PROJECT, '.claude')), 'hooks')
for (const file of ['package.json', 'pnpm-workspace.yaml'])
  cpSync(join(REPO, file), join(TEMPLATE_PROJECT, file))

// A copy of .claude/ whose settings.json protects release/* instead of main: with the env
// var unset, the push guard must read the list from the file (Codex and Gemini never set it).
const SETTINGS_CLAUDE = claudeCopy(join(tmp, 'settings-claude'))
writeFileSync(join(SETTINGS_CLAUDE, 'settings.json'), JSON.stringify({ env: { PROTECTED_BRANCHES: 'release/*' } }))
const SETTINGS_HOOKS = join(SETTINGS_CLAUDE, 'hooks')
// A child's .claude/ with a guard of its own that denies `gh pr create`, and the copy made from
// it: the guard is live in the child's hooks and absent from the copy.
const CHILD_CLAUDE = claudeCopy(join(tmp, 'child-claude'))
writeFileSync(join(CHILD_CLAUDE, 'hooks', 'deny-pr-create.mts'), 'export const verdict = (cmd: string): string | null => cmd.startsWith(\'gh pr create\') ? \'the team opens pull requests by hand\' : null\n')
const CHILD_HOOKS = join(CHILD_CLAUDE, 'hooks')
const CHILD_COPY_HOOKS = join(claudeCopy(join(tmp, 'child-copy'), CHILD_CLAUDE), 'hooks')
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
// `cmd` under `depth` layers of `eval`, each double-quoting the layer inside it.
function nestedEval(depth: number, cmd: string): string {
  return Array.from({ length: depth }).reduce<string>(s => `eval ${JSON.stringify(s)}`, cmd)
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
  // pnpm's own `pn` is pnpm, and its `pnx` and `pnpx` are `pnpm dlx`.
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pn approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnx --allow-build=esbuild create-vite' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpx --allow-build=esbuild create-vite' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'timeout pnx --allow-build=esbuild create-vite' }, // not a duration
  { guard: P, expect: D, cmd: 'pn exec git push origin main' },
  { guard: P, expect: D, cmd: 'pn release' },
  { guard: P, expect: D, cmd: 'pnx changelogen --release --push' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnx npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'pnpx cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pn install' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnx create-vite my-app' },
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
  // A setting counts where it is set: a flag, or after `config set` or its `set` shorthand.
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm set allowBuilds \'{"esbuild":true}\' --json' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm c set allow-builds esbuild' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm install --config.dangerously-allow-all-builds=true' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm install --dangerously-allow-all-builds' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm config get allowBuilds' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm config delete onlyBuiltDependencies' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm exec grep -n allowBuilds pnpm-workspace.yaml' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm exec tsx scripts/check-only-built-dependencies.mts' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'pnpm vitest run test/allow-builds.test.ts' },
  // A variable assigned first counts once it is exported, later or through `set -a`.
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm_config_dangerously_allow_all_builds=true; export pnpm_config_dangerously_allow_all_builds; pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'set -a; pnpm_config_dangerously_allow_all_builds=true; pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npm_config_allow_builds=esbuild pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'env -u pnpm_config_dangerously_allow_all_builds pnpm install' },

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
  // pnpm's shell mode (`-c`, `--shell-mode`) hands its words to a shell, so they are a command.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm exec -c "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm -r -c exec "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm --shell-mode=true exec \'npm install\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm dlx -c "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnx -c "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm --package cowsay -c dlx \'echo hi | npm install\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'pnpm -c exec "cat .env"' },
  { guard: P, expect: D, cmd: 'pnpm -c exec "git push origin main"', cwd: ON_FEAT },
  { guard: B, expect: D, cmd: 'pnpm exec --shell-mode "git commit --no-verify -m x"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm -c exec "echo hi"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm -r -c exec \'tsc && pnpm test\'' },

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
  // The string flock's and runuser's -c (--command) hand a shell is a command too.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock /tmp/l -c "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'flock -w 5 /tmp/l -c \'npm install\'' },
  { guard: P, expect: D, cmd: 'flock /tmp/l --command "git push origin main"', cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'flock /tmp/l -c "cat .env"' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'flock /tmp/l -c "pnpm approve-builds"' },
  { guard: B, expect: D, cmd: 'flock /tmp/l -c "git commit --no-verify -m x"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -c "npm install" root' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -lc \'npm install\' root' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'flock /tmp/l -c "pnpm install"' },
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
  // Their Windows homes under %APPDATA%: the gh token and libpq's password file.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat "$APPDATA/GitHub CLI/hosts.yml"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat "$APPDATA/postgresql/pgpass.conf"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\Users\\me\\AppData\\Roaming\\postgresql\\pgpass.conf\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/AppData/Roaming/GitHub\\ CLI/*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ~/AppData/Roaming/postgresql/*.conf' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat pgpass.conf' }, //           no postgresql parent
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat docs/postgresql/notes.md' },
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
  // So is the string mise x|exec's -c (--command) hands a shell.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise x -c "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise exec node@24 --command=\'npm install\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'mise x -c "cat .env"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'mise x node@24 -c "pnpm install"' },
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
  // git reads these as paths too: a backslash or drive-letter path, `.`, `..`, a user-less
  // scp-like URL, and a bare name the cwd has no remote for (./mirror), in any position git
  // takes the remote from.
  { guard: P, expect: D, cmd: 'git push \'C:\\clones\\roots\' feat/x' },
  { guard: P, expect: D, cmd: 'git push C:/clones/roots feat/x' },
  { guard: P, expect: D, cmd: 'git push .. feat/x' },
  { guard: P, expect: D, cmd: 'git push . feat/x' },
  { guard: P, expect: D, cmd: 'git push host:repo.git feat/x' },
  { guard: P, expect: D, cmd: 'git push mirror feat/x' },
  { guard: P, expect: D, cmd: 'git push -- ../other feat/x' },
  { guard: P, expect: D, cmd: 'git push --repo=../other' },
  { guard: P, expect: D, cmd: 'git push --repo ../other' },
  { guard: P, expect: A, cmd: 'git push -- origin feat/x' },
  { guard: P, expect: A, cmd: 'git push --repo=origin' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\repo\\.env\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat "C:\\repo\\.env"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'secrets\\token\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat \'C:\\Users\\me\\.ssh\\id_rsa\'' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'echo "a\\nb"' },
  // git diff, difftool, and grep read the working tree under --no-index, which a path outside
  // the worktree turns on for git diff, and git blame --contents prints the file it names.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git diff /dev/null .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git diff --no-index .env.example .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git difftool --no-index -y -x cat /dev/null .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git -C . --no-pager diff /dev/null ~/.aws/credentials' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git -c core.pager=cat diff /dev/null ~/.aws/credentials' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'pnpm exec git diff /dev/null .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git grep --no-index -e . .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git diff /dev/null .e*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git blame --contents .env README.md' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git -C secrets grep --no-index -e . .' }, // a global option's value
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'git diff -- .env' }, //                      a pathspec: declared over-block
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git diff --cached' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git diff main...HEAD --stat' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git diff a.txt b.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git diff -- .env.example' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git grep -n process.env' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git blame README.md' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'git status --short .env' }, //             prints no content
  // A secret named as an option's value is judged like the same value written as its own word:
  // `--name=value`, and a value glued to a short -f or -g. An exclusion counts too (declared
  // over-block), and an rg glob without `!` is an include that makes rg read the file.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -rn KEY --include=.env .' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -r _authToken --include=.npmrc ~' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'diff --from-file=.env .env.example' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep --file=.env -r x .' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -f.env x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -rf.env x .' }, //                     -f last in a cluster
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -fsecrets/api.txt x' }, //             a value that starts with a letter
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -rfsecrets/token x .' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -fid_rsa x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -f_netrc x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sed -fsecrets/x y' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg -gsecrets/* KEY' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg -uu KEY --glob=.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg -uu KEY -g.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg KEY -g.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg KEY -g .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'rg KEY --glob=.env*' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -r x . --exclude .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -r x . --exclude=.env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -r x . --exclude-dir secrets' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'grep -r x . --exclude-dir=secrets' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -rn x --include=*.ts .' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'diff --from-file=a.txt b.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -f./patterns.txt x' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -fpatterns.txt x' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'sort -fg data.txt' }, //                    flags alone, no value
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'rg KEY -g \'!.env\'' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'rg KEY --glob=!.env' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'grep -rn x --include \'.env*\' .' }, //   a quoted glob is text
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'sort --output=.env.out data.txt' }, //   the output target
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'sort --output=x.pem data.txt' },

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
  // `:` is the matching refspec: every branch with a namesake on the remote, main included.
  { guard: P, expect: D, cmd: 'git push origin :', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin :' },
  { guard: P, expect: D, cmd: 'git push origin ":"' },
  { guard: P, expect: D, cmd: 'git push origin feat/x :' },
  { guard: P, expect: D, cmd: 'git push origin -- :' },
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
  // A brace list expands into several words, shifting every word after it, so any word holding
  // one leaves the target unknown; a quoted one is text.
  { guard: P, expect: D, cmd: 'git push origin {develop,main}', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin {develop,main}', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin HEAD:{main,x}', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push {origin,main}', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin ma{i..i}n', cwd: ON_FEAT }, //         a sequence
  { guard: P, expect: D, cmd: 'git push -o {a,b} origin feat/x', cwd: ON_FEAT }, //   an option's value
  { guard: P, expect: A, cmd: 'git push origin HEAD@{1}:feat/x', cwd: ON_FEAT }, //   a reflog entry, no list
  { guard: P, expect: A, cmd: 'git push origin \'{develop,main}\'', cwd: ON_FEAT },
  // A shell variable's value is unknown here, so a remote or refspec holding one is denied on
  // any branch (declared over-block); single quotes and an option's value expand nothing judged.
  { guard: P, expect: D, cmd: 'git push -u origin "$BRANCH"', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push -u origin "$BRANCH"', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'BRANCH=$(git branch --show-current); git push -u origin "$BRANCH"', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: `git push origin "\${BRANCH:-main}"`, cwd: ON_MAIN },
  { guard: P, expect: D, cmd: `git push origin "\${BRANCH:-main}"`, cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin HEAD:"$TARGET"', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'git push origin HEAD:"$TARGET"', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'for b in main; do git push origin $b; done', cwd: ON_MAIN },
  { guard: P, expect: D, cmd: 'for b in main; do git push origin $b; done', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'ARGS="origin main"; git push $ARGS', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push "$R" feat/x', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin --delete "$B"', cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push --repo "$R"', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push origin \'feat/$x\'', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push --force-with-lease=feat/x:$SHA origin feat/x', cwd: ON_FEAT },
  { guard: P, expect: A, cmd: 'git push -o "$OPT" origin feat/x', cwd: ON_FEAT },
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
  // git reads a short-option word letter by letter; a letter after -m, -u or -S is their value.
  { guard: B, expect: D, cmd: 'git commit -an -m x' },
  { guard: B, expect: D, cmd: 'git commit -na -m x' },
  { guard: B, expect: D, cmd: 'git commit -u -n -m x' }, // -u takes only a glued value
  { guard: B, expect: D, cmd: 'git commit -mx -n' },
  { guard: B, expect: D, cmd: 'git commit -m -- -n' }, // -- is the message, so -n is a flag
  { guard: B, expect: A, cmd: 'git commit -m"initial commit"' },
  { guard: B, expect: A, cmd: 'git commit -m"done"' },
  { guard: B, expect: A, cmd: 'git commit -mdone' },
  { guard: B, expect: A, cmd: 'git commit -am"initial"' },
  { guard: B, expect: A, cmd: 'git commit -uno -m x' },
  { guard: B, expect: A, cmd: 'git commit -Snkey -m x' },
  { guard: B, expect: A, cmd: 'git commit -Cnext' },
  { guard: B, expect: A, cmd: 'git status -uno' },
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
  // Exporting by name alone exports the value set earlier.
  { guard: B, expect: D, cmd: 'declare SKIP_SIMPLE_GIT_HOOKS=1; export SKIP_SIMPLE_GIT_HOOKS; git commit -m x' },
  { guard: B, expect: D, cmd: 'declare HUSKY=0; export HUSKY; git push origin feat/x' },
  { guard: B, expect: D, cmd: 'export HUSKY_SKIP_HOOKS; git commit -m x' },
  { guard: B, expect: D, cmd: 'declare -x SKIP_SIMPLE_GIT_HOOKS; git commit -m x' },
  { guard: B, expect: A, cmd: 'export CI=1; git commit -m x' },
  { guard: B, expect: A, cmd: 'export CI; git commit -m x' },
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
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '!(npm install)' }, //                    `!` where a command starts negates a subshell
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'if !(npm install); then :; fi' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'shopt -s extglob\nls !(#x) ; npm install' }, // as an argument, an extglob
  { guard: P, expect: D, cmd: 'shopt -s extglob\nls -d !(#*) ; git push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a # it\'s b\n); npm install' }, //  an array's `#` is a comment
  // A redirect operator ends a word: `]]>log` closes the conditional, so a later subshell runs.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ -n x ]]>/dev/null && (npm install)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ -n x ]]&>/dev/null; (npm install)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ -n x ]]<&0 && (npm install)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '[[ -f .nvmrc ]]>/dev/null\n(npm install)' },
  { guard: P, expect: D, cmd: '[[ -n x ]]>>log; (git push origin main)' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '[[ -n x ]]>/dev/null; (cat .env)' },
  { guard: B, expect: D, cmd: '[[ -n x ]]>/dev/null; (git commit --no-verify -m x)' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: '[[ -n x ]]>/dev/null; (pnpm approve-builds)' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{ cat <<\'EOF\'\nnpm install\nEOF\n}</dev/null | bash' }, // `}<in` closes the group
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{</dev/null cat <<\'EOF\'\nnpm install\nEOF\n} | bash' }, // `{<in` opens one
  // A function body and a case arm are commands: a new segment starts after the function header
  // and after each pattern's `)`.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'f(){ npm install; }; f' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'f() { npm install; }; f' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'f () { npm install; }; f' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'function f() { npm install; }; f' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'function f () { npm install; }; f' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'function show { cat .env; }; show' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in a) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in (a) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in b|a) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in b) :;; a) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in a) :;& b) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case a\nin a) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'shopt -s extglob\ncase $1 in !(b)) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case a in a) case b in b) :;; esac;; c) npm install;; esac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case b in a) :;;(b) npm install;; esac' }, // a pattern's own `(`
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case b in (a) :;;&(b) npm install;; esac' },
  { guard: P, expect: D, cmd: 'case $1 in\n  a) git push origin main;;\nesac' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case $1 in a) :;; esac|npm install' }, // after `esac`, `|` is a pipe
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'case "$1" in -h|--help) echo usage;; *) pnpm run "$1";; esac' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'f() { pnpm install; }; f' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'arr=(); pnpm install' },
  // A `(` or `)` inside `${…}` is text: it neither groups nor closes a substitution.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `y=\${x//(/}; (npm install)` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `y=\${x%(*}; (npm install)` },
  { guard: P, expect: D, cmd: `echo \${x#(}; (git push origin main)` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$(echo \${x:-)}; npm install)"` },
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
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\' | rbash\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\' | yash\nnpm install\nEOF' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'tcsh <<\'EOF\'\ncat .env\nEOF' },
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

  // --- lexer: words split where bash splits them -------------------------------------------
  // A quoted or escaped blank stays inside its word, so the head after it is still the head.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'FOO="a b" npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'FOO=a\\ b npm install' },
  { guard: P, expect: D, cmd: 'GIT_SSH_COMMAND="ssh -i k" git push origin main' },
  { guard: P, expect: D, cmd: 'git -c user.name="First Last" push origin main' },
  { guard: P, expect: D, cmd: 'git -C "my dir" push origin main' },
  { guard: B, expect: D, cmd: 'git -c user.name="First Last" commit --no-verify -m x' },
  { guard: B, expect: D, cmd: 'git -c \'user.name=First Last\' commit --no-verify -m x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'X="a b" cat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'X="a b" pnpm approve-builds' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '"C:\\Program Files\\nodejs\\npm.cmd" install' },
  { guard: B, expect: A, cmd: 'git -c user.name="First Last" commit -m "no --no-verify here"' },
  { guard: P, expect: A, cmd: 'X="a b" git push origin feat/x' },
  // A `${…}` expansion runs to its `}` as one word, bare or in double quotes, operators included.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO=\${x:-a b} npm install` },
  { guard: P, expect: D, cmd: `X=\${Y:-a b} git push origin main` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO="\${x:-"a b"}" npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO=\${x:-a;b} npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO=\${x:-a\nb} npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO="\${x:-";a"}" npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO="\${x:-'";a'}" npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${x:-<<EOF}\nnpm install\nEOF` }, // `<<` in it is text
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $\${x; npm install}` }, // `$$` is the PID: `{` opens nothing
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${x:-<(npm install)}` }, //  a process substitution still runs
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=1; echo \${x:+a>(npm install; echo })}` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo "\${x:-<(npm install)}"` }, //  but is text in double quotes
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo \${x:-a; npm i}` },
  // A `${` before a blank, a newline, or a `|` runs its body as commands, as bash 5.3 and mksh do.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=\${ npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `FOO=\${ npm install;} true` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${| npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${|npm install;}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=\${\nnpm install\n}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=\${\tnpm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${\\\n npm install; }` }, // a blank after the continuation
  { guard: P, expect: D, cmd: `FOO=\${ git push origin main;} true`, cwd: ON_FEAT },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: `X=\${ pnpm approve-builds; } true` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `x=\${ cat .env; }` },
  { guard: B, expect: D, cmd: `x=\${ git commit --no-verify -m x; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${ :; } npm install` }, // it may expand to nothing
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '$(true) npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${ :; }npm install` }, //   or glued before the name
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '"$(true)"npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '`true`npm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '$(true) pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${ npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ npm install; }"` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `cat <<EOF\n\${ npm install; }\nEOF` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${x:-\${ npm install; }}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${x:-\${ npm install; }}"` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x=\${ pnpm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo '\${ npm install; }'` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `cat <<'EOF'\n\${ npm install; }\nEOF` },
  // Its body ends at a `}` where a command starts: an argument or a quoted `}` is text.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${ echo }; npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${ echo "}"; npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${ { echo a; }; npm install; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ echo a; }x"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${ (echo a)}; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo "\${ echo a; } npm install"` }, // the quote resumes
  // A `}` also ends it right after a word that ends a compound command (a group's `}`, glued
  // too, `fi`, `done`, `esac`, `]]`), as bash 5.3 reads it, so a quote after it cannot hide the
  // rest; a `}` after a plain word, an assignment, or a redirect is still text.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { :; } }"; npm install` },
  { guard: P, expect: D, cmd: `echo "\${ { :; } }"; git push origin main`, cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo "\${ { :; } }"; cat .env` },
  { guard: B, expect: D, cmd: `echo "\${ { :; } }"; git commit --no-verify -m x` },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: `echo "\${ { :; } }"; pnpm approve-builds` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ if :; then :; fi }"; npm install` },
  { guard: P, expect: D, cmd: `echo "\${ if :; then :; fi }"; git push origin main`, cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ for x in a; do :; done }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ case a in a) :; esac }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ [[ a ]] }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { :; }}"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x="\${ { :; } }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `cat <<< "\${ { :; } }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \${x:-"\${ { :; } }"}; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(echo "\${ { :; } }"); npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ f() { :; } }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ time { :; } }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { { :; } } }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { { :; }}}"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { :; }\\\n}"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ { if :; then :; fi }}"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ if :; then if :; then :; fi fi }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ if :; then if :; then :; fi else :; fi }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ if [[ a ]] then :; fi }"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ echo fi }; npm install; }"` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ echo }}; npm install; }"` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ x=1 }; npm install; }"` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ [[ a ]]>/dev/null }; npm install; }"` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '{ if :; then cat <<\'E\'; fi } | bash\nnpm install\nE' }, // `}` after `fi` ends the group
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x="\${ if :; then :; fi }"; pnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo "\${ { :; }}"; pnpm install` },
  // bash before 5.3 (macOS /bin/bash, Git for Windows, Ubuntu 24.04) reads `${ x }` as an
  // expansion that ends at its `}` and fails when it runs, then runs the next line: both
  // readings are judged.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "\${ x }"\nnpm install` },
  { guard: P, expect: D, cmd: `x="\${ HOME }"\ngit push origin main`, cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo "\${ x }"\ncat .env` },
  { guard: B, expect: D, cmd: `echo "\${| x }"\ngit commit --no-verify -m x` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `eval 'echo "\${ x }"\nnpm install'` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo "\${ x }"\npnpm install` },
  // bash scans `$((…))` by counting parentheses and `$[…]` by counting brackets, so a `${` that
  // never closes inside them ends with the scan; it fails when it runs, and the next commands run.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $((\${x) a); npm install` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo $((\${x) a); cat .env` },
  { guard: B, expect: D, cmd: `echo $((\${x) a); git commit --no-verify -m x` },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: `echo $((\${x) a); pnpm approve-builds` },
  { guard: P, expect: D, cmd: `x=$((\${x:-a) a); git push origin main`, cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $((\${x:-a) a)\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(( (\${x:-a) ) ); npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$((\${x) a)"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $[ \${x) ]\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$[ \${x) ]"\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $[\${x:-a; b]\nnpm install` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo $[ ( \${x ) ]\ncat .env` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(( 1 + $[ \${x ] ))\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $[ $(( \${x) )) ]\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$[ (\${x ]"\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$(( $[\${x))"\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `cat <<< "$(( $[\${x:-a) )"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $[ 1 << 2 ]\nnpm install\n2' }, //    a shift, not a heredoc
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x=1; echo $(( \${x:-(1)} + $[ a[1] ] )); pnpm install` },
  // bash ends a backtick substitution at its first unescaped backtick before it parses anything
  // in it, so a quote inside a `$[`, `$(`, `(`, array, or process substitution open there closes
  // with it. That scan pairs a backslash with what follows it, in a quote or a comment too.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $[ \'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $[ \'`; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $[\'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo "`echo $[ \'`"\nnpm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'echo `echo $[ \'`\ncat .env' },
  { guard: B, expect: D, cmd: 'echo `echo $[ \'`\ngit commit --no-verify -m x' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'echo `echo $[ \'`\npnpm approve-builds' },
  { guard: P, expect: D, cmd: 'echo `echo $[ \'`\ngit push origin main', cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \`echo \${x:-<('\`\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo \`echo \${x:-<( '\`\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $(\'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $((\'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $(echo \'`; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `(echo \'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `x=(a \'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo <(\'`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo \'\\\\` ; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `# \\` \' ` ; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `echo $(# \\` \' ` ; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `cat <<E\n\\` \'x\nE\n` ; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo `echo \'\\`\'`; pnpm install' }, // an escaped backtick
  // So closed, a substitution is a word of its own or a part of one, which may print nothing:
  // several glued together may hide no head, a redirect standing alone takes the next word as
  // its target, and one glued into a file name can name a secret.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\`done))+=$(\${x((x[\${x:-$(case a in \`$( }}else a) npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '>& ] `(a[${x${x:-<(#\\"${` npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env`$[ >(` #' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '$(true)$(true) npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '`true``true` npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '> x npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '>& x $(true) npm install' },
  { guard: P, expect: D, cmd: '2> err.log git push origin main', cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '> out cat .env' },
  { guard: B, expect: D, cmd: '< in git commit --no-verify -m x' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: '> x pnpm approve-builds' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env$(true)' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env`true`' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ".env$(true)"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .e`true`nv' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '<(true) cat .env' }, //      a process substitution is a word
  { guard: B, expect: D, cmd: `\${x//[[ a \n}\\\ngit commit --no-verify -m x<<E\n` }, // an expansion may be empty
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x}npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x}\`$(case a in \` npm install` },
  { guard: B, expect: D, cmd: `$x\`$[ a[\${x &&echo \`git commit --no-verify -m x\n}+= a` },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: '\n$x`(`eval pnpm approve-builds' },
  { guard: P, expect: D, cmd: '$x git push origin main', cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '$x npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat .env\\\n\${x//a/}` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env$x' },
  // bash ends `${x:-'}'}` past the quoted `}`, so an expansion holding a quote stays text and the
  // globs after it are still read as globs.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat \${x:-'}'} .e*v` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat \${x:-'}'} .[e]nv` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat \${x:-"}"} .e*v` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat \${x//'}'/a} .e*v` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `cat \${x:-'}'} ~/.ssh/id_*` },
  { guard: P, expect: D, cmd: `\\git push origin main\\\n\${x//a/}`, cwd: ON_FEAT },
  { guard: P, expect: D, cmd: `git push origin main\${x}`, cwd: ON_FEAT },
  { guard: P, expect: D, cmd: 'git push origin "$BRANCH"', cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '"$x" npm install' }, //                     a quoted empty word is a word
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `"\${EDITOR:-vi}" notes.md; pnpm install` },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: `cat "$FILE" config/\${ENV}.json; pnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '> /dev/null pnpm install' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat "$(git rev-parse --show-toplevel)/README.md" config$(date +%s).json' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat \'.env$(true)\'' }, //               single quotes run nothing
  // bash 3.2 (macOS /bin/bash) ends a `$(…)`, `<(…)`, or `>(…)` at the `)` that matches its `(`
  // and an assignment's subscript at the `]` that matches its `[`, whatever `${` is open inside,
  // and a `${…}` at its `}`, whatever substitution is open inside it. The expansion fails when it
  // runs, and the commands after it run there, so that reading is judged too.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(\${x) a; npm install` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo $(\${x); cat .env` },
  { guard: P, expect: D, cmd: `x=$(\${x)\ngit push origin main`, cwd: ON_FEAT },
  { guard: B, expect: D, cmd: `echo $(\${x); git commit --no-verify -m x` },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: `echo $(\${x); pnpm approve-builds` },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `echo <(\${x); cat .env` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo >(\${x); npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `cat <(\${x) a; npm install` },
  { guard: P, expect: D, cmd: `echo $(\${x:-a) a; git push origin main`, cwd: ON_FEAT },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(\${x)\n\${x}\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `a[\${x]=1\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x[\${y]+=1\nnpm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `a[$(\${x)]=1; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $( (\${x) ) ; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(\${x:-\\)) ; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo "$(\${x)"; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(\${x #')\n) ; npm install` }, //   a comment in that count
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `echo $(echo \${x:-$(echo }) ) ; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `(echo \${x:-$(echo }) ; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `(echo \${x:-<(echo }) ; npm install` }, // bash 4.4 too
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `(echo \${x:-$[ }]) ; npm install` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo "$(echo \${x:-)}; pnpm install)"` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo $(echo \${HOME}) "\${x:-a}"; a[\${i}]=1; pnpm install` },
  // bash rejects an operator or a `(` inside an array (`x=(…)`) and, unlike any other syntax
  // error, drops only the rest of that line and runs the next, so a quote, a heredoc, or a line
  // continuation on the rejected line hides nothing.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=((1))\\\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=((1)) "\nnpm install\n"' },
  { guard: P, expect: D, cmd: 'x=((1)) "\ngit push origin main\n"', cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'x=((1)) "\ncat .env\n"' },
  { guard: B, expect: D, cmd: 'x=((1)) "\ngit commit --no-verify -m x\n"' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'x=((1)) "\npnpm approve-builds\n"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a ; b) \'\nnpm install\n\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a <b) "\nnpm install\n"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<E; x=((1))\nnpm install\nE' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=((1)) <<\'E\nnpm install\nE\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a\\\n(b) "\nnpm install\n"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $(x=((1)) "\nnpm install\n")' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(@(a) "\nnpm install\n")' }, //         extglob is off in bash -c
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'x=(a [[ (b) ]] "\nnpm install\n")' }, // a `[…]` span is one word
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'x=(<(a) "\nnpm install\n")' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'x=((1)) "\npnpm install\n"' },
  // An unquoted expansion standing as the command runs its default, split into words.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:-\nnpm install# }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:-\nnpm install\\\n; }` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:-npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${NPM:-npm} install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x[0]:-npm} install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:+npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:-} \${y:-npm} install` }, // an empty default leaves the next word
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `\${x:-\${y:-npm install}}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `${`\${x:-`.repeat(12)}npm install${'}'.repeat(12)}` }, // past the reparse bound
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `eval \${x:-npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `sudo \${x:-npm} install` },
  { guard: P, expect: D, cmd: `\${B:-git} push origin main`, cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `\${x:-cat} .env` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `"\${x:-npm install}"` }, //   one word, no such command
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `\${x:-a} \${y:-npm} install` }, // `a` runs, npm is its argument
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `echo \${x:-npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `\${PNPM:-pnpm} install` },
  // So does a pattern substitution's replacement, its quotes removed.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/npm} install` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x//a/npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/#a/npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/%a/npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/"npm install"}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/\${y:-npm install}}` },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/} \${x/a/npm} install` }, // an empty one leaves the next word
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: `x=a; \${x/a/sudo} \${x/a/npm} install` },
  { guard: P, expect: D, cmd: `x=a; \${x/a/git} push origin main`, cwd: ON_FEAT },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: `x=a; \${x/a/cat} .env` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x=a; "\${x/a/npm install}"` }, // one word, no such command
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x=a; echo \${x/a/npm install}` },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: `x=a; \${x/a/pnpm} install` },
  // In bash, only a space, a tab, or a newline separates: any other space-like byte is in the word.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'A=\u00A0x npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'A=\u00A0x cat .env' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'A=\u3000x cat .env' },
  { guard: B, expect: D, cmd: 'A=\rx git commit --no-verify -m x' },
  { guard: P, expect: D, cmd: 'git -c x.y=\u00A0b push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<E\u00A0F\nx\nE\u00A0F\nnpm install' }, // one delimiter word
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<E\vF\nx\nE\vF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\'\r\nx\r\nEOF\r\nnpm install\r\n' }, // a CRLF heredoc still ends
  // A delimiter keeps a CR that is not right before the newline, and the same line still ends it.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF\r>/dev/null\nx\nEOF\r\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF\r;\nx\nEOF\r\nnpm install' },
  { guard: P, expect: D, cmd: 'cat <<EOF\r|cat\nx\nEOF\r\ngit push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\r\'\nx\nEOF\r\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm install\r\n' },
  { guard: P, expect: D, cmd: 'git push origin main\r\n' },
  // PowerShell reads such a byte as a blank and a CR as a line end, and that reading is judged too.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\u00A0install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '\u00A0npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\u3000install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\vinstall' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\finstall' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\u0085install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '\rnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npm\rinstall' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a\rnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a #x\rnpm install' }, // a CR ends PowerShell's comment
  { guard: P, expect: D, cmd: 'git status # it\'s\rgit push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a;\u00A0npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval\u00A0"npm install"' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat\u00A0.env' },
  { guard: P, expect: D, cmd: 'git\u00A0push origin main' },
  { guard: P, expect: D, cmd: 'git push origin\u00A0main', cwd: ON_FEAT },
  { guard: B, expect: D, cmd: 'git commit\u00A0--no-verify -m x' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'pnpm\u00A0approve-builds' },
  // A quote closed mid-word keeps the word whole, so the flag after it is still read.
  { guard: B, expect: D, cmd: 'git commit -m "fix bug"s --no-verify -m "more"' },
  { guard: B, expect: D, cmd: 'git commit -m \'a b\'c -n' },
  // What `eval` runs and what `env -S` splits into a command are commands too.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval -- \'npm install\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "eval \'npm install\'"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "true; npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "\'#\' ; npm install"' }, // a quoted # is a command, not a comment
  { guard: P, expect: D, cmd: 'eval \'git push origin main\'' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'eval "cat .env"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -S "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -S\'npm install\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -iS "npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env --split-string="npm install"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -S "-i npm" install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -S \'npm\\_install\'' }, // env reads `\_` as a space
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'env -u X -S "pnpm approve-builds"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'eval "bash -s" <<\'EOF\'\nnpm install\nEOF' }, // eval starts the shell
  // Past eight layers, what is left is read with its quotes dropped, so the chain still ends at npm.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: nestedEval(12, 'npm install') },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: nestedEval(12, 'true; npm install') },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'eval "pnpm install"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'env -S "pnpm install"' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'eval "echo \'npm install\'"' },

  // --- lexer: a line continuation joins its lines, as bash joins them -------------------------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'FOO=1 \\\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo \\\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'pnpm exec \\\n  npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cd x && \\\n  npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'ls | \\\n  npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'n\\\npm install' },
  { guard: P, expect: D, cmd: 'git \\\n  push origin main' },
  { guard: P, expect: D, cmd: 'git -c k=v \\\npush origin main' },
  { guard: B, expect: D, cmd: 'git \\\ncommit --no-verify -m x' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'FOO=1 \\\ncat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'true && \\\npnpm approve-builds' },
  // Inside an operator too: `$\<newline>(` is `$(`, `<\<newline><<` a here-string.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo "$\\\n(npm install)"' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $\\\n\'a\\\' \'; npm install; echo \'\'' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $\\\n{x:- #}; npm install' }, // `#` inside `${…}` is text
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <\\\n<<\'EOF\'\nnpm install\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\\\nEOF\nx\nEOF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case b in a) echo A;\\\n; b) npm install;; esac' }, // `;;`
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'case b in a) :;\\\n& b) npm install;; esac' }, // `;&`
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'f (\\\n) { npm install; }' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'EOF\' |\\\n& bash\nnpm install\nEOF' }, // `|&`
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo a >\\\n|npm install' }, // `>|` writes a file named npm
  // And on the terminator line of a heredoc whose delimiter is unquoted.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<EOF\nbody\nEO\\\nF\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'cat <<EOF\nx\\\nEOF\nnpm install\nEOF' }, // the line is `xEOF`
  // A quoted delimiter runs on across lines; inside double quotes a continuation vanishes and a
  // backslash escapes a quote, as bash removes them.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<"EO\\\nF"; npm install\nx\nEOF' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<\'E\nF\'; npm install\nx' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <<"E\\"F"\nx\nE"F\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'cat <<\'E\\\nF\'\nx\nE\\\nF\nnpm install' }, // no line matches
  // Inside backticks, the closing backtick ends a delimiter, and a heredoc then has no body.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `cat <<\'E`; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `cat <<\'E`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo `cat <<E`\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo $(cat <<E)\nnpm install' }, // `$(` reads its body below
  // A backslash before a CR escapes the CR, so the newline after it still ends the command.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo \\\r\nnpm install' },
  { guard: P, expect: D, cmd: 'git status \\\r\ngit push origin main' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'pnpm \\\n  install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo \'a \\\nb\'; pnpm install' }, // literal inside single quotes
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'echo a \\\n# ; npm install' }, //  the `#` still opens a comment

  // --- lexer: a `#` after a subshell's `)` opens a comment -----------------------------------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '(echo a)#it\'s fine\nnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '((1))#it\'s\nnpm install' },
  { guard: P, expect: D, cmd: '(git status)#it\'s clean\ngit push origin main', cwd: ON_MAIN },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: '(true)#it\'s\ncat .env' },
  // After a process substitution, an array, or a substitution, the word runs on.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <(echo a)#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo a<(true)#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'x=(a b)#c; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'echo $(true)#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'cat <\\\n(echo a)#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'shopt -s extglob\necho @\\\n(a|b)#x; npm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: '(echo a)# ; npm install' },

  // --- coproc starts a command like the other reserved words ---------------------------------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'coproc npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'coproc { npm install; }' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'coproc X { npm install; }' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'coproc X while npm install; do :; done' },
  { guard: P, expect: D, cmd: 'coproc git push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'coproc cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'coproc pnpm install' },

  // --- wrapper value flags as each tool's own help lists them, GNU and BSD ---------------------
  // GNU `xargs -i` takes its value only glued on, so the word after it is the command.
  { guard: P, expect: D, cmd: 'echo x | xargs -i git push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'xargs -i cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'xargs -J % npm install' }, //       BSD xargs
  // A value flag the table missed made its value the head.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -D . npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'env -a x cat .env' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -a x npm install' },
  // Values that are names, not numbers: sudo's auth type and login class, BSD env's user.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'sudo -a passwd npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'sudo -c staff cat .env' }, //    BSD sudo
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'env -L root cat .env' }, //      BSD env
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -U root npm install' }, //       BSD env
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -P /bin npm install' }, //      BSD env
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'doas -a x npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -u x -G wheel npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -u x -s /bin/sh npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'runuser -u x -w PATH npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/usr/bin/time -o log npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'command time -f %e cat .env' },
  // taskset's -c is boolean (the mask reads as a CPU list), so a flag after it is no value.
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'taskset -c -a 0-3 npm install' },
  { guard: P, expect: A, cmd: 'echo x | xargs -i git push origin feat/x' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'xargs -i cat notes.txt' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'sudo -D /tmp pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'taskset -c -a 0-3 pnpm install' },

  // --- a `command -v` probe is the `command` wrapper word itself, never a flag's value -------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'env -u command -v npm install' },
  { guard: P, expect: D, cmd: 'env -u command -v git push origin main' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'env -u command -v cat .env' },
  { guard: B, expect: D, cmd: 'env -u command -v git commit --no-verify -m x' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'mise x -E command -v -- npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: '/usr/bin/command -v npm' }, //      a program, not the builtin
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'env command -v npm' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'command -V yarn' },

  // --- npx runs its first word after its flags; yarnpkg is yarn ------------------------------
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'yarnpkg install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'yarnpkg add x' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx yarn install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx -y npm@10 install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx -p npm npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx --package=x -- npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx -n x npm install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx --npm x yarn install' },
  { guard: 'deny-non-pnpm.mts', expect: D, cmd: 'npx -C /tmp npm install' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'npx -L x cat .env' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx -m x pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx pnpm install --allow-build=esbuild' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx -y pnpm@11 install --allow-build=esbuild' },
  // corepack ships beside npx in Node's bin dir, so npx runs it, and it runs pnpm.
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx corepack pnpm approve-builds' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx -y corepack pnpm install --allow-build=esbuild' },
  { guard: 'deny-build-scripts.mts', expect: D, cmd: 'npx pnpm config set allowBuilds.esbuild true' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'npx cat .env' },
  { guard: P, expect: D, cmd: 'npx pnpm release' },
  { guard: P, expect: D, cmd: 'npx -p changelogen changelogen --release --push' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'npx pnpm install' },
  { guard: 'deny-non-pnpm.mts', expect: A, cmd: 'npx tsx x.ts' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'npx pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'npx corepack pnpm install' },
  { guard: 'deny-build-scripts.mts', expect: A, cmd: 'npx -y create-vite my-app' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'npx tsx x.ts' },

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
  // A brace list names one word per member, each judged with the text around the list.
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat .env{,.local}' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat {.env,.env.local}' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat config/{app.json,.env}' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat src/{a,b}.ts' },
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
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat ?ecrets/api.txt' }, //      a leading wildcard beside text
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat [s]ecrets/api.txt' },
  { guard: 'deny-secret-reads.mts', expect: D, cmd: 'cat config/*ecret?/db.txt' },
  { guard: 'deny-secret-reads.mts', expect: A, cmd: 'cat [a-z]*/README.md' }, //    a directory of wildcards alone
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
  // A child's own guard denies that call in the child's hooks; the copy the cases run from drops it.
  { guard: 'dispatch.mts', expect: D, cmd: 'gh pr create --fill', hooksDir: CHILD_HOOKS },
  { guard: 'dispatch.mts', expect: A, cmd: 'gh pr create --fill', hooksDir: CHILD_COPY_HOOKS },
  { guard: 'dispatch.mts', expect: A, cmd: 'cat > notes.md <<\'EOF\'\nnpm install\ncat .env\ngit push origin main\nEOF' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git commit -m "$(cat <<\'EOF\'\nfix: x\nEOF\n)" --no-verify' },
  { guard: 'dispatch.mts', expect: D, cmd: '# Make sure we\'re up to date first\ngit push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git push origin 2>&1 | tail -5', cwd: ON_MAIN },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat .env*' },
  { guard: 'dispatch.mts', expect: D, cmd: 'git \\\n  push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'eval "npm install"' },
  { guard: 'dispatch.mts', expect: D, cmd: 'coproc npm install' },
  { guard: 'dispatch.mts', expect: D, cmd: 'npm\u00A0install', tool: 'PowerShell' },
  { guard: 'dispatch.mts', expect: D, cmd: 'cat <<EOF\r>/dev/null\nx\nEOF\r\nnpm install' },
  { guard: 'dispatch.mts', expect: D, cmd: `FOO=\${x:-a b} npm install` },
  { guard: 'dispatch.mts', expect: D, cmd: 'echo x | xargs -i git push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'xargs -i cat .env' },
  { guard: 'dispatch.mts', expect: D, cmd: 'env -a x cat .env' },
  { guard: 'dispatch.mts', expect: D, cmd: 'sudo -D . npm install' },
  { guard: 'dispatch.mts', expect: D, cmd: 'env -u command -v git push origin main' },
  { guard: 'dispatch.mts', expect: D, cmd: 'yarnpkg add x' },
  { guard: 'dispatch.mts', expect: D, cmd: 'npx pnpm approve-builds' },
  { guard: 'dispatch.mts', expect: D, cmd: 'npx pnpm install --allow-build=esbuild' },
  { guard: 'dispatch.mts', expect: D, cmd: '/usr/bin/command -v npm' },
  { guard: 'dispatch.mts', expect: A, cmd: 'command -v npm' },
  { guard: 'dispatch.mts', expect: A, cmd: 'npx -y changelogen' },
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

// Direct lexer pins: WRAP / WRAP_VALUE_FLAGS / WRAP_POSITIONAL / wouldHideHead / leadIndex all
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
  { cmd: 'taskset 0x1 npm i', head: 'npm' }, //              the mask is a positional
  { cmd: 'taskset -c 0-3 npm i', head: 'npm' }, //           and stays one after -c
  { cmd: 'taskset -c -a 0-3 cat .env', head: 'cat' }, //     -c is boolean
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
  { cmd: '(npm install)', head: 'npm' }, //                     a `(` left on a word is a misread
  { cmd: 'pn exec npm i', head: 'npm' }, //                      `pn` is pnpm
  { cmd: 'pnx -y npm i', head: 'npm' }, //                       `pnx` is `pnpm dlx`
  { cmd: 'FOO="a b" npm i', head: 'npm' }, //                    a quoted blank stays in its word
  { cmd: 'FOO=a\\ b npm i', head: 'npm' }, //                    so does an escaped one
  { cmd: 'A=\u00A0x cat .env', head: 'cat' }, //                 a no-break space is not a blank
  { cmd: 'GIT_SSH_COMMAND="ssh -i k" git push', head: 'git' },
  { cmd: 'sudo -u "my user" npm i', head: 'npm' },
  { cmd: 'FOO=1 \\\nnpm install', head: 'npm' }, //              a line continuation vanishes
  { cmd: '"C:\\Program Files\\nodejs\\npm.cmd" i', head: 'npm' }, // a quoted path with a space
  { cmd: 'npm "a b"</dev/null', head: 'npm' }, //               a glued redirect after a quote
  { cmd: '$() npm i', head: 'npm' }, //                         a substitution may expand to nothing
  { cmd: '$()npm i', head: 'npm' },
  { cmd: 'coproc npm i', head: 'npm' },
  { cmd: 'coproc X { npm i', head: 'npm' }, //                  the name before a compound command
  { cmd: 'coproc npm { i', head: 'npm' }, //                    a name that is a head is never skipped
  { cmd: `FOO=\${x:-a b} npm i`, head: 'npm' }, //                an expansion is one word to its `}`
  { cmd: `FOO="\${x:-"a b"}" npm i`, head: 'npm' }, //            quotes nest inside it
  { cmd: `\${x/a/b} npm i`, head: 'npm' }, //                     a substitution may be empty; segments() reads `b` too
  { cmd: 'pnpm -r exec -c npm i', head: 'npm' }, //              shell mode's plain words already name the command
  // Each wrapper's value flags, from its own help (GNU and BSD).
  { cmd: 'xargs -i cat .env', head: 'cat' }, //                   -i takes a glued value only
  { cmd: 'xargs -i npm i', head: 'npm' },
  { cmd: 'xargs -J % npm i', head: 'npm' }, //                    BSD xargs
  { cmd: 'sudo -D . npm i', head: 'npm' },
  { cmd: 'env -a x npm i', head: 'npm' },
  { cmd: 'doas -a x npm i', head: 'npm' },
  { cmd: 'runuser -u x -G wheel npm i', head: 'npm' },
  { cmd: 'runuser -u x -s /bin/sh npm i', head: 'npm' },
  { cmd: '/usr/bin/time -f %e -o log cat .env', head: 'cat' },
  // A probe is the `command` wrapper word itself, not a flag's value or a path.
  { cmd: 'env -u command -v npm', head: 'npm', probe: false },
  { cmd: 'env command -v npm', head: 'npm', probe: true },
  { cmd: '/usr/bin/command -v npm', head: 'npm', probe: false },
  // npx runs the first word after its flags and their values.
  { cmd: 'npx -y npm@10 i', head: 'npm' },
  { cmd: 'npx -p cowsay cowsay hi', head: 'cowsay' },
  { cmd: 'npx -p npm npm i', head: 'npm' }, //                    a value that is a head is not consumed
  { cmd: 'npx --package=x -- cat .env', head: 'cat' },
  { cmd: 'npx -n x npm i', head: 'npm' },
  { cmd: 'npx -C /tmp cat .env', head: 'cat' },
  { cmd: 'pnpm exec npx -y yarn', head: 'yarn' }, //              runners nest
  { cmd: 'yarnpkg add x', head: 'yarnpkg' },
]

// The session-start hook prints the writing rules as SessionStart context for Codex and
// Gemini. It never reads the payload, never blocks, and never exits non-zero; the style body
// arrives without frontmatter or CR, and stays short (Codex's additionalContextLimit defaults to
// 2,500 tokens, about 10,000 characters; 8,000 leaves headroom). SENTINEL is the file's last line, so prose edits do not break the suite.
const SESSION = 'session-start.mts'
const STYLE_TEXT = readFileSync(join(HOOKS, '..', 'output-styles', 'writing.md'), 'utf8')
const SENTINEL = STYLE_TEXT.trim().split('\n').at(-1)!.trim()
const NOSTYLE_CLAUDE = claudeCopy(join(tmp, 'nostyle-claude'))
rmSync(join(NOSTYLE_CLAUDE, 'output-styles', 'writing.md'))
const CRLF_CLAUDE = claudeCopy(join(tmp, 'crlf-claude'))
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
// listed one by one, and a wildcard before the last word matches nothing at all. `pnpm verify`
// and the read-only `pnpm docs:list`, the two commands the docs send agents to most, run without
// a prompt in Claude Code; any other allow rule is the repository's own choice. Gemini's
// `context.fileName` names GEMINI.md too, or each developer's ~/.gemini/GEMINI.md stops loading.
// The Codex and Gemini commands run through pnpm, which exits 1 when it fails before the script
// runs and, unless told not to, first runs `pnpm install` on a stale workspace. So each command
// carries the no-install flag, and each guard command maps any failure to 2. Codex's `command`
// runs off Windows only, under sh, bash, zsh, or a `$SHELL -lc` fallback whose login shell may be
// fish, which cannot parse the exit tail, or nushell, which has no `||`, so it hands sh a command
// that ends in `|| exit 2`. Codex's `commandWindows` and Gemini's `command` may run under
// PowerShell, which needs the tail, and the space before the tail's `;` matters under cmd.exe,
// which would hand pnpm `guards;` as the script name. A session command must exit 0, so it has
// no tail. The hook rules above bind only the template's own entries, those whose command runs
// dispatch.mts or the root `guards` or `session` script, and each file must hold them; a child
// may register hooks of its own beside them (sync-template.md), which are never checked, except
// that a Claude PreToolUse command must still brace its `${CLAUDE_PROJECT_DIR}`.
interface Handler { command?: string, commandWindows?: string }
interface Registration { matcher?: string, hooks?: Handler[] }
interface Hooks { SessionStart?: Registration[], BeforeTool?: Registration[], PreToolUse?: Registration[] }
interface RegistrationFiles {
  claude: { permissions?: { allow?: string[], deny?: string[] }, hooks?: Hooks }
  codex: { hooks?: Hooks }
  gemini: { context?: { fileName?: string | string[] }, hooks?: Hooks, tools?: { allowed?: string[] } }
}
const gemini = JSON.parse(readFileSync(join(REPO, '.gemini', 'settings.json'), 'utf8')) as RegistrationFiles['gemini']
const codex = JSON.parse(readFileSync(join(REPO, '.codex', 'hooks.json'), 'utf8')) as RegistrationFiles['codex']
const claude = JSON.parse(readFileSync(join(HOOKS, '..', 'settings.json'), 'utf8')) as RegistrationFiles['claude']
const rootPackage = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: { guards?: string, session?: string } }
const scriptNames = Object.keys(rootPackage.scripts ?? {})
const NO_INSTALL = '--config.verify-deps-before-run=false'
const EXIT_TAIL = 'exit $((2*!!($true-$?)))'
const OR_EXIT = '|| exit 2'
const CODEX_SOURCES: readonly string[] = ['startup', 'resume', 'clear', 'compact']
const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'Monitor']
// The credentials a developer machine holds in the home directory, outside any repository.
const HOME_CREDENTIALS: readonly string[] = ['.ssh/id_*', '.aws/credentials', '.config/gh/hosts.yml', '.git-credentials', '.kube/config', '.docker/config.json', '.pgpass', '.netrc', '_netrc', '.npmrc']
type HandlerTest = (h: Handler) => boolean
const runsDispatcher: HandlerTest = h => (h.command ?? '').includes('dispatch.mts')
const runsScript = (script: string): HandlerTest => h => [h.command, h.commandWindows].some(c => c !== undefined && new RegExp(`\\brun ${script}(?![\\w:-])`).test(c))
const runsGuards = runsScript('guards')
const runsSession = runsScript('session')
interface Picked { entries: Registration[], handlers: Handler[] }
/** The entries holding a handler `pick` selects, and those handlers alone. */
function picked(entries: Registration[] | undefined, pick: HandlerTest): Picked {
  const hits = (entries ?? []).filter(e => (e.hooks ?? []).some(pick))
  return { entries: hits, handlers: hits.flatMap(e => e.hooks ?? []).filter(pick) }
}
/** The template's own entries in the three files: the guards' and the writing rules'. */
function templateEntries(f: RegistrationFiles): Record<'claudeGuard' | 'codexGuard' | 'geminiGuard' | 'codexSession' | 'geminiSession', Picked> {
  return {
    claudeGuard: picked(f.claude.hooks?.PreToolUse, runsDispatcher),
    codexGuard: picked(f.codex.hooks?.PreToolUse, runsGuards),
    geminiGuard: picked(f.gemini.hooks?.BeforeTool, runsGuards),
    codexSession: picked(f.codex.hooks?.SessionStart, runsSession),
    geminiSession: picked(f.gemini.hooks?.SessionStart, runsSession),
  }
}
/** The problems in three registration files, one line each, empty when the template's entries are sound. */
function registrationProblems(f: RegistrationFiles): string[] {
  const { claude, gemini } = f
  const t = templateEntries(f)
  const structural: string[] = []
  const required: [string, Picked, string][] = [
    ['.claude/settings.json', t.claudeGuard, 'no PreToolUse entry runs dispatch.mts, so no guard runs in Claude Code'],
    ['.codex/hooks.json', t.codexGuard, 'no PreToolUse entry runs the guards script, so no guard runs in Codex'],
    ['.gemini/settings.json', t.geminiGuard, 'no BeforeTool entry runs the guards script, so no guard runs in Gemini'],
    ['.codex/hooks.json', t.codexSession, 'no SessionStart entry runs the session script, so Codex never loads the writing rules'],
    ['.gemini/settings.json', t.geminiSession, 'no SessionStart entry runs the session script, so Gemini never loads the writing rules'],
  ]
  for (const [file, p, why] of required) {
    if (p.entries.length === 0)
      structural.push(`${file}: ${why}`)
  }
  for (const e of t.geminiSession.entries) {
    if (e.matcher !== undefined)
      structural.push(`.gemini/settings.json: SessionStart matcher "${e.matcher}" never fires (exact-string match); omit the matcher`)
  }
  for (const e of t.geminiGuard.entries) {
    if (e.matcher !== 'run_shell_command')
      structural.push(`.gemini/settings.json: BeforeTool matcher "${e.matcher ?? ''}" is not run_shell_command`)
  }
  if (gemini.tools?.allowed !== undefined)
    structural.push('.gemini/settings.json: tools.allowed is deprecated and denies every shell command it does not list, even in YOLO mode; leave it out')
  for (const name of ['AGENTS.md', 'GEMINI.md']) {
    if (![gemini.context?.fileName ?? []].flat().includes(name))
      structural.push(`.gemini/settings.json: context.fileName lacks ${name}`)
  }
  for (const e of t.codexSession.entries) {
    const sources = (e.matcher ?? '').split('|').filter(Boolean)
    for (const source of sources) {
      if (!CODEX_SOURCES.includes(source))
        structural.push(`.codex/hooks.json: SessionStart matcher "${source}" is not a Codex session source`)
    }
    const skipped = CODEX_SOURCES.filter(s => !sources.includes(s))
    if (sources.length > 0 && skipped.length > 0)
      structural.push(`.codex/hooks.json: SessionStart matcher "${e.matcher ?? ''}" skips ${skipped.join(', ')}, so the writing rules vanish there; omit the matcher`)
  }
  for (const e of t.codexGuard.entries) {
    if (e.matcher !== 'Bash')
      structural.push(`.codex/hooks.json: PreToolUse matcher "${e.matcher ?? ''}" is not Bash`)
  }
  for (const h of t.codexGuard.handlers) {
    if (h.commandWindows === undefined)
      structural.push('.codex/hooks.json: PreToolUse handler has no commandWindows, the command Codex runs in PowerShell on Windows')
    const inner = /^sh -c '([^']*)'$/.exec(h.command ?? '')?.[1]
    if (inner === undefined)
      structural.push(`.codex/hooks.json: guard command ${h.command ?? '(none)'} is not one single-quoted sh -c command, so a login shell such as nushell, which has no ||, or fish, which cannot parse the exit tail, lets every call through`)
    else if (!inner.endsWith(` ${OR_EXIT}`))
      structural.push(`.codex/hooks.json: guard command ${h.command ?? '(none)'} hands sh a command that does not end in " ${OR_EXIT}", so a pnpm failure lets the call through`)
  }
  function commandsIn(file: string, list: Handler[]): { file: string, command: string }[] {
    return list.flatMap(h => [h.command, h.commandWindows]).filter(c => c !== undefined).map(command => ({ file, command }))
  }
  for (const { file, command } of [...commandsIn('.codex/hooks.json', t.codexGuard.handlers), ...commandsIn('.gemini/settings.json', t.geminiGuard.handlers)]) {
    if (!command.includes(NO_INSTALL))
      structural.push(`${file}: guard command ${command} lacks ${NO_INSTALL}, so pnpm installs first on a stale workspace`)
  }
  const tailed = [
    ...t.codexGuard.handlers.flatMap(h => h.commandWindows ?? []).map(command => ({ file: '.codex/hooks.json', command })),
    ...commandsIn('.gemini/settings.json', t.geminiGuard.handlers),
  ]
  for (const { file, command } of tailed) {
    if (!command.endsWith(`; ${EXIT_TAIL}`))
      structural.push(`${file}: guard command ${command} does not end in "; ${EXIT_TAIL}", so a pnpm failure or PowerShell's exit 1 lets the call through`)
    else if (!command.endsWith(` ; ${EXIT_TAIL}`))
      structural.push(`${file}: guard command ${command} has no space before the tail's ";", so cmd.exe hands pnpm a script name ending in ";" and every call passes`)
  }
  for (const { file, command } of [...commandsIn('.codex/hooks.json', t.codexSession.handlers), ...commandsIn('.gemini/settings.json', t.geminiSession.handlers)]) {
    if (!command.includes(NO_INSTALL))
      structural.push(`${file}: session command ${command} lacks ${NO_INSTALL}, so pnpm installs first on a stale workspace`)
    if (/\bexit\b/.test(command))
      structural.push(`${file}: session command ${command} carries an exit tail; a session hook must exit 0`)
  }
  for (const e of t.claudeGuard.entries) {
    for (const tool of SHELL_TOOLS) {
      if (!(e.matcher ?? '').split('|').includes(tool))
        structural.push(`.claude/settings.json: PreToolUse matcher "${e.matcher ?? ''}" leaves the ${tool} tool unguarded`)
    }
  }
  for (const h of (claude.hooks?.PreToolUse ?? []).flatMap(e => e.hooks ?? [])) {
    if ((h.command ?? '').includes('$CLAUDE_PROJECT_DIR'))
      structural.push(`.claude/settings.json: PreToolUse command ${h.command ?? ''} uses the bare $CLAUDE_PROJECT_DIR, which PowerShell resolves to nothing; write \${CLAUDE_PROJECT_DIR}`)
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
  for (const cmd of ['pnpm verify', 'pnpm docs:list', 'pnpm docs:list decisions']) {
    const allowed = (claude.permissions?.allow ?? []).some((rule) => {
      const body = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? ''
      return body === cmd || (body.endsWith(':*') && `${cmd} `.startsWith(`${body.slice(0, -2)} `))
    })
    if (!allowed)
      structural.push(`.claude/settings.json: no allow rule matches ${cmd}, so it prompts`)
  }
  return structural
}
const FILES: RegistrationFiles = { claude, codex, gemini }
const TEMPLATE = templateEntries(FILES)
const codexGuards = TEMPLATE.codexGuard.handlers
const geminiGuards = TEMPLATE.geminiGuard.handlers
const codexSessions = TEMPLATE.codexSession.handlers
const geminiSessions = TEMPLATE.geminiSession.handlers
const realProblems = registrationProblems(FILES)

// A child may register hooks of its own beside the template's: for another tool, event, or
// source, or as another handler in a template entry. None may add a problem. With the template's
// entries gone each file must say so rather than pass with nothing to check, and a template entry
// whose matcher is narrowed is still caught. Each case edits a copy of the real files and reports
// only the problems the real files lack.
interface RegistrationCase { name: string, edit: (f: RegistrationFiles) => void, want: string[] }
const entriesOf = (file: { hooks?: Hooks }, event: keyof Hooks): Registration[] => ((file.hooks ??= {})[event] ??= [])
const ownHook = (matcher: string): Registration => ({ matcher, hooks: [{ command: 'node .claude/hooks/format.mts' }] })
/** Every template entry of `f`, with the event list it sits in. */
function templateLists(f: RegistrationFiles): [Registration[], HandlerTest][] {
  return [[entriesOf(f.claude, 'PreToolUse'), runsDispatcher], [entriesOf(f.codex, 'PreToolUse'), runsGuards], [entriesOf(f.gemini, 'BeforeTool'), runsGuards], [entriesOf(f.codex, 'SessionStart'), runsSession], [entriesOf(f.gemini, 'SessionStart'), runsSession]]
}
function addOwnHooks(f: RegistrationFiles): void {
  entriesOf(f.claude, 'PreToolUse').unshift(ownHook('Edit|Write'))
  entriesOf(f.codex, 'PreToolUse').push(ownHook('apply_patch'))
  entriesOf(f.codex, 'SessionStart').push(ownHook('startup'))
  entriesOf(f.gemini, 'BeforeTool').push(ownHook('write_file'))
  entriesOf(f.gemini, 'SessionStart').push(ownHook('startup'))
  for (const [list, pick] of templateLists(f))
    list.find(e => (e.hooks ?? []).some(pick))?.hooks?.push({ command: 'node .claude/hooks/log.mts' })
}
const REGISTRATION_CASES: RegistrationCase[] = [
  { name: 'own hooks beside the template\'s', edit: addOwnHooks, want: [] },
  {
    // The one rule a child's own hook meets (agent-surfaces): a Claude Code PreToolUse command
    // braces ${CLAUDE_PROJECT_DIR}, the spelling PowerShell resolves.
    name: 'own Claude hook with the bare project dir',
    edit: (f) => {
      addOwnHooks(f)
      entriesOf(f.claude, 'PreToolUse').unshift({ matcher: 'Edit|Write', hooks: [{ command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/format.mts' }] })
    },
    want: ['uses the bare $CLAUDE_PROJECT_DIR'],
  },
  {
    name: 'own hooks alone',
    edit: (f) => {
      addOwnHooks(f)
      for (const [list, pick] of templateLists(f))
        list.splice(0, list.length, ...list.filter(e => !(e.hooks ?? []).some(pick)))
    },
    want: ['no PreToolUse entry runs dispatch.mts', 'no PreToolUse entry runs the guards script', 'no BeforeTool entry runs the guards script', '.codex/hooks.json: no SessionStart entry', '.gemini/settings.json: no SessionStart entry'],
  },
  {
    name: 'template matchers narrowed',
    edit: (f) => {
      addOwnHooks(f)
      const matchers = ['Bash', 'Shell', 'shell', 'startup', 'startup']
      for (const [i, [list, pick]] of templateLists(f).entries()) {
        for (const e of list.filter(e => (e.hooks ?? []).some(pick)))
          e.matcher = matchers[i]!
      }
    },
    want: ['"Bash" leaves the PowerShell tool unguarded', '"Bash" leaves the Monitor tool unguarded', 'PreToolUse matcher "Shell" is not Bash', 'BeforeTool matcher "shell" is not run_shell_command', 'SessionStart matcher "startup" skips resume, clear, compact', 'SessionStart matcher "startup" never fires'],
  },
]

const fails: string[] = []
for (const p of realProblems)
  fails.push(`[registrations] ${p}`)
for (const c of REGISTRATION_CASES) {
  const f = structuredClone(FILES)
  c.edit(f)
  const got = registrationProblems(f).filter(p => !realProblems.includes(p))
  for (const p of got.filter(p => !c.want.some(w => p.includes(w))))
    fails.push(`[registrations] ${c.name}: unexpected problem: ${p}`)
  for (const w of c.want.filter(w => !got.some(p => p.includes(w))))
    fails.push(`[registrations] ${c.name}: no problem names ${w}`)
}
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
// A run of digits once made tokenize() backtrack quadratically: 100k digits took seconds, and a
// shell check per heredoc did the same over thousands of heredocs. A slow check fails open under
// Gemini, which runs the call once a hook outlasts its 10 s timeout. The lexer is a linear scan,
// so each of these stays far under budget.
const BUDGET: Record<string, string> = {
  '100k digits': `echo ${'1'.repeat(100_000)}`,
  '5000 heredocs on one line': `cat${' <<A'.repeat(5000)}\nA\n`,
  '2500 heredocs in one pipeline': `${'cat <<A |'.repeat(2500)} cat\nA\n`,
  '5000 heredocs after ;': `${'cat <<A;'.repeat(5000)}\nA\n`,
  '2000 substitutions with a heredoc': `bash x.sh "${'$(cat <<A\nA\n)'.repeat(2000)}"`,
  '50k glued parentheses': `echo ${'@('.repeat(50_000)}`,
  '20k conditionals': `${'[[ a ]] && '.repeat(20_000)}true`,
  '20k function headers': `${'f() { :; }; '.repeat(20_000)}f`,
  '20k case arms': `case x in ${'a|b) :;; '.repeat(20_000)}esac`,
  '5000 heredocs in nested groups': `${'{ cat <<A\nA\n'.repeat(5000)}${'}\n'.repeat(5000)}`,
  '2000 heredocs in nested substitutions': `echo ${'"$(cat <<A\nA\n'.repeat(2000)}${')"'.repeat(2000)} | cat`,
  '5000 heredocs in a continued pipeline': `${'cat <<A |\nA\n'.repeat(5000)}cat`,
  '50k line continuations': `echo ${'a \\\n'.repeat(50_000)}x`,
  '20k quoted words': `echo ${'"a b" '.repeat(20_000)}`,
  '20k evals': `${'eval "x y"; '.repeat(20_000)}true`,
  '20k env -S': `${'env -S "x y"; '.repeat(20_000)}true`,
  '12 nested evals': nestedEval(12, 'npm install'),
  '10k nested expansions in quotes': `echo "${'${x:-"'.repeat(10_000)}a${'"}'.repeat(10_000)}"`,
  '10k unclosed expansions': `echo ${'"${x '.repeat(10_000)}`,
  '20k no-break spaces': `echo ${'a\u00A0'.repeat(20_000)}`,
  '20k continued heredoc lines': `cat <<A\n${'x\\\n'.repeat(20_000)}A\n`,
  '100k backslashes before a heredoc end': `cat <<A\n${'\\'.repeat(100_001)}\nA\n`,
  '20k function substitutions': `echo ${`\${ :; }`.repeat(20_000)}`,
  '10k nested function substitutions': `echo ${'"${ echo '.repeat(10_000)}a${'; }"'.repeat(10_000)}`,
  '10k glued group closes': `echo "\${ ${'{ '.repeat(10_000)}:; ${'}'.repeat(10_001)}"`,
  '5000 nested ifs in a substitution': `echo "\${ ${'if :; then '.repeat(5000)}:; ${'fi '.repeat(5000)}}"`,
  '20k unclosed arithmetic brackets': `echo ${'$[ ${x '.repeat(20_000)}`,
  '10k rejected array lines': `${'x=((1)) "\n'.repeat(10_000)}npm i`,
  '20k unclosed substitutions in an expansion': `echo ${'$(${x '.repeat(20_000)}`,
  '10k backticks around open frames': `${'echo `$( $[ <( \'`\n'.repeat(10_000)}npm i`,
  '20k glued expansions': `cat .env${'$x$(true)'.repeat(20_000)} ${'$x'.repeat(20_000)}npm i`,
  '20k CRLF lines': 'echo a\r\n'.repeat(20_000),
  '10k nested defaults': `${`\${x:-`.repeat(10_000)}npm i${'}'.repeat(10_000)}`,
  '20k empty defaults': `${`\${x:-} `.repeat(20_000)}npm i`,
  '10k nested replacements': `${`\${x/a/`.repeat(10_000)}npm i${'}'.repeat(10_000)}`,
  '20k replacements': `${`\${x/a/b}; `.repeat(20_000)}true`,
  '20k shell modes': `${'pnpm -c exec "x y"; '.repeat(20_000)}true`,
  '20k wrapper strings': `${'flock /tmp/l -c "x y"; '.repeat(20_000)}true`,
}
for (const [name, cmd] of Object.entries(BUDGET)) {
  const started = performance.now()
  for (const seg of segments(cmd))
    resolveHead(tokenize(seg))
  const took = performance.now() - started
  if (took > 500)
    fails.push(`[lexer] ${name} took ${Math.round(took)} ms, want under 500`)
}
// The same budget for the secret guard's verdict, which turns a glob into a regex and expands
// braces: one `.*` per star once made 20 stars take 20 s, and a regex over a run of `{` was
// quadratic. Twenty stars, not more, so a regression fails in about 20 s per case rather than
// hanging the suite. Each verdict still denies the .env beside the slow word.
const STARS = '*'.repeat(20)
const VERDICT_BUDGET: Record<string, { cmd: string, expect: 0 | 2 }> = {
  '20 stars': { cmd: `cat .${STARS}z .env`, expect: D },
  '20 stars alone': { cmd: `cat .${STARS}z`, expect: A },
  '20 stars in a redirect': { cmd: `cat <.${STARS}z <.env`, expect: D },
  '20 stars in a find pattern': { cmd: `find . -name '.${STARS}z' -o -name .env -exec cat {} +`, expect: D },
  '20 stars in an option value': { cmd: `grep -r x --include=.${STARS}z --include=.env .`, expect: D },
  '100k open braces': { cmd: `cat ${'{'.repeat(100_000)} .env`, expect: D },
  '100k brace members': { cmd: `cat {${'a,'.repeat(50_000)}} .env`, expect: D },
}
for (const [name, { cmd, expect }] of Object.entries(VERDICT_BUDGET)) {
  const started = performance.now()
  const got = secretReads(cmd, { cwd: process.cwd(), env: process.env, settingsFile: join(HOOKS, '..', 'settings.json') }) === null ? A : D
  const took = performance.now() - started
  if (took > 500)
    fails.push(`[deny-secret-reads.mts] ${name} took ${Math.round(took)} ms, want under 500`)
  if (got !== expect)
    fails.push(`[deny-secret-reads.mts] ${name}: got ${got}, want ${expect}`)
}
/** A run's stderr as a suffix for its failure line, which then names the guard or the error. */
function stderrNote(stderr: string): string {
  const text = stderr.trim()
  return text === '' ? '' : ` (stderr: ${text.slice(0, 300)})`
}
for (const c of CASES) {
  const env: Record<string, string | undefined> = { ...process.env, PROTECTED_BRANCHES: 'main', ...c.env }
  for (const name of c.unset ?? [])
    delete env[name]
  if (c.guard === 'dispatch.mts') {
    const json = c.raw ?? JSON.stringify({ ...c.extra, tool_name: c.tool ?? 'Bash', tool_input: { command: c.cmd } })
    const r = spawnSync(process.execPath, [join(c.hooksDir ?? TEMPLATE_HOOKS, c.guard)], { input: json, cwd: c.cwd ?? DEFAULT_CWD, env, encoding: 'utf8' })
    if (r.status !== c.expect)
      fails.push(`[${c.guard}] got ${r.status ?? 'null'}, want ${c.expect}: ${c.cmd}${stderrNote(r.stderr)}`)
    continue
  }
  const ctx: GuardContext = { cwd: c.cwd ?? DEFAULT_CWD, env, settingsFile: join(c.hooksDir ?? HOOKS, '..', 'settings.json') }
  const why = VERDICTS[c.guard](c.cmd, ctx)
  const got = why === null ? A : D
  if (got !== c.expect)
    fails.push(`[${c.guard}] got ${got}${why ? ` (${why})` : ''}, want ${c.expect}: ${c.cmd}`)
}

// A dispatcher that cannot start must still deny: no harness blocks on exit 1, and Claude Code
// and Codex block only on exit 2, so any other failure runs the tool call. Node told not to strip
// types fails the way a node too old for .mts does, an empty project directory stands in for a
// missing file, and a PATH without node for a missing node. Each registration runs the way its
// harness runs it: Claude Code hands its command to sh, or to PowerShell when Git Bash is missing,
// after putting the project path, here the template project's, in for the placeholder. A shell or
// a pnpm this machine lacks is skipped and named in the summary.
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
const claudeCommands = TEMPLATE.claudeGuard.handlers.map(h => h.command ?? '')
const payload = (cmd: string): string => JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } })
const runs = (bin: string, args: string[]): boolean => spawnSync(bin, args, { stdio: 'ignore', timeout: 20_000 }).status === 0
const launchSkipped: string[] = []
let launchRuns = 0
function launched(where: string, c: LaunchCase, status: number | null, stdout = '', stderr = ''): void {
  launchRuns++
  if (status !== c.expect)
    fails.push(`[launch] ${where}, ${c.name}: got ${status ?? 'null'}, want ${c.expect}${stderrNote(stderr)}`)
  if (stdout !== '')
    fails.push(`[launch] ${where}, ${c.name}: stdout should be empty, got ${stdout.slice(0, 80)}`)
}
const SHELLS = ['sh', 'pwsh', 'powershell'].filter((shell) => {
  const ok = shell === 'sh' ? runs('sh', ['-c', 'exit 0']) : runs(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])
  if (!ok)
    launchSkipped.push(shell)
  return ok
})
const shellArgs = (shell: string, command: string): string[] => shell === 'sh' ? ['-c', command] : ['-NoProfile', '-NonInteractive', '-Command', command]
for (const shell of SHELLS) {
  for (const command of claudeCommands) {
    for (const c of LAUNCH_CASES) {
      const project = c.project ?? TEMPLATE_PROJECT
      const env = { ...process.env, PROTECTED_BRANCHES: 'main', ...c.env, CLAUDE_PROJECT_DIR: project }
      const r = spawnSync(shell, shellArgs(shell, shell === 'sh' ? command : command.replaceAll(PLACEHOLDER, project)), { input: payload(c.cmd), env, timeout: 20_000, encoding: 'utf8' })
      launched(`Claude Code under ${shell}`, c, r.status, '', r.stderr ?? '')
    }
    if (shell === 'sh' && process.platform !== 'win32') {
      const c: LaunchCase = { name: 'node not installed', cmd: 'pnpm install', expect: D }
      const env = { ...process.env, PATH: EMPTY_PROJECT, CLAUDE_PROJECT_DIR: TEMPLATE_PROJECT }
      const r = spawnSync('/bin/sh', ['-c', command], { input: payload(c.cmd), env, timeout: 20_000, encoding: 'utf8' })
      launched('Claude Code under sh', c, r.status, '', r.stderr ?? '')
    }
  }
}

// Codex and Gemini run the commands in their registrations from wherever the session sits, here a
// subdirectory (of the template project, for a guard command). Codex uses the session's shell:
// sh, bash, or zsh with -c, and on Windows PowerShell with commandWindows in place of command. Gemini uses bash -c (here sh where bash is
// missing and on Windows), or PowerShell with its own exit suffix appended; Gemini parses stdout,
// so a guard run leaves it empty. `pnpm run` sets pnpm_config_verify_deps_before_run=false for
// the scripts it starts, this suite included, which would hide a registration that lets pnpm
// install first, so the spawned env drops it. Two directories must answer fast and install
// nothing: one outside any workspace, where pnpm exits 1 before the script and the command must
// deny, and a workspace never installed, with no reachable registry, where pnpm without the flag
// installs first and exits 1, so its deny and allow payloads must still give 2 and 0.
interface PnpmCase extends LaunchCase { cwd: string, root?: string }
const STALE = join(tmp, 'stale-workspace')
mkdirSync(join(STALE, 'sub'), { recursive: true })
claudeCopy(join(STALE, '.claude'))
writeFileSync(join(STALE, 'package.json'), `${JSON.stringify({ name: 'stale', private: true, scripts: { guards: rootPackage.scripts?.guards, session: rootPackage.scripts?.session }, devDependencies: { 'is-number': '7.0.0' } })}\n`)
writeFileSync(join(STALE, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
const OFFLINE = { pnpm_config_registry: 'http://127.0.0.1:9/', pnpm_config_fetch_retries: '0', pnpm_config_store_dir: join(tmp, 'pnpm-store') }
const PNPM_DENY: PnpmCase = { name: 'deny', cmd: 'npm install', expect: D, cwd: TEMPLATE_HOOKS }
const PNPM_ALLOW: PnpmCase = { name: 'allow', cmd: 'pnpm install', expect: A, cwd: TEMPLATE_HOOKS }
const PNPM_CASES: PnpmCase[] = [
  PNPM_DENY,
  PNPM_ALLOW,
  { name: 'node cannot load .mts', cmd: 'pnpm install', expect: D, cwd: TEMPLATE_HOOKS, env: { NODE_OPTIONS: '--no-experimental-strip-types' } },
  { name: 'pnpm fails before the script', cmd: 'pnpm install', expect: D, cwd: EMPTY_PROJECT, root: EMPTY_PROJECT },
  { name: 'workspace never installed, deny', cmd: 'npm install', expect: D, cwd: join(STALE, 'sub'), env: OFFLINE, root: STALE },
  { name: 'workspace never installed, allow', cmd: 'pnpm install', expect: A, cwd: join(STALE, 'sub'), env: OFFLINE, root: STALE },
]
const SESSION_LAUNCHES: PnpmCase[] = [
  { name: 'installed workspace', cmd: '', expect: A, cwd: HOOKS },
  { name: 'workspace never installed', cmd: '', expect: A, cwd: join(STALE, 'sub'), env: OFFLINE, root: STALE },
]
const GEMINI_POWERSHELL_SUFFIX = '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
function pnpmEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PROTECTED_BRANCHES: 'main', ...extra }
  for (const name of Object.keys(env)) {
    if (/^p?npm_config_verify_deps_before_run$/i.test(name))
      delete env[name]
  }
  return env
}
/** The absolute path of `bin`, so a run with PATH emptied still starts it; '' when missing, and always on Windows. */
function shellPath(bin: string): string {
  if (process.platform === 'win32')
    return ''
  return (spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '').trim()
}
/** Runs `argv` from the case's `cwd`; for a case with a `root`, also checks it is fast and installs nothing. */
function pnpmRun(where: string, c: PnpmCase, argv: string[], opts: { env?: Record<string, string | undefined>, shell?: boolean } = {}): { status: number | null, stdout: string, stderr: string } {
  const started = performance.now()
  const r = spawnSync(argv[0] ?? '', argv.slice(1), { cwd: c.cwd, input: payload(c.cmd), env: opts.env ?? pnpmEnv(c.env), encoding: 'utf8', timeout: 20_000, shell: opts.shell ?? false })
  const took = performance.now() - started
  if (c.root !== undefined && took > 5000)
    fails.push(`[launch] ${where}, ${c.name}: took ${Math.round(took)} ms, want under 5000`)
  if (c.root !== undefined && existsSync(join(c.root, 'node_modules'))) {
    fails.push(`[launch] ${where}, ${c.name}: pnpm installed into ${c.root}`)
    rmSync(join(c.root, 'node_modules'), { recursive: true, force: true })
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
if (spawnSync('pnpm --version', { shell: true, stdio: 'ignore', timeout: 20_000 }).status === 0) {
  const BASH = shellPath('bash')
  const CODEX_POSIX = { name: 'sh', bin: process.platform === 'win32' ? 'sh' : '/bin/sh' }
  const GEMINI_POSIX = BASH === '' ? CODEX_POSIX : { name: 'bash', bin: BASH }
  const hosts = [
    ...codexGuards.map(h => ({ where: 'Codex', posix: CODEX_POSIX, sh: h.command ?? '', powershell: h.commandWindows ?? h.command ?? '' })),
    ...geminiGuards.map(h => ({ where: 'Gemini', posix: GEMINI_POSIX, sh: h.command ?? '', powershell: `${h.command ?? ''}${GEMINI_POWERSHELL_SUFFIX}` })),
  ]
  const sessionHosts = [
    ...codexSessions.map(h => ({ where: 'Codex session', posix: CODEX_POSIX, sh: h.command ?? '', powershell: h.commandWindows ?? h.command ?? '' })),
    ...geminiSessions.map(h => ({ where: 'Gemini session', posix: GEMINI_POSIX, sh: h.command ?? '', powershell: `${h.command ?? ''}${GEMINI_POWERSHELL_SUFFIX}` })),
  ]
  // A missing pnpm is a PATH that holds only sh, which Codex's `command` hands the pnpm call to,
  // with each shell started by its absolute path. Off Windows only, where the suite can build that
  // PATH from nothing but the machine's /bin/sh.
  const PNPM_MISSING: PnpmCase = { name: 'pnpm not installed', cmd: 'pnpm install', expect: D, cwd: TEMPLATE_HOOKS }
  const ONLY_SH = join(tmp, 'only-sh')
  mkdirSync(ONLY_SH)
  if (process.platform !== 'win32')
    symlinkSync('/bin/sh', join(ONLY_SH, 'sh'))
  const noPnpm = { env: { ...pnpmEnv(), PATH: ONLY_SH } }
  const launchedNoPnpm = (where: string, argv: string[]): void => {
    const r = pnpmRun(where, PNPM_MISSING, argv, noPnpm)
    launched(where, PNPM_MISSING, r.status, r.stdout, r.stderr)
  }
  for (const shell of SHELLS) {
    const powershellPath = shell === 'sh' ? '' : shellPath(shell)
    for (const host of hosts) {
      const where = `${host.where} under ${shell === 'sh' ? host.posix.name : shell}`
      const argv = shell === 'sh' ? [host.posix.bin, '-c', host.sh] : [shell, ...shellArgs(shell, host.powershell)]
      for (const c of PNPM_CASES) {
        const r = pnpmRun(where, c, argv)
        launched(where, c, r.status, r.stdout, r.stderr)
      }
      if (shell === 'sh' && process.platform !== 'win32')
        launchedNoPnpm(where, argv)
      else if (powershellPath !== '')
        launchedNoPnpm(where, [powershellPath, ...shellArgs(shell, host.powershell)])
    }
    // A session command exits 0 with the writing rules, in a workspace never installed too.
    for (const host of sessionHosts) {
      const where = `${host.where} under ${shell === 'sh' ? host.posix.name : shell}`
      for (const c of SESSION_LAUNCHES) {
        launchRuns++
        const r = pnpmRun(where, c, shell === 'sh' ? [host.posix.bin, '-c', host.sh] : [shell, ...shellArgs(shell, host.powershell)])
        for (const p of sessionProblems({ name: c.name, raw: '', context: true }, r.status, r.stdout, r.stderr))
          fails.push(`[launch] ${where}, ${c.name}: ${p}`)
      }
    }
  }
  // With no single local environment, Codex runs a hook through `$SHELL -lc` off Windows, and that
  // login shell may be fish, which cannot parse the exit tail, or nushell, which has no `||`. So
  // Codex's `command` runs under both too, without the user's config, which could put pnpm back
  // on the PATH that leaves it out.
  for (const login of [{ name: 'fish', noConfig: '--no-config' }, { name: 'nu', noConfig: '--no-config-file' }]) {
    const bin = shellPath(login.name)
    const loginRuns = bin !== '' && runs(bin, [login.noConfig, '-c', 'exit 0'])
    if (process.platform !== 'win32' && !loginRuns)
      launchSkipped.push(login.name)
    for (const h of loginRuns ? codexGuards : []) {
      const where = `Codex under ${login.name}`
      const argv = [bin, login.noConfig, '-c', h.command ?? '']
      for (const c of PNPM_CASES) {
        const r = pnpmRun(where, c, argv)
        launched(where, c, r.status, r.stdout, r.stderr)
      }
      launchedNoPnpm(where, argv)
    }
  }
  // With no PowerShell, or no single local environment, Codex on Windows runs the command through
  // cmd.exe /C, which reads neither `;` nor the tail and hands them to pnpm as words; pnpm passes
  // them on to the script after `|| exit 2`, so a deny still exits 2. Off Windows, the suite hands
  // pnpm the same words directly.
  for (const h of codexGuards) {
    const command = h.commandWindows ?? h.command ?? ''
    for (const c of [PNPM_DENY, PNPM_ALLOW]) {
      const r = process.platform === 'win32' ? pnpmRun('Codex under cmd.exe', c, [command], { shell: true }) : pnpmRun('Codex under cmd.exe', c, command.split(' '))
      launched('Codex under cmd.exe', c, r.status, r.stdout, r.stderr)
    }
  }
}
else {
  launchSkipped.push('pnpm')
}

// A harness that opens stdin and never closes it must not hang the tool call: the dispatcher
// denies after its timeout, the session hook still prints its context and exits 0. Async on
// purpose — spawnSync would close the child's stdin. The timeout covers only the delivery of
// the input, so a guard slower than it, here one that sleeps past it in a copy of the hooks,
// still returns its own verdict. All three start before any is awaited, so the suite waits
// once for the 5s backstop, not three times.
const SLOW_CLAUDE = claudeCopy(join(tmp, 'slow-claude'))
writeFileSync(join(SLOW_CLAUDE, 'hooks', 'deny-zz-slow.mts'), 'export const verdict = () => {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500)\n  return null\n}\n')
const hung = spawn(process.execPath, [join(TEMPLATE_HOOKS, 'dispatch.mts')], { stdio: ['pipe', 'ignore', 'ignore'] })
const hungSession = spawn(process.execPath, [join(HOOKS, SESSION)], { stdio: ['pipe', 'pipe', 'ignore'] })
const slow = spawn(process.execPath, [join(SLOW_CLAUDE, 'hooks', 'dispatch.mts')], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PROTECTED_BRANCHES: 'main' } })
let hungSessionOut = ''
let slowErr = ''
hungSession.stdout.on('data', (d) => {
  hungSessionOut += d
})
slow.stderr.on('data', (d) => {
  slowErr += d
})
slow.stdin.end(payload('pnpm install'))
const [hungStatus, hungSessionStatus, slowStatus] = await Promise.all([
  new Promise<number | null>(resolve => hung.on('exit', resolve)),
  new Promise<number | null>(resolve => hungSession.on('close', resolve)),
  new Promise<number | null>(resolve => slow.on('close', resolve)),
])
if (hungStatus !== 2)
  fails.push(`[dispatch.mts] stdin never closed: got ${hungStatus ?? 'null'}, want 2 (timeout deny)`)
for (const p of sessionProblems({ name: 'stdin never closed', raw: '', context: true }, hungSessionStatus, hungSessionOut, ''))
  fails.push(`[${SESSION}] stdin never closed: ${p}`)
if (slowStatus !== 0 || slowErr !== '')
  fails.push(`[dispatch.mts] a guard slower than the stdin timeout: got ${slowStatus ?? 'null'}${slowErr ? ` (${slowErr.trim()})` : ''}, want 0 and no output`)

if (fails.length > 0) {
  console.error(`\n✖ hook fixtures — ${fails.length} of ${CASES.length + LEXER_CASES.length + Object.keys(BUDGET).length + Object.keys(VERDICT_BUDGET).length + SESSION_CASES.length + REGISTRATION_CASES.length + launchRuns + 3} failed:\n`)
  for (const f of fails)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
const skippedNote = launchSkipped.length > 0 ? ` (${launchSkipped.join(', ')} not installed, skipped)` : ''
console.log(`✔ hook fixtures — ${CASES.length} guard cases + ${LEXER_CASES.length} lexer cases + ${Object.keys(BUDGET).length} lexer time budgets + ${Object.keys(VERDICT_BUDGET).length} verdict time budgets + ${SESSION_CASES.length} session cases + ${launchRuns} launch runs${skippedNote} + both stdin timeouts + a slow guard + the three registrations + ${REGISTRATION_CASES.length} registration cases pass`)
