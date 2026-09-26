/**
 * deny-secret-reads guard (imported by dispatch.mts). Blocks shell reads of
 * secret files (.env*, .netrc, .npmrc, secrets/, *.pem, *.key, *.p12, *.pfx, *.jks, SSH private
 * keys, and the credential files of aws, gh, kube, docker, git, and postgres) — direct readers,
 * `<` redirects, pnpm-exec wrappers, `find -exec` at a secret name or pattern, and an unquoted
 * glob that can expand to a secret name. `.env.example` is the one carve-out; other
 * placeholder spellings fail closed. Shared lexing in ./_lexer.mts. Scope and out-of-scope:
 * docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { globTokens, resolveHead, segments, tokenize, unquote } from './_lexer.mts'

const READERS: ReadonlySet<string> = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'grep', 'egrep', 'fgrep', 'rg',
  'sed', 'awk', 'cut', 'od', 'xxd', 'hexdump', 'strings', 'base64', 'dd', 'source', '.',
  'read', 'mapfile', 'readarray', 'sort', 'uniq', 'paste', 'join', 'comm', 'fold', 'expand',
  'unexpand', 'pr', 'column', 'rev', 'shuf', 'look', 'csplit', 'split', 'diff', 'sdiff',
  'cmp', 'fmt', 'ptx', 'tsort', 'numfmt', 'zcat', 'bzcat', 'xzcat',
])
// Readers where `-o FILE` is genuinely an OUTPUT operand (skip that value from the secret
// scan). For grep/od/strings `-o` is a boolean flag whose next token is the INPUT file.
const OUTPUT_O: ReadonlySet<string> = new Set(['sort', 'shuf'])

// A word as a path: quotes dropped, a closing `)` and a dd `if=`/`of=` prefix trimmed. Both
// separators: a quoted Windows path keeps its backslashes through tokenize().
function asPath(arg: string): string {
  return unquote(arg).replace(/\)+$/, '').replace(/^(?:if|of)=/, '').replace(/\\/g, '/')
}

// Whether a word reads a secret: its text names one, or a glob in `glob` (the same word as
// globTokens() gives it, holding only the glob characters that expand) can expand to one.
function isSecret(arg: string, glob: string): boolean {
  const p = asPath(arg)
  if (/(?:^|\/)secrets(?:\/|$)/i.test(p))
    return true
  if (/\.(?:pem|key|p12|pfx|jks)$/i.test(p))
    return true
  // Lowercased so the match is case-insensitive, matching the *.pem/*.key branch above (a
  // case-insensitive filesystem treats `.ENV` as `.env`, and lowercase is the safe direction).
  const b = (p.split('/').pop() ?? '').toLowerCase()
  // Plaintext machine credentials (.netrc, its Windows spelling) and the npm config that is
  // where an _authToken actually lives. A project .npmrc is usually harmless, but a filename
  // cannot prove it holds no token — fail closed; `pnpm config list` shows the config masked.
  if (b === '.netrc' || b === '_netrc' || b === '.npmrc')
    return true
  // SSH private keys by their conventional names, any suffixed copy included (id_rsa.bak,
  // id_ed25519~); the .pub half is public and stays readable.
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[.\-_~])/.test(b) && !b.endsWith('.pub'))
    return true
  // Credential files that a developer machine holds outside any repo, keyed by their parent
  // directory so a bare `credentials` or `config` elsewhere is not one: ~/.aws/credentials,
  // ~/.config/gh/hosts.yml (the gh OAuth token), ~/.kube/config, ~/.docker/config.json.
  const segs = p.toLowerCase().split('/')
  const parent = segs.at(-2) ?? ''
  if ((parent === '.aws' && b === 'credentials') || (parent === 'gh' && segs.at(-3) === '.config' && b === 'hosts.yml') || (parent === '.kube' && b === 'config') || (parent === '.docker' && b === 'config.json'))
    return true
  // Plaintext credential stores by name: git's credential helper file and libpq's password file.
  if (b === '.git-credentials' || b === '.pgpass')
    return true
  // Secret env files: `.env`, any separator-suffixed variant (.env.production, .env-prod,
  // .env_x, the `.env~` editor backup), and `.envrc` (direnv, holds exports) plus its own
  // suffixed variants (.envrc.bak, .envrc~) — but NOT an unrelated basename that merely starts
  // with those letters (.environment). `(?:rc)?` = optional `rc`, then require end-or-separator
  // so a backup/copy spelling can never slip a byte-identical secret. `.env.example` is the ONE
  // deliberate carve-out; other placeholder spellings (.env.sample/.template/.dist) fail closed
  // ON PURPOSE — a filename guard cannot verify they hold no real secret, so they are denied
  // (safe direction, documented in docs/template/guards.md; never a bypass).
  if (/^\.env(?:rc)?(?:$|[.\-_~])/.test(b) && b !== '.env.example')
    return true
  return globReadsSecret(asPath(glob))
}

// Secret paths a glob is tested against, matched segment by segment from the end: a glob that
// can expand to one reads it (`.env*`, `~/.ssh/*`, `~/.docker/*.json`).
const GLOB_PROBES: readonly string[][] = [
  '.env', '.env~', '.env.local', '.env.production', '.envrc', '.netrc', '_netrc', '.npmrc',
  '.git-credentials', '.pgpass', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.ssh/id_rsa',
  '.ssh/id_dsa', '.ssh/id_ecdsa', '.ssh/id_ed25519', '.aws/credentials', '.config/gh/hosts.yml',
  '.kube/config', '.docker/config.json',
].map(p => p.split('/'))

// One path segment of a bash glob as a case-insensitive regex, or null when it holds no glob.
// As in bash without dotglob, a leading `*`, `?`, or `[…]` never matches a leading dot.
function globSegment(seg: string): RegExp | null {
  if (!/[*?[]/.test(seg))
    return null
  let re = /^[*?[]/.test(seg) ? '(?!\\.)' : ''
  for (let n = 0; n < seg.length; n++) {
    const c = seg[n]!
    const close = c === '[' ? seg.indexOf(']', /^[!^]/.test(seg[n + 1] ?? '') ? n + 3 : n + 2) : -1
    if (c === '*') {
      re += '.*'
    }
    else if (c === '?') {
      re += '.'
    }
    else if (close > 0) {
      const set = seg.slice(n + 1, close)
      re += `[${set.replace(/^[!^]/, '^').replace(/[\\\]]/g, '\\$&')}]`
      n = close
    }
    else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${re}$`, 'i')
  }
  catch {
    return null // a range bash rejects too (`[z-a]`): compared as literal text below
  }
}

// Whether a path holding a glob can expand to a probe. A lone name that opens with a wildcard
// is not tested against the bare names, so `grep x *` stays open; a credential directory is.
function globReadsSecret(p: string): boolean {
  const segs = p.split('/')
  if (!segs.some(s => /[*?[]/.test(s)))
    return false
  return GLOB_PROBES.some((probe) => {
    const have = segs.slice(-probe.length)
    if (have.length < probe.length || (probe.length === 1 && /^[*?[]/.test(have[0]!)))
      return false
    return probe.every((want, k) => {
      const re = globSegment(have[k]!)
      return re ? re.test(want) : have[k]!.toLowerCase() === want
    })
  })
}

function braceMembers(a: string): string[] {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(a)
  return m ? m[2]!.split(',').map(x => m[1]! + x + m[3]!) : [a]
}

// Whether word k of a segment reads a secret. `globs` lines up with `toks`: globTokens() of
// the segment for a word bash expands, or `toks` itself for a pattern find matches unquoted.
function secretAt(toks: string[], globs: string[], k: number): boolean {
  const words = braceMembers(toks[k]!)
  const expanded = braceMembers(globs[k] ?? toks[k]!)
  return words.some((w, x) => isSecret(w, expanded[x] ?? w))
}

// The file a `<` redirect at word j reads (`<.env`, `< .env`, `<>.env`, `$(<.env)`), or null.
function redirectSource(toks: string[], j: number): string | null {
  const m = /^\d*<+(.*)$/.exec(toks[j]!)
  if (!m)
    return null
  return m[1]!.replace(/^>/, '').replace(/\)+$/, '') || toks[j + 1] || null
}

// find's name and path tests: find matches their pattern as a glob itself, quoted or not.
const FIND_TESTS: ReadonlySet<string> = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename'])
const FIND_EXEC = /^-(?:exec|ok)(?:dir)?$/

// Whether a `-prune` that is followed by `-o` comes before the walk's -exec, cutting out what
// the tests ahead of it match (`-path '*/.*' -prune -o …`).
function pruned(toks: string[], from: number): boolean {
  for (let k = from; k < toks.length; k++) {
    const t = unquote(toks[k]!)
    if (FIND_EXEC.test(t))
      return false
    if (t === '-prune') {
      let j = k + 1
      while (unquote(toks[j] ?? '') === ')') j++
      if (/^-or?$/.test(unquote(toks[j] ?? '')))
        return true
    }
  }
  return false
}

// Whether a `find … -exec|-ok` walk is pointed at a secret: a word names one, or a name or
// path test's pattern can match one. A negated test (`-not -path '*/.*'`) or a pruned one
// keeps what it matches out of the walk, so its pattern is not probed. The program -exec runs
// is not judged: `-exec sh -c …` can read what it is handed.
function findReadsSecret(toks: string[], globs: string[], i: number): boolean {
  if (!toks.some(t => FIND_EXEC.test(unquote(t))))
    return false
  let negated = false
  for (let k = i + 1; k < toks.length; k++) {
    const t = unquote(toks[k]!)
    if (secretAt(toks, globs, k))
      return true
    if (FIND_TESTS.has(t) && k + 1 < toks.length && !negated && !pruned(toks, k + 2) && secretAt(toks, toks, k + 1))
      return true
    // `!` and `-not` negate the next test, or the group a `(` opens.
    negated = (t === '!' || t === '-not') ? !negated : (t === '(' && negated)
  }
  return false
}

const DENY = 'reading secrets (.env*, .envrc, .netrc, .npmrc, secrets/, *.pem, *.key, *.p12, *.pfx, *.jks, SSH private keys, aws/gh/kube/docker/git/postgres credential files) via the shell is denied — same policy as the Read tool.'

/** Denies a segment that reads, redirects from, or `find -exec`s over a secret-named path. */
export const verdict: Verdict = (cmd) => {
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const globs = globTokens(seg)
    // `<` redirect into a secret (`$(<.env)`, `read x < .env`, `cat <.env`, `cat <>.env`),
    // regardless of the head command. Strip a leading `>` off the `<>` read-write target.
    for (let j = 0; j < toks.length; j++) {
      const tgt = redirectSource(toks, j)
      if (tgt && isSecret(tgt, redirectSource(globs, j) ?? tgt))
        return DENY
    }
    const { i, head, probe } = resolveHead(toks)
    if (probe)
      continue
    if (head === 'find' && findReadsSecret(toks, globs, i))
      return DENY
    if (!READERS.has(head))
      continue
    for (let k = i + 1; k < toks.length; k++) {
      if (OUTPUT_O.has(head) && /^(?:-o|--output)$/.test(unquote(toks[k]!))) { k++; continue }
      if (secretAt(toks, globs, k))
        return DENY
    }
  }
  return null
}
