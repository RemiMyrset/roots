/**
 * deny-push-protected guard (imported by dispatch.mts). Blocks a `git push` whose target is
 * a protected branch, any bare-force / --all / --mirror / wildcard-refspec / matching (`:`) push,
 * a push to anything but a configured remote, and the release script (its push happens inside
 * changelogen, invisible to a `git push` rule). Protected patterns come from
 * PROTECTED_BRANCHES (comma-separated globs, `*` matches any run of characters) in the
 * `env` block of .claude/settings.json; unset means `main`. Implicit targets (`git push`,
 * `HEAD`, `@`, a lone command substitution) resolve through `git symbolic-ref` in the cwd; an
 * unresolvable target is denied, and so is one bash expands into a value unknown here: a remote
 * or refspec holding a shell variable (`"$BRANCH"`), and any word holding a brace list
 * (`{develop,main}`). Redirections are not refspecs: bash never passes them to git. A command
 * in the same call that changes the branch, the remotes, or the directory (`git switch`,
 * `git checkout`, `git worktree`, `gh pr checkout`, `git remote add`, `cd`) has not run when the
 * guard resolves a target, so in such a call an implicit target or an unconfigured remote is
 * unknown, wherever the move sits.
 * Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { GuardContext, Verdict } from './_lexer.mts'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { base, gitSubcommand, PNPM_VALUE_FLAG, resolveHead, segments, SUBST, tokenize, unquote, withoutRedirects } from './_lexer.mts'

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

// A destination as a branch name: git reads `heads/main` and `refs/heads/main` as `main`.
function branchName(ref: string): string {
  return ref.replace(/^(?:refs\/)?heads\//, '')
}

function protection(ctx: GuardContext): Protection {
  const configured = configuredList(ctx).split(',').map(p => p.trim()).filter(Boolean)
  const patterns = configured.length > 0 ? configured : ['main']
  const res = patterns.map(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`))
  return {
    patterns,
    test: (ref) => {
      const short = branchName(ref)
      return res.some(re => re.test(ref) || re.test(short))
    },
  }
}

function currentBranch(cwd: string): string | null {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || null
}

// Whether the cwd's git config gives the remote a URL. git reads a name it has no remote for
// as a path (`git push mirror feat/x` pushes into ./mirror), so only a configured one counts.
function configuredRemote(name: string, cwd: string): boolean {
  return spawnSync('git', ['config', '--get', `remote.${name}.url`], { cwd, stdio: 'ignore' }).status === 0
}

// A word as tokenize() leaves it (quotes kept) with the text bash takes literally blanked to NUL:
// what single quotes and `$'…'` hold, and what double quotes hold too unless `dq` is set, since
// bash still expands a variable there but never a brace list. The quotes themselves are dropped.
function expandable(raw: string, dq: boolean): string {
  let out = ''
  let q = ''
  for (let n = 0; n < raw.length; n++) {
    const c = raw[n]!
    if (q === '\'' || q === '$') {
      if (q === '$' && c === '\\')
        n++
      if (c === '\'')
        q = ''
      else
        out += '\0'
    }
    else if (q === '"') {
      if (c === '"')
        q = ''
      else
        out += dq ? c : '\0'
    }
    else if (c === '$' && raw[n + 1] === '\'') {
      q = '$'
      n++
    }
    else if (c === '\'' || c === '"') {
      q = c
    }
    else {
      out += c
    }
  }
  return out
}

// Whether bash expands a shell variable in a word: a `$` before a name, a digit, a special
// parameter, or a `{`, outside single quotes and `$'…'`. A command substitution (SUBST) is not
// one; the target loop judges it.
function holdsVariable(raw: string): boolean {
  return /\$[\w{@*#?!$-]/.test(expandable(raw, true))
}

// Whether bash turns a word into several by brace expansion: an unquoted `{` and its `}` with a
// `,` or `..` between them and no other brace (`{develop,main}`, `{a..c}`, the inner list of a
// nested one). A `${…}` is a parameter expansion, which bash never brace-expands. A linear scan:
// the obvious regex backtracks quadratically over a long run of commas with no `}`.
function holdsBraceList(raw: string): boolean {
  const s = expandable(raw, false)
  let open = false
  let list = false
  let param = 0
  for (let n = 0; n < s.length; n++) {
    const c = s[n]!
    if (param > 0) {
      param += c === '{' ? 1 : c === '}' ? -1 : 0
    }
    else if (c === '{' && s[n - 1] === '$') {
      param = 1
      open = false
    }
    else if (c === '{') {
      open = true
      list = false
    }
    else if (c === '}') {
      if (open && list)
        return true
      open = false
    }
    else if (open && (c === ',' || (c === '.' && s[n + 1] === '.'))) {
      list = true
    }
  }
  return false
}

// `git push` options that take a separate value token. `--recurse-submodules` is not one:
// git accepts only its `=value` spelling, so treating it as separate would consume the
// remote and shift the target.
const PUSH_VALUE_OPT: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
// git push's long options. git takes any unique prefix of one (`--al` is `--all`, `--mirr`
// `--mirror`) and rejects an ambiguous one (`--forc`), so a prefix is read as its option.
const PUSH_LONG: readonly string[] = [
  '--verbose',
  '--quiet',
  '--repo',
  '--all',
  '--branches',
  '--mirror',
  '--delete',
  '--tags',
  '--dry-run',
  '--porcelain',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--recurse-submodules',
  '--thin',
  '--receive-pack',
  '--exec',
  '--set-upstream',
  '--progress',
  '--prune',
  '--verify',
  '--follow-tags',
  '--signed',
  '--atomic',
  '--push-option',
  '--ipv4',
  '--ipv6',
]
function longOption(name: string): string {
  if (PUSH_LONG.includes(name))
    return name
  const hits = PUSH_LONG.filter(o => o.startsWith(name))
  return hits.length === 1 ? hits[0]! : name
}

// The reason for an implicit target or a new remote in a call where any command moves.
const MOVED = 'the branch, remote, or directory changes in this command, so the push target is unknown; push in its own call or name the remote and branch'

// Whether a command changes what a push in the same call resolves against: the branch
// (`git switch`, `git checkout`, `git worktree`, `gh pr checkout`), the remotes (`git remote add`
// or `rename`), or the directory (`cd`, `pushd`, `popd`).
function moves(toks: string[], i: number, head: string): boolean {
  if (head === 'cd' || head === 'pushd' || head === 'popd')
    return true
  if (head === 'gh')
    return toks.slice(i + 1, i + 3).map(unquote).join(' ') === 'pr checkout'
  if (head !== 'git')
    return false
  const { sub, args } = gitSubcommand(toks, i)
  return sub === 'switch' || sub === 'checkout' || sub === 'worktree' || (sub === 'remote' && /^(?:add|rename)$/.test(unquote(args[0] ?? '')))
}

// Returns the deny reason for a `git push` argv (tokens after `push`), or null to allow. `moved`
// is set when any command of the call moves (moves()).
function pushVerdict(words: string[], ctx: GuardContext, moved: boolean): string | null {
  const protectedRefs = protection(ctx)
  const args = withoutRedirects(words)
  // A brace list shifts every word after it, so one in any word, an option's value included
  // (`-o {a,b} origin`), leaves the target unknown.
  const braced = args.find(holdsBraceList)
  if (braced !== undefined)
    return `\`${unquote(braced)}\` holds a brace list, which bash expands into several words, so the push target is unknown`
  // The words git reads as the remote and the refspecs, quotes kept, and --repo's value, which
  // names the remote when no word does.
  const positional: string[] = []
  let repo: string | undefined
  let del = false
  let tags = false
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!
    const t = unquote(raw)
    if (rest || !t.startsWith('-') || t === '-') {
      positional.push(raw)
      continue
    }
    if (t === '--') {
      rest = true
      continue
    }
    if (t.startsWith('--')) {
      const name = longOption(t.split('=')[0]!)
      if (name === '--all' || name === '--branches' || name === '--mirror')
        return `\`git push ${name}\` pushes every branch, protected ones included`
      if (name === '--force')
        return 'bare `--force` is denied; use `--force-with-lease` on an unprotected branch'
      if (name === '--delete')
        del = true
      if (name === '--tags')
        tags = true
      if (name === '--repo')
        repo = t.includes('=') ? raw.slice(raw.indexOf('=') + 1) : args[i + 1]
      if (PUSH_VALUE_OPT.has(name) && !t.includes('='))
        i++
      continue
    }
    if (t.includes('f'))
      return 'bare `-f` is denied; use `--force-with-lease` on an unprotected branch'
    if (t.includes('d'))
      del = true
    if (t.endsWith('o'))
      i++
  }
  // git takes the first word as the remote, or --repo's value when no word is left for it.
  const named = positional.length === 0 && repo !== undefined ? [repo] : positional
  // A variable's value is unknown here, and bash may split it into several words, so a remote
  // or a refspec holding one names an unknown target (`"$BRANCH"`, `HEAD:"$TARGET"`,
  // `${B:-main}`), judged whole before any `:` split.
  const variable = named.find(holdsVariable)
  if (variable !== undefined)
    return `"${unquote(variable)}" holds a shell variable, so the push target is unknown; spell the remote and branch out, or push HEAD`
  const [remote, ...refspecs] = named.map(unquote)
  // A URL or a path as the remote sidesteps the configured remotes and the list this guard
  // protects: anything with a `/`, a `\`, or a `:` (`host:repo.git`, `C:\clones\x`), `.`, `..`,
  // and a bare name the cwd has no remote for, which git reads as a path.
  if (remote !== undefined && (/[/\\:]/.test(remote) || remote === '.' || remote === '..'))
    return `"${remote}" is a URL or path, not a configured remote; pushing there bypasses the protected-branch list. Use a named remote`
  if (remote !== undefined && !configuredRemote(remote, ctx.cwd))
    return moved ? MOVED : `"${remote}" is not a remote configured here (\`git remote -v\` lists them), so git reads it as a path; pushing there bypasses the protected-branch list. Use a named remote`
  const targets: string[] = []
  for (const spec of refspecs) {
    if (spec.startsWith('+'))
      return `\`+${spec.slice(1)}\` is a force push; use --force-with-lease on an unprotected branch`
    // `:` is git's matching refspec: it updates every remote branch that has a local branch
    // of the same name, a protected one included.
    if (spec === ':')
      return '`:` pushes every matching branch, protected ones included'
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
    if (moved)
      return MOVED
    const cur = currentBranch(ctx.cwd)
    if (!cur)
      return 'the current branch could not be resolved (detached HEAD or not a git checkout), so the push target is unknown'
    targets.push(cur)
  }
  for (let t of targets) {
    // A lone substitution (`"$(git branch --show-current)"`) names the current branch, as HEAD
    // and its shorthand `@` do; one inside a longer name leaves the target unknown.
    if (t === 'HEAD' || t === '@' || branchName(t) === SUBST) {
      if (moved)
        return MOVED
      const cur = currentBranch(ctx.cwd)
      if (!cur)
        return 'HEAD is not on a branch, so the push target is unknown'
      t = cur
    }
    else if (t.includes(SUBST)) {
      return `"${t}" is built by a command substitution, so the push target is unknown`
    }
    // A parameter expansion (`main${x}`) never gets here: holdsVariable() denied it above.
    if (protectedRefs.test(t))
      return `"${t}" is a protected branch (${ENV_VAR}="${protectedRefs.patterns.join(',')}" in .claude/settings.json env; default "main"). Push a feature branch and open a PR instead`
  }
  return null
}

// `changelogen` in any spelling that runs it: bare, path-prefixed, or with an `@version` suffix.
function isChangelogen(t: string): boolean {
  return base(t).replace(/@[^@]*$/, '') === 'changelogen'
}

// First pnpm script/subcommand after global flags, unwrapping `run`.
function pnpmScript(toks: string[], i: number): string {
  let k = i + 1
  while (k < toks.length) {
    const t = unquote(toks[k]!)
    if (t.startsWith('-')) {
      if (PNPM_VALUE_FLAG.has(t))
        k++
      k++
      continue
    }
    if (t === 'run' || t === 'run-script') {
      k++
      continue
    }
    return t
  }
  return ''
}

/**
 * Denies a push whose target is protected or, in a call where any command moves the branch,
 * remotes, or directory, implicit; any whole-repo or bare-force push; and the release script.
 */
export const verdict: Verdict = (cmd, ctx) => {
  const parsed = segments(cmd).map((seg) => {
    const toks = tokenize(seg)
    return { toks, ...resolveHead(toks) }
  })
  // Any move counts, wherever it sits: segments() lists what eval and a heredoc a shell reads run
  // after the outer commands, so their order says nothing about when bash runs them.
  const moved = parsed.some(({ toks, i, head, probe }) => !probe && moves(toks, i, head))
  for (const { toks, i, head, probe } of parsed) {
    if (probe || moves(toks, i, head))
      continue
    if (head === 'git') {
      const { sub, args } = gitSubcommand(toks, i)
      if (sub !== 'push')
        continue
      const why = pushVerdict(args, ctx, moved)
      if (why)
        return `${why}.`
    }
    if (head === 'pnpm' && pnpmScript(toks, i) === 'release')
      return '`pnpm release` pushes to the default branch from inside changelogen. Human-only: prepare the release (release skill) and let the user run it.'
    // The head is changelogen itself, through pnpm exec, dlx, pnx, pnpx, or npx too, or pnpm,
    // which runs a local bin when no script matches, so `pnpm changelogen` is changelogen.
    const cl = isChangelogen(toks[i] ?? '') || (head === 'pnpm' && isChangelogen(pnpmScript(toks, i)))
    if (cl && toks.slice(i + 1).some(t => unquote(t) === '--push'))
      return '`changelogen --push` pushes to the default branch. Human-only: run it yourself in a terminal.'
  }
  return null
}
