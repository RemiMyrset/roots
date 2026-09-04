/**
 * deny-push-protected guard body (run via dispatch.mts). Blocks a `git push` whose target is
 * a protected branch, any bare-force / --all / --mirror push, and the release script (its push
 * happens inside changelogen, invisible to a `git push` rule). Protected patterns come from
 * PROTECTED_BRANCHES (comma-separated globs, `*` matches any run of characters) in the
 * `env` block of .claude/settings.json; unset means `main`. Implicit targets (`git push`,
 * `HEAD`) resolve through `git symbolic-ref` in the cwd; an unresolvable target is denied.
 * Shared lexing in ./_lexer.mts. Scope and out-of-scope: SECURITY.md. exit 2 = deny.
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { base, PNPM_VALUE_FLAG, resolveHead, segments, tokenize, unquote } from './_lexer.mts'

const ENV_VAR = 'PROTECTED_BRANCHES'
const configured = (process.env[ENV_VAR] ?? '').split(',').map(p => p.trim()).filter(Boolean)
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

// `git` global options that take a SEPARATE value token (the `--opt=value` spelling is one token).
const GIT_VALUE_OPT: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])
// `git push` options that take a separate value token.
const PUSH_VALUE_OPT: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--recurse-submodules'])

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

// Subcommand + its args after `git` and any global options (`git -C x -c k=v push …`).
function gitSubcommand(toks: string[], i: number): [sub: string, args: string[]] {
  let k = i + 1
  while (k < toks.length) {
    const t = unquote(toks[k]!)
    if (!t.startsWith('-'))
      break
    k++
    if (GIT_VALUE_OPT.has(t))
      k++
  }
  return [unquote(toks[k] ?? ''), toks.slice(k + 1)]
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

let s = ''
process.stdin.on('data', (d) => { s += d }).on('end', () => {
  let cmd: string
  try {
    cmd = String((JSON.parse(s).tool_input || {}).command || '')
  }
  catch {
    process.stderr.write('push guard: could not parse hook input as JSON; denying by default (fail closed).\n')
    process.exit(2)
  }
  const deny = (why: string): never => {
    process.stderr.write(`Blocked: ${why}.\n`)
    process.exit(2)
  }
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const { i, head, probe } = resolveHead(toks)
    if (probe)
      continue
    if (head === 'git') {
      const [sub, args] = gitSubcommand(toks, i)
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
  process.exit(0)
})
