/**
 * deny-hook-bypass guard (imported by dispatch.mts). Blocks the common ways an agent skips
 * this repo's git hooks (listed in docs/template/guards.md, Hook bypass): `--no-verify` on
 * `git commit|push|merge` and `-n` on `git commit`, a `core.hooksPath` override through
 * `git -c` / `--config-env`, and the SKIP_SIMPLE_GIT_HOOKS / HUSKY environment prefixes.
 * The rulebook's answer to a failing hook is to fix the check, never to bypass it.
 * Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { gitSubcommand, resolveHead, segments, tokenize, unquote } from './_lexer.mts'

// Subcommands whose hooks matter here. `-n` means --no-verify only for commit (push: dry-run).
const HOOKED: ReadonlySet<string> = new Set(['commit', 'push', 'merge'])
// `git commit` options that take a separate value, so their value is never read as a flag.
const COMMIT_VALUE_OPT: ReadonlySet<string> = new Set(['-m', '-F', '-C', '-c', '-t', '--author', '--date', '--fixup', '--squash', '--message', '--file', '--template', '--reuse-message', '--reedit-message', '--trailer'])
// git accepts unambiguous abbreviations of long options; `--no-veri` is the shortest unique one.
const NO_VERIFY_RE = /^--no-veri(?:f(?:y)?)?$/
const HOOKS_PATH_RE = /^core\.hookspath=/i
const SKIP_ENV_RE = /^(?:SKIP_SIMPLE_GIT_HOOKS=|HUSKY=0$|HUSKY_SKIP_HOOKS=)/

// Tokens outside quoted spans: tokenize() splits on whitespace regardless of quotes, so a
// commit message mentioning `--no-verify` arrives as several tokens; a span from the token
// that opens a quote to the token that closes it collapses to ONE empty placeholder, so the
// value-option arity below (`-m <msg>`) stays aligned and `-m` can never swallow the flag
// that follows the message (`-m "fix the build" --no-verify` once passed that way). `balanced`
// is false when a quote never closed by this heuristic — the caller then scans every token
// (fail closed), which also covers a quote closed mid-token (`-m "a "b --no-verify`).
function outsideQuotes(toks: string[]): { toks: string[], balanced: boolean } {
  const out: string[] = []
  let open: string | null = null
  for (const t of toks) {
    if (open) {
      if (t.endsWith(open))
        open = null
      continue
    }
    const q = t[0]
    if ((q === '"' || q === '\'') && !(t.length > 1 && t.endsWith(q))) {
      open = q
      out.push('')
      continue
    }
    out.push(t)
  }
  return { toks: out, balanced: open === null }
}

function bypass(toks: string[]): string | null {
  const { i, head, probe } = resolveHead(toks)
  if (probe)
    return null
  for (let k = 0; k < i; k++) {
    const t = unquote(toks[k] ?? '')
    if (SKIP_ENV_RE.test(t))
      return `${t.split('=')[0]} disables the git hooks`
  }
  if (head === 'export' && SKIP_ENV_RE.test(unquote(toks[i + 1] ?? '')))
    return `exporting ${unquote(toks[i + 1] ?? '').split('=')[0]} disables the git hooks for the session`
  if (head !== 'git')
    return null
  const { sub, args: rest, globals } = gitSubcommand(toks, i)
  for (let g = 0; g < globals.length; g++) {
    const t = globals[g]!
    const value = globals[g + 1] ?? ''
    if ((t === '-c' && HOOKS_PATH_RE.test(value)) || /^--config-env=core\.hookspath=/i.test(t) || (t === '--config-env' && HOOKS_PATH_RE.test(value)))
      return 'overriding core.hooksPath bypasses the repo hooks'
  }
  if (!HOOKED.has(sub))
    return null
  const scanned = outsideQuotes(rest)
  const args = scanned.balanced ? scanned.toks : rest
  for (let a = 0; a < args.length; a++) {
    const t = unquote(args[a]!)
    if (t === '--')
      break
    if (NO_VERIFY_RE.test(t))
      return `\`git ${sub} --no-verify\` skips the hooks`
    if (sub === 'commit') {
      if (COMMIT_VALUE_OPT.has(t)) {
        a++
        continue
      }
      if (/^-[a-zA-Z]+$/.test(t) && t.includes('n'))
        return '`git commit -n` skips the hooks (it is --no-verify)'
    }
  }
  return null
}

/** Denies a segment that skips or reroutes the git hooks. */
export const verdict: Verdict = (cmd) => {
  for (const seg of segments(cmd)) {
    const why = bypass(tokenize(seg))
    if (why)
      return `${why}. Fix the failing check instead (AGENTS.md non-negotiable rules).`
  }
  return null
}
