/**
 * deny-push-protected guard (imported by dispatch.mts). Blocks a `git push` whose target is
 * a protected branch, any bare-force / --all / --mirror / wildcard-refspec push, and the release script (its push
 * happens inside changelogen, invisible to a `git push` rule). Protected patterns come from
 * PROTECTED_BRANCHES (comma-separated globs, `*` matches any run of characters) in the
 * `env` block of .claude/settings.json; unset means `main`. Implicit targets (`git push`,
 * `HEAD`) resolve through `git symbolic-ref` in the cwd; an unresolvable target is denied.
 * Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { GuardContext, Verdict } from './_lexer.mts'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { base, gitSubcommand, PNPM_VALUE_FLAG, resolveHead, segments, tokenize, unquote } from './_lexer.mts'

const ENV_VAR = 'PROTECTED_BRANCHES'

// The list comes from the environment (Claude Code exports the `env` block of
// .claude/settings.json) or, when unset, from that file directly — Codex and Gemini CLI
// register the same dispatcher but never read the env block, so all three tools share
// one list with no shell-specific env prefix. The file is the one the dispatcher names.
function configuredList(ctx: GuardContext): string {
  const fromEnv = ctx.env[ENV_VAR]
  if (fromEnv !== undefined)
    return fromEnv
  try {
    const settings = JSON.parse(readFileSync(ctx.settingsFile, 'utf8')) as { env?: { PROTECTED_BRANCHES?: unknown } }
    const value = settings.env?.PROTECTED_BRANCHES
    return typeof value === 'string' ? value : ''
  }
  catch {
    return ''
  }
}

interface Protection { patterns: string[], test: (ref: string) => boolean }

function protection(ctx: GuardContext): Protection {
  const configured = configuredList(ctx).split(',').map(p => p.trim()).filter(Boolean)
  const patterns = configured.length > 0 ? configured : ['main']
  const res = patterns.map(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
  return {
    patterns,
    test: (ref) => {
      const short = ref.replace(/^refs\/heads\//, '')
      return res.some(re => re.test(ref) || re.test(short))
    },
  }
}

function currentBranch(cwd: string): string | null {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || null
}

// `git push` options that take a separate value token. `--recurse-submodules` is not one:
// git accepts only its `=value` spelling, so treating it as separate would consume the
// remote and shift the target.
const PUSH_VALUE_OPT: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

// Returns the deny reason for a `git push` argv (tokens after `push`), or null to allow.
function pushVerdict(args: string[], ctx: GuardContext): string | null {
  const protectedRefs = protection(ctx)
  let remote: string | undefined
  const refspecs: string[] = []
  let del = false
  let tags = false
  let i = 0
  for (; i < args.length; i++) {
    const t = unquote(args[i]!)
    if (t === '--') { refspecs.push(...args.slice(i + 1).map(unquote)); break }
    if (t.startsWith('--')) {
      const name = t.split('=')[0]!
      if (name === '--all' || name === '--branches' || name === '--mirror')
        return `\`git push ${name}\` pushes every branch, protected ones included`
      if (name === '--force')
        return 'bare `--force` is denied; use `--force-with-lease` on an unprotected branch'
      if (name === '--delete')
        del = true
      if (name === '--tags')
        tags = true
      if (PUSH_VALUE_OPT.has(name) && !t.includes('='))
        i++
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      if (t.includes('f'))
        return 'bare `-f` is denied; use `--force-with-lease` on an unprotected branch'
      if (t.includes('d'))
        del = true
      if (t.endsWith('o'))
        i++
      continue
    }
    if (remote === undefined)
      remote = t
    else
      refspecs.push(t)
  }
  // A URL or a path as the remote sidesteps the configured remotes and the list this guard
  // protects; only a named remote (origin, upstream) is allowed.
  if (remote !== undefined && (/:\/\//.test(remote) || /^[^/]+@[^/]+:/.test(remote) || remote.includes('/')))
    return `"${remote}" is a URL or path, not a configured remote; pushing there bypasses the protected-branch list. Use a named remote`
  const targets: string[] = []
  for (const spec of refspecs) {
    if (spec.startsWith('+'))
      return `\`+${spec.slice(1)}\` is a force push; use --force-with-lease on an unprotected branch`
    // A wildcard refspec can match a protected branch and this guard cannot evaluate the
    // glob against the remote, so it is denied outright.
    if (spec.includes('*'))
      return `\`${spec}\` is a wildcard refspec; it can match a protected branch, so it is denied outright`
    const [src, dst] = spec.split(':') as [string, string?]
    const target = del ? src : (dst ?? src)
    if (target === '' || target.startsWith('refs/tags/'))
      continue
    targets.push(target)
  }
  if (refspecs.length === 0 && !tags) {
    const cur = currentBranch(ctx.cwd)
    if (!cur)
      return 'the current branch could not be resolved (detached HEAD or not a git checkout), so the push target is unknown'
    targets.push(cur)
  }
  for (let t of targets) {
    if (t === 'HEAD') {
      const cur = currentBranch(ctx.cwd)
      if (!cur)
        return 'HEAD is not on a branch, so the push target is unknown'
      t = cur
    }
    if (protectedRefs.test(t))
      return `"${t}" is a protected branch (${ENV_VAR}="${protectedRefs.patterns.join(',')}" in .claude/settings.json env; default "main"). Push a feature branch and open a PR instead`
  }
  return null
}

// npx flags that take a separate value; `-c`/`--call` is a nested command string, out of scope.
const NPX_VALUE_FLAG: ReadonlySet<string> = new Set(['-p', '--package'])

// `changelogen` in any spelling that runs it: bare, path-prefixed, or with an `@version` suffix.
function isChangelogen(t: string): boolean {
  return base(t).replace(/@[^@]*$/, '') === 'changelogen'
}

// Index of the changelogen word: at the head (directly, or via pnpm exec/dlx unwrapping), or
// behind npx and its flags (`npx -y changelogen@latest …`); -1 when absent.
function changelogenAt(toks: string[], i: number, head: string): number {
  if (isChangelogen(toks[i] ?? ''))
    return i
  if (head !== 'npx')
    return -1
  let k = i + 1
  while (k < toks.length) {
    const t = unquote(toks[k]!)
    if (!t.startsWith('-'))
      break
    k++
    if (NPX_VALUE_FLAG.has(t))
      k++
  }
  return isChangelogen(toks[k] ?? '') ? k : -1
}

// First pnpm script/subcommand after global flags, unwrapping `run`.
function pnpmScript(toks: string[], i: number): string {
  let k = i + 1
  while (k < toks.length) {
    const t = unquote(toks[k]!)
    if (t.startsWith('-')) { if (PNPM_VALUE_FLAG.has(t)) k++; k++; continue }
    if (t === 'run' || t === 'run-script') { k++; continue }
    return t
  }
  return ''
}

/** Denies a push whose target is protected, any whole-repo or bare-force push, and the release script. */
export const verdict: Verdict = (cmd, ctx) => {
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const { i, head, probe } = resolveHead(toks)
    if (probe)
      continue
    if (head === 'git') {
      const { sub, args } = gitSubcommand(toks, i)
      if (sub !== 'push')
        continue
      const why = pushVerdict(args, ctx)
      if (why)
        return `${why}.`
    }
    if (head === 'pnpm' && pnpmScript(toks, i) === 'release')
      return '`pnpm release` pushes to the default branch from inside changelogen. Human-only: prepare the release (release skill) and let the user run it.'
    const cl = changelogenAt(toks, i, head)
    if (cl >= 0 && toks.slice(cl + 1).some(t => unquote(t) === '--push'))
      return '`changelogen --push` pushes to the default branch. Human-only: run it yourself in a terminal.'
  }
  return null
}
