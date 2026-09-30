/**
 * deny-secret-reads guard (imported by dispatch.mts). Blocks shell reads of
 * secret files (.env*, .netrc, .npmrc, secrets/, *.pem, *.key, *.p12, *.pfx, *.jks, SSH private
 * keys, and the credential files of aws, gh, kube, docker, git, and postgres) — direct readers,
 * `git diff`, `git difftool`, `git grep`, and `git blame`, `<` redirects, pnpm-exec wrappers,
 * `find -exec` at a secret name or pattern, a secret named as a long option's value or glued to
 * a short -f or -g (`--include=.env`, `-f.env`, `-fid_rsa`), and an unquoted glob that can expand
 * to a secret name. `.env.example` is the one carve-out; other
 * placeholder spellings fail closed. Shared lexing in ./_lexer.mts. Scope and out-of-scope:
 * docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { gitSubcommand, globTokens, resolveHead, segments, tokenize, unquote } from './_lexer.mts'

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
// git subcommands that print a file they are named: `git diff`, `git difftool`, and `git grep`
// read the working tree under --no-index, which git diff also turns on by itself when a path lies
// outside the worktree (`git diff /dev/null .env`), and `git blame --contents FILE` prints FILE.
const GIT_READERS: ReadonlySet<string> = new Set(['diff', 'difftool', 'grep', 'blame'])

// A word as a path: quotes dropped, a closing `)` trimmed, and the option a value is glued to
// dropped, so the value is judged like the same value written as its own word: a long option's
// `--name=` (`--include=.env`, `--from-file=.env`, `--glob=.env`), dd's `if=` and `of=`, and a
// short-option cluster ending in `-f` or `-g` (grep's pattern file, rg's glob) glued to any value
// (`-f.env`, `-rf.env`, `-fid_rsa`, `-gsecrets/*`). Dropping the cluster only adds denies: no
// secret test matches a word or segment that starts with `-`. Both separators: a quoted Windows
// path keeps its backslashes through tokenize().
function asPath(arg: string): string {
  return unquote(arg).replace(/\)+$/, '').replace(/^(?:--[\w-]+=|(?:if|of)=|-[A-Za-z]*[fg])/, '').replace(/\\/g, '/')
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
// As in bash without dotglob, a leading `*`, `?`, or `[…]` never matches a leading dot. A run
// of stars is one star, as bash reads it: one `.*` per star backtracked exponentially, and 20
// stars took 20 s, past the 10 s after which Gemini runs the call.
function globSegment(text: string): RegExp | null {
  if (!/[*?[]/.test(text))
    return null
  const seg = text.replace(/\*+/g, '*')
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

// The key extensions, which a glob's own extension is tested against (`server.pe?`).
const KEY_EXTENSIONS: readonly string[] = ['pem', 'key', 'p12', 'pfx', 'jks']

// Whether a path holding a glob can expand to a probe, to a file under a `secrets` directory
// (`secret?/api.txt`, `?ecrets/api.txt`), or to a key extension (`certs/*.pe?`). A segment
// that opens with a wildcard is not tested against a bare name, so `grep x *` stays open, a
// directory made of wildcards alone is not tested against `secrets`, so `cat */package.json`
// does, and neither is an extension that opens with `*` (`tsconfig.*`); a credential
// directory is.
function globReadsSecret(p: string): boolean {
  const segs = p.split('/')
  if (!segs.some(s => /[*?[]/.test(s)))
    return false
  if (segs.slice(0, -1).some(seg => seg.replace(/\[[^\]]*\]|[*?]/g, '') !== '' && globSegment(seg)?.test('secrets')))
    return true
  const last = segs.at(-1)!
  const ext = last.includes('.') ? last.slice(last.lastIndexOf('.') + 1) : ''
  const extGlob = ext.startsWith('*') ? null : globSegment(ext)
  if (extGlob && KEY_EXTENSIONS.some(e => extGlob.test(e)))
    return true
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

// The words one brace expansion makes of a word (`.env{,.local}`), or the word itself: the
// members between the last `{` that a `}` follows and the first `}` after it. Two index scans,
// where a regex backtracked quadratically over a run of `{`.
function braceMembers(a: string): string[] {
  const last = a.lastIndexOf('}')
  const open = last < 0 ? -1 : a.lastIndexOf('{', last)
  if (open < 0)
    return [a]
  const close = a.indexOf('}', open)
  const before = a.slice(0, open)
  const after = a.slice(close + 1)
  return a.slice(open + 1, close).split(',').map(x => before + x + after)
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
// find's primaries that take one word after them (`-newerXY` too), and those always true.
// Anything else takes none and can be true or false: a primary missing here at worst shifts
// a word into a primary of its own, which is judged as unknown, the safe side.
const FIND_ONE_ARG: ReadonlySet<string> = new Set([
  ...FIND_TESTS, '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-size', '-perm',
  '-user', '-group', '-uid', '-gid', '-newer', '-anewer', '-cnewer', '-samefile', '-inum',
  '-links', '-mtime', '-atime', '-ctime', '-mmin', '-amin', '-cmin', '-used', '-fstype',
  '-context', '-maxdepth', '-mindepth', '-regextype', '-fprint', '-fprint0', '-fls',
  '-files0-from', '-printf',
])
const FIND_TRUE: ReadonlySet<string> = new Set(['-prune', '-true', '-print', '-print0', '-printf', '-ls', '-maxdepth', '-mindepth', '-depth', '-xdev', '-mount', '-follow', '-daystart', '-noleaf', '-regextype'])

// Every outcome a find expression can have for one file, as a bit mask over (value, whether an
// -exec or -ok ran on the file): bit 1 << ((ran ? 2 : 0) + (value ? 1 : 0)).
type Outcomes = number
function outcome(value: boolean, ran: boolean): Outcomes {
  return 1 << ((ran ? 2 : 0) + (value ? 1 : 0))
}
// `a -a b`, `a -o b`, or `a , b`: b runs only when a is true, false, or always.
function combine(a: Outcomes, b: Outcomes, op: 'and' | 'or' | 'list'): Outcomes {
  let out = 0
  for (let x = 0; x < 4; x++) {
    if ((a & (1 << x)) === 0)
      continue
    const value = (x & 1) === 1
    const ran = (x & 2) === 2
    if ((op === 'and' && !value) || (op === 'or' && value)) {
      out |= outcome(value, ran)
      continue
    }
    for (let y = 0; y < 4; y++) {
      if ((b & (1 << y)) !== 0)
        out |= outcome((y & 1) === 1, ran || (y & 2) === 2)
    }
  }
  return out
}
function negate(a: Outcomes): Outcomes {
  let out = 0
  for (let x = 0; x < 4; x++) {
    if ((a & (1 << x)) !== 0)
      out |= outcome((x & 1) === 0, (x & 2) === 2)
  }
  return out
}

// Whether find runs an -exec or -ok on a file that the test at `target` matches, with every
// other test free to go either way: `-name '.env*' -type d -prune -o -exec cat {} +` does
// (a .env file fails `-type d` and falls through), `-path '*/.*' -prune -o -exec …` and
// `-not -path '*/.*' -exec …` do not. `words` are the unquoted words after `find`.
function execReaches(words: string[], target: number): boolean {
  let p = 0
  // Leading options, then the start points, up to the first word of the expression.
  while (/^-[HLP]$|^-O\d*$/.test(words[p] ?? ''))
    p++
  if (words[p] === '-D')
    p += 2
  while (p < words.length && !/^[-(!,]/.test(words[p]!))
    p++
  const primary = (): Outcomes => {
    const at = p
    const w = words[p++] ?? ''
    if (FIND_EXEC.test(w)) {
      while (p < words.length) {
        const arg = words[p++]!
        if (arg === ';' || (arg === '+' && words[p - 2] === '{}'))
          break
      }
      return outcome(true, true) | outcome(false, true)
    }
    p += FIND_ONE_ARG.has(w) || /^-newer[aBcmt][aBcmt]$/.test(w) ? 1 : 0
    if (at === target || FIND_TRUE.has(w))
      return outcome(true, false)
    return w === '-false' ? outcome(false, false) : outcome(true, false) | outcome(false, false)
  }
  const unary = (): Outcomes => {
    const w = words[p]
    if (w === '!' || w === '-not') {
      p++
      return negate(unary())
    }
    if (w === '(') {
      p++
      const inner = list()
      if (words[p] === ')')
        p++
      return inner
    }
    return primary()
  }
  const and = (): Outcomes => {
    let r = unary()
    while (p < words.length && !/^(?:-o|-or|\)|,)$/.test(words[p]!)) {
      if (words[p] === '-a' || words[p] === '-and')
        p++
      if (p < words.length)
        r = combine(r, unary(), 'and')
    }
    return r
  }
  const or = (): Outcomes => {
    let r = and()
    while (words[p] === '-o' || words[p] === '-or') {
      p++
      r = combine(r, and(), 'or')
    }
    return r
  }
  const list = (): Outcomes => {
    let r = or()
    while (words[p] === ',') {
      p++
      r = combine(r, or(), 'list')
    }
    return r
  }
  let r = list()
  // A stray `)` ends nothing: skip it and read on, running what follows too.
  while (p < words.length) {
    p++
    r = combine(r, list(), 'list')
  }
  return (r & (outcome(true, true) | outcome(false, true))) !== 0
}

// Whether a `find … -exec|-ok` walk is pointed at a secret: a word names one, or a name or
// path test's pattern can match one and a file it matches can still reach the -exec. The
// program -exec runs is not judged: `-exec sh -c …` can read what it is handed.
function findReadsSecret(toks: string[], globs: string[], i: number): boolean {
  const words = toks.slice(i + 1).map(unquote)
  if (!words.some(w => FIND_EXEC.test(w)))
    return false
  for (let k = i + 1; k < toks.length; k++) {
    if (secretAt(toks, globs, k))
      return true
    if (FIND_TESTS.has(words[k - i - 1]!) && k + 1 < toks.length && secretAt(toks, toks, k + 1) && execReaches(words, k - i - 1))
      return true
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
    // Every word after git is judged, its global options too (`git -C secrets grep …`), with
    // or without --no-index, since a path outside the worktree turns it on for git diff.
    if (head === 'git' && GIT_READERS.has(gitSubcommand(toks, i).sub)) {
      for (let k = i + 1; k < toks.length; k++) {
        if (secretAt(toks, globs, k))
          return DENY
      }
    }
    if (!READERS.has(head))
      continue
    for (let k = i + 1; k < toks.length; k++) {
      const word = unquote(toks[k]!)
      if (OUTPUT_O.has(head) && /^(?:-o|--output)$/.test(word)) { k++; continue }
      if (OUTPUT_O.has(head) && word.startsWith('--output='))
        continue
      if (secretAt(toks, globs, k))
        return DENY
    }
  }
  return null
}
