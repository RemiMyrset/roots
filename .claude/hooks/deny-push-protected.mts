/**
 * deny-push-protected guard body (run via dispatch.mts). Blocks a `git push` whose target is
 * a protected branch, any bare-force / --all / --mirror / wildcard-refspec push, and the release script (its push
 * happens inside changelogen, invisible to a `git push` rule). Protected patterns come from
 * PROTECTED_BRANCHES (comma-separated globs, `*` matches any run of characters) in the
 * `env` block of .claude/settings.json; unset means `main`. Implicit targets (`git push`,
 * `HEAD`) resolve through `git symbolic-ref` in the cwd; an unresolvable target is denied.
 * Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md. exit 2 = deny.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { base, commandOf, exit, gitSubcommand, PNPM_VALUE_FLAG, resolveHead, run, segments, tokenize, unquote } from './_lexer.mts'

const ENV_VAR = 'PROTECTED_BRANCHES'

// The list comes from the environment (Claude Code exports the `env` block of
// .claude/settings.json) or, when unset, from that file directly — Codex and Gemini CLI
// register the same dispatcher but never read the env block, so all three tools share
// one list with no shell-specific env prefix. Located from this file, not cwd.
function configuredList(): string {
  const fromEnv = process.env[ENV_VAR]
  if (fromEnv !== undefined)
    return fromEnv
  try {
    const settings = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'settings.json'), 'utf8')) as { env?: { PROTECTED_BRANCHES?: unknown } }
    const value = settings.env?.PROTECTED_BRANCHES
    return typeof value === 'string' ? value : ''
  }
  catch {
    return ''
  }
}
const configured = configuredList().split(',').map(p => p.trim()).filter(Boolean)
const PATTERNS = configured.length > 0 ? configured : ['main']
const PROTECTED = PATTERNS.map(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))

function isProtected(ref: string): boolean {
  const short = ref.replace(/^refs\/heads\//, '')
  return PROTECTED.some(re => re.test(ref) || re.test(short))
}

function currentBranch(): string | null {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || null
}

// `git push` options that take a separate value token. `--recurse-submodules` is not one:
// git accepts only its `=value` spelling, so treating it as separate would consume the
// remote and shift the target.
const PUSH_VALUE_OPT: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

// Returns the deny reason for a `git push` argv (tokens after `push`), or null to allow.
function pushVerdict(args: string[]): string | null {
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
    const cur = currentBranch()
    if (!cur)
      return 'the current branch could not be resolved (detached HEAD or not a git checkout), so the push target is unknown'
    targets.push(cur)
  }
  for (let t of targets) {
    if (t === 'HEAD') {
      const cur = currentBranch()
      if (!cur)
        return 'HEAD is not on a branch, so the push target is unknown'
      t = cur
    }
    if (isProtected(t))
      return `"${t}" is a protected branch (${ENV_VAR}="${PATTERNS.join(',')}" in .claude/settings.json env; default "main"). Push a feature branch and open a PR instead`
  }
  return null
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

run((s) => {
  const cmd = commandOf(s)
  if (cmd === null) {
    process.stderr.write('push guard: hook input is not a pre-tool payload with tool_input.command; denying by default (fail closed).\n')
    exit(2)
  }
  const deny = (why: string): never => {
    process.stderr.write(`Blocked: ${why}.\n`)
    exit(2)
  }
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const { i, head, probe } = resolveHead(toks)
    if (probe)
      continue
    if (head === 'git') {
      const { sub, args } = gitSubcommand(toks, i)
      if (sub !== 'push')
        continue
      const why = pushVerdict(args)
      if (why)
        deny(why)
    }
    if (head === 'pnpm' && pnpmScript(toks, i) === 'release')
      deny('`pnpm release` pushes to the default branch from inside changelogen. Human-only: prepare the release (release skill) and let the user run it')
    // changelogen at the head (directly, via pnpm exec/dlx unwrapping, or behind npx).
    const cl = head === 'changelogen' ? i : head === 'npx' && base(toks[i + 1] ?? '') === 'changelogen' ? i + 1 : -1
    if (cl >= 0 && toks.slice(cl + 1).some(t => unquote(t) === '--push'))
      deny('`changelogen --push` pushes to the default branch. Human-only: run it yourself in a terminal')
  }
  exit(0)
})
