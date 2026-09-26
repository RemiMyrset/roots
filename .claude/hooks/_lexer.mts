/**
 * Shared lexical core for the agent guards (deny-non-pnpm / deny-build-scripts /
 * deny-secret-reads / deny-push-protected / deny-hook-bypass), plus the git-option parsing,
 * the hook-payload reader, and the context type the dispatcher hands every guard. Consolidated here so a fix lands ONCE — the
 * previous triplication is why the guards regressed every audit.
 *
 * ZERO external dependencies (node builtins only): the guards run before `pnpm install`
 * and are synced into arbitrary repos, so this module must never require an npm package.
 * Best-effort lexical detection, NOT a shell — scope and out-of-scope live in docs/template/guards.md.
 */

export const BANNED: ReadonlySet<string> = new Set(['npm', 'yarn', 'bun', 'bunx'])

// Pass-through wrappers whose argv IS the real command: skip them to find the head. An
// allowlist can never be exhaustive (proxychains/firejail/setarch/catchsegv/...); unknown
// wrapper words are documented out-of-scope in docs/template/guards.md.
export const WRAP: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'runuser', 'env', 'command', 'exec', 'eval', 'time', 'timeout', 'nice',
  'ionice', 'taskset', 'chrt', 'nohup', 'setsid', 'stdbuf', 'unbuffer', 'flock', 'xargs',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'builtin', 'corepack', 'mise',
])

// pnpm global flags that take a separate value (between `pnpm` and its subcommand).
export const PNPM_VALUE_FLAG: ReadonlySet<string> = new Set([
  '--filter', '-F', '--filter-prod', '-C', '--dir', '--config',
  '--workspace-concurrency', '--reporter', '--loglevel', '--store-dir',
])

// Wrapper option flags that consume a SEPARATE value token — PER WRAPPER, because a flag is
// value-taking for one wrapper (nice -n 10, timeout -s KILL) yet boolean for another (sudo -n,
// flock -n). A single global set mis-parsed both directions and let the value/head shift; keep
// these lists complete per wrapper. Command-string flags (-c) are deliberately excluded — a
// nested interpreter (`sh -c '…'`) is documented out-of-scope. Unknown/keyword wrappers are
// absent from the map and so consume no value.
export const WRAP_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-U', '-C', '-p', '-r', '-t', '-T', '-h', '-R'])],
  ['doas', new Set(['-u', '-C'])],
  ['runuser', new Set(['-u', '-g'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['nice', new Set(['-n'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['taskset', new Set(['-c', '-p'])],
  ['chrt', new Set(['-p'])],
  ['timeout', new Set(['-s', '-k'])],
  ['flock', new Set(['-w', '-E'])],
  ['exec', new Set(['-a'])],
  ['xargs', new Set(['-I', '-i', '-n', '-P', '-s', '-d', '-E', '-L', '-a'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  // mise x|exec: directory, env profile, jobs, profile take a value; -c/--command is a nested
  // command string and stays out of scope like sh -c.
  ['mise', new Set(['-C', '--cd', '-E', '--env', '-j', '--jobs', '-P', '--profile'])],
])

// Wrappers with a leading POSITIONAL before the command (not a flag), and WHEN to consume it:
//   'always'       — `timeout DURATION cmd`, `flock LOCKFILE cmd` (the positional is mandatory).
//   'unless-value' — `taskset MASK cmd`, where the mask is EITHER a bare positional (taskset 0x1
//                    cmd) OR supplied via a value-flag (taskset -c 0-3 cmd); consume the leading
//                    positional only in the former, else it eats the command.
// The positional (a non-numeric `5m` / a path / a hex mask, which skip() would not catch) must be
// consumed or it becomes the head.
export const POSITIONAL_MODE: ReadonlyMap<string, 'always' | 'unless-value'> = new Map([
  ['timeout', 'always'],
  ['flock', 'always'],
  ['taskset', 'unless-value'],
])

export function unquote(t: string): string {
  return t.replace(/['"]/g, '')
}

export function base(t: string): string {
  return unquote(t).split('/').pop() ?? ''
}

// Would consuming `tok` as a wrapper positional / value-flag argument hide a command the guards
// must inspect? If so, refuse to consume it and let it fall through as the head (fail toward
// deny). Covers the banned package managers and pnpm/corepack — the heads the lexer natively
// knows; a reader head (deny-secret-reads) mis-consumed by a duration-less `timeout` is left as
// a documented, shell-rejected non-exploitable edge.
export function wouldHideHead(tok: string): boolean {
  const b = base(tok)
  return BANNED.has(b) || b === 'pnpm' || b === 'corepack'
}

export function skip(t: string): boolean {
  return t === '{' || t === '}' || /^[A-Za-z_]\w*=/.test(t) || WRAP.has(base(t))
    || /^(?:\d*[<>]|&>)/.test(t) || /^\d+$/.test(t) || t.startsWith('-')
}

/**
 * The word a command substitution leaves behind in the command around it. Its output is
 * unknowable here, so the enclosing word keeps this marker instead: argument positions stay
 * aligned, and the push guard resolves a target that is only this marker like `HEAD`.
 */
export const SUBST = '$()'

// Heads that run a heredoc body as shell commands, so that body is lexed like the command line.
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'pwsh', 'powershell', 'source', '.'])

// One command context: the input itself, a `(` subshell, or a `$(` / backtick substitution.
// `q` is the quote state inside it: `"`, `'`, `$` (ANSI-C `$'…'`), or `h` (the body of a
// heredoc with an unquoted delimiter, where only `$(`, backticks, and `\` are special).
// `pipe` is the index in the output where its current pipeline's first segment lands.
interface Frame { close: '' | ')' | '`', subst: boolean, arith: boolean, q: '' | '"' | '\'' | '$' | 'h', cur: string, brace: number, pipe: number }
// A heredoc waiting for its body, and the output range of the pipeline that owns it (`to` is
// -1 while that pipeline is open): a shell head in that range reads the body as commands.
interface Heredoc { delim: string, strip: boolean, quoted: boolean, frame: Frame, from: number, to: number }

// A heredoc body ends at its delimiter line (leading tabs dropped for `<<-`). Inside `$(`, a
// line starting with the delimiter and `)` also ends it, and inside backticks the first
// backtick does, as bash does. Returns the body's end and where lexing resumes.
function heredocEnd(s: string, k: number, h: Heredoc, close: Frame['close']): { end: number, next: number } {
  while (k < s.length) {
    let e = s.indexOf('\n', k)
    if (e < 0)
      e = s.length
    const line = s.slice(k, e)
    if (close === '`' && line.includes('`'))
      return { end: k + line.indexOf('`'), next: k + line.indexOf('`') }
    const lead = h.strip ? line.length - line.replace(/^\t+/, '').length : 0
    const text = line.slice(lead).replace(/\r$/, '')
    if (text === h.delim)
      return { end: k, next: e + 1 }
    if (close === ')' && text.startsWith(`${h.delim})`))
      return { end: k, next: k + lead + h.delim.length }
    k = e + 1
  }
  return { end: s.length, next: s.length }
}

// The segment lexer behind segments(). `body` lexes the text as a heredoc body with an unquoted
// delimiter: only the substitutions in it are commands, and the text itself is dropped.
function lex(s: string, body: boolean): string[] {
  const out: string[] = []
  const stack: Frame[] = [{ close: '', subst: false, arith: false, q: body ? 'h' : '', cur: '', brace: 0, pipe: 0 }]
  let f = stack[0]!
  let ws = true // at the start of a word, where `#` opens a comment
  let op = false // the last character was an unquoted `<` or `>`, so a `&` or `|` extends it
  const pending: Heredoc[] = []
  const open = (close: ')' | '`', subst: boolean, arith: boolean): void => {
    f = { close, subst, arith, q: '', cur: '', brace: 0, pipe: out.length }
    stack.push(f)
    ws = true
  }
  // `;`, `&`, `&&`, `||`, and a newline end the current frame's pipeline.
  const endPipe = (): void => {
    for (const h of pending) {
      if (h.frame === f && h.to < 0)
        h.to = out.length
    }
    f.pipe = out.length
  }
  const pop = (): void => {
    out.push(f.cur)
    const done = stack.pop()!
    f = stack.at(-1)!
    if (done.subst)
      f.cur += SUBST
    ws = false
  }
  for (let n = 0; n < s.length; n++) {
    const c = s[n]!
    const afterOp = op
    op = false
    // bash finds a backtick substitution's end before parsing it, so an unescaped backtick
    // closes it whatever quote is open inside.
    if (f.close === '`' && c === '\\' && s[n + 1] === '`') { f.cur += '\\`'; n++; continue }
    if (f.close === '`' && c === '`') { pop(); continue }
    if (f.q === '\'') {
      f.cur += c
      if (c === '\'')
        f.q = ''
      continue
    }
    if (f.q === '$') {
      if (c === '\\') { f.cur += c + (s[n + 1] ?? ''); n++; continue }
      f.cur += c
      if (c === '\'')
        f.q = ''
      continue
    }
    if (f.q === '"' || f.q === 'h') {
      // Inside double quotes and an expanding heredoc body, `$(` and backticks still run a
      // command; `(`, `;`, `|`, and the other quote are literal.
      if (c === '\\') { f.cur += c + (s[n + 1] ?? ''); n++; continue }
      if (c === '$' && s[n + 1] === '(') { n++; open(')', true, s[n + 1] === '('); continue }
      if (c === '`') { open('`', true, false); continue }
      f.cur += c
      if (c === '"' && f.q === '"')
        f.q = ''
      continue
    }
    if (c === '\\') { f.cur += c + (s[n + 1] ?? ''); n++; ws = false; continue }
    if (c === '\'' || c === '"') { f.q = c; f.cur += c; ws = false; continue }
    if (c === '$' && s[n + 1] === '\'') { f.q = '$'; f.cur += '$\''; n++; ws = false; continue }
    if (c === '$' && s[n + 1] === '(') { n++; open(')', true, f.arith || s[n + 1] === '('); continue }
    if (c === '$' && s[n + 1] === '{') { f.brace++; f.cur += '${'; n++; ws = false; continue }
    if (c === '}' && f.brace > 0) { f.brace--; f.cur += c; ws = false; continue }
    if (c === '`') { open('`', true, false); continue }
    if (c === '(') { open(')', false, f.arith || s[n + 1] === '('); continue }
    if (c === ')' && f.close === ')') { pop(); continue }
    // A comment runs to the end of the line; inside backticks, to the closing backtick.
    if (c === '#' && ws && f.brace === 0 && !f.arith) {
      let e = s.indexOf('\n', n)
      if (e < 0)
        e = s.length
      if (f.close === '`') {
        const bt = s.indexOf('`', n)
        if (bt >= 0 && bt < e)
          e = bt
      }
      n = e - 1
      continue
    }
    if (c === '<' && s[n + 1] === '<' && s[n + 2] === '<') { f.cur += '<<<'; n += 2; ws = false; continue }
    // A heredoc operator (`<<`, `<<-`) and its delimiter word; `<<` in arithmetic is a shift.
    if (c === '<' && s[n + 1] === '<' && !f.arith) {
      let k = n + 2
      const strip = s[k] === '-'
      if (strip)
        k++
      while (s[k] === ' ' || s[k] === '\t') k++
      let delim = ''
      let quoted = false
      let wq = ''
      const from = k
      while (k < s.length && s[k] !== '\n') {
        const d = s[k]!
        if (wq) {
          if (d === wq)
            wq = ''
          else
            delim += d
          k++
          continue
        }
        if (d === '\'' || d === '"') { wq = d; quoted = true; k++; continue }
        if (d === '\\') { quoted = true; delim += s[k + 1] ?? ''; k += 2; continue }
        if (/[\s;&|()<>`]/.test(d))
          break
        delim += d
        k++
      }
      if (k > from)
        pending.push({ delim, strip, quoted, frame: f, from: f.pipe, to: -1 })
      f.cur += s.slice(n, k)
      n = k - 1
      ws = false
      continue
    }
    // `&` inside `2>&1`, `<&3`, and `&>file`, and `|` inside `>|file`, belong to a redirect.
    if ((c === '&' && (afterOp || s[n + 1] === '>')) || (c === '|' && afterOp && s[n - 1] === '>')) { f.cur += c; ws = false; continue }
    if (c === '\n') {
      out.push(f.cur)
      f.cur = ''
      ws = true
      if (pending.length > 0) {
        // Bodies start on the next line, in order. A body is data unless a shell reads it (a
        // shell heads its pipeline or an enclosing command): then it is lexed as commands. An
        // unquoted delimiter still runs the body's substitutions.
        const around = stack.map(x => x.cur)
        const shells = pending.map(h => [...out.slice(h.from, h.to < 0 ? out.length : h.to), ...around].some(seg => SHELLS.has(resolveHead(tokenize(seg)).head)))
        let k = n + 1
        for (const [p, h] of pending.entries()) {
          const { end, next } = heredocEnd(s, k, h, f.close)
          if (shells[p])
            out.push(...lex(s.slice(k, end), false))
          else if (!h.quoted)
            out.push(...lex(s.slice(k, end), true))
          k = next
        }
        pending.length = 0
        n = k - 1
      }
      endPipe()
      continue
    }
    if (c === ';' || c === '&' || c === '|') {
      out.push(f.cur)
      f.cur = ''
      ws = true
      // `|` and `|&` join a pipeline; `;`, `&`, `&&`, and `||` end it.
      if (!((c === '|' && s[n + 1] !== '|' && s[n - 1] !== '|') || (c === '&' && s[n - 1] === '|')))
        endPipe()
      continue
    }
    f.cur += c
    ws = /\s/.test(c)
    op = c === '<' || c === '>'
  }
  for (const [k, frame] of stack.entries()) {
    if (!(body && k === 0))
      out.push(frame.cur)
  }
  return out
}

/**
 * Split a command string into the simple commands bash would run: at `;`, `&`, `|`, and
 * newlines, and into `(…)`, `$(…)`, and backtick bodies, including a substitution inside
 * double quotes or an unquoted-delimiter heredoc, where bash still runs it. Quoted text,
 * comments, and heredoc bodies are data, except a body a shell reads. A substitution leaves
 * SUBST in the word around it.
 */
export function segments(s: string): string[] {
  return lex(s, false)
}

// A redirect operator glued after a command word: `npm</dev/null` splits to `npm`,
// `</dev/null` so the head is not hidden. The operator starts at the first `<` or `>`, or at a
// `&` just before `>`. An empty or all-digit prefix (`2>&1`, `&>/dev/null`) stays one token,
// handled by skip() and the secret redirect scan. A plain scan: the regex this replaced
// backtracked quadratically over a long run of digits.
function splitRedirect(raw: string): [string, string] | null {
  let at = raw.search(/[<>]/)
  if (at < 0)
    return null
  if (raw[at] === '>' && raw[at - 1] === '&')
    at--
  const word = raw.slice(0, at)
  return word === '' || /^\d+$/.test(word) ? null : [word, raw.slice(at)]
}

// Unescape one word the way bash does: a backslash escapes the next character outside quotes,
// only `$`, `` ` ``, `"`, and `\` inside double quotes, and nothing inside single quotes. So a
// quoted Windows path (`'C:\repo\.env'`) keeps its separators and the secret guard still sees
// them; the old unconditional strip turned it into `C:repo.env`. Quote state is per word.
function unescapeWord(raw: string): string {
  let out = ''
  let q: string | null = null
  for (let n = 0; n < raw.length; n++) {
    const c = raw[n]!
    if (q === '\'') {
      if (c === '\'')
        q = null
      out += c
      continue
    }
    if (q === '"') {
      if (c === '\\' && /["$`\\]/.test(raw[n + 1] ?? '')) { out += raw[n + 1]; n++; continue }
      if (c === '"')
        q = null
      out += c
      continue
    }
    if (c === '\'' || c === '"') { q = c; out += c; continue }
    if (c === '\\') { out += raw[n + 1] ?? ''; n++; continue }
    out += c
  }
  return out
}

// Whitespace-tokenize a segment, peel a glued redirect operator off each word, and unescape.
export function tokenize(seg: string): string[] {
  const out: string[] = []
  for (const raw of seg.trim().split(/\s+/).filter(Boolean)) {
    const split = splitRedirect(raw)
    if (split)
      out.push(unescapeWord(split[0]), unescapeWord(split[1]))
    else
      out.push(unescapeWord(raw))
  }
  return out
}

// A glob character bash leaves as text, hidden behind a byte no glob or separator uses.
function hideGlob(c: string): string {
  return c === '*' || c === '?' || c === '[' ? '\0' : c
}

/**
 * tokenize(seg) with every glob character (`*`, `?`, `[`) that bash never expands, one inside
 * quotes or after a backslash, replaced by NUL. It lines up word for word with tokenize(seg):
 * read a word's text from that and the globs bash expands in it from this, so a quoted grep
 * pattern (`".*"`) is never taken for a path glob.
 */
export function globTokens(seg: string): string[] {
  let text = ''
  let q = '' // the open quote: `"`, `'`, or `$` for ANSI-C `$'…'`
  for (let n = 0; n < seg.length; n++) {
    const c = seg[n]!
    if (c === '\\' && q !== '\'') {
      text += c + hideGlob(seg[n + 1] ?? '')
      n++
    }
    else if (q) {
      if (c === (q === '"' ? '"' : '\''))
        q = ''
      text += hideGlob(c)
    }
    else if (c === '$' && seg[n + 1] === '\'') {
      q = '$'
      text += '$\''
      n++
    }
    else {
      if (c === '"' || c === '\'')
        q = c
      text += c
    }
  }
  return tokenize(text)
}

// A redirection word: an optional fd (`2`, `{fd}`), the operator, and a glued target.
const REDIRECTION = /^(?:\d+|\{\w+\})?(?:&>>?|[<>]&|>>|>\||<>|<<<|<<-?|[<>])(.*)$/s

/**
 * How many words at `toks[k]` a redirection spans: 0 when it is none, 1 for a glued target
 * (`2>&1`, `>log`), and 2 for a bare operator whose target is the next word (`> log`). bash
 * never passes these to the program, so an argv parser skips them.
 */
export function redirectWidth(toks: string[], k: number): 0 | 1 | 2 {
  const m = REDIRECTION.exec(toks[k] ?? '')
  if (!m)
    return 0
  return m[1] === '' && k + 1 < toks.length ? 2 : 1
}

/**
 * The words of a command minus its redirections: the argv bash hands the program. Tokens come
 * from tokenize(), which ignores quotes, so use it only where no free text is expected
 * (`git push` refspecs), never over a quoted message.
 */
export function withoutRedirects(toks: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < toks.length; k++) {
    const w = redirectWidth(toks, k)
    if (w === 0)
      out.push(toks[k]!)
    else
      k += w - 1
  }
  return out
}

// Index of the command head: skip leading VAR=val, wrapper words + a value-flag's value,
// redirects, brace-group tokens and option flags. A flag's arity is PER WRAPPER — tracked via
// `curWrap` (the base() of the most recent wrapper word) so `sudo -n` stays boolean while
// `nice -n 10` consumes its value. For a positional-taking wrapper (timeout/flock/taskset), also
// consume its one leading positional after any of its own flags. All wrapper decisions use
// base() so a path-prefixed wrapper (`/usr/bin/sudo`) is recognised. A positional/value that
// would itself be a banned head is never consumed (fail toward deny).
export function leadIndex(toks: string[]): number {
  let i = 0
  let curWrap = ''
  while (i < toks.length && skip(toks[i]!)) {
    const t = toks[i]!
    // `mise x|exec [tool@version ...] [--] cmd`: the tool specs (a `@` in the word) and flags
    // are skipped up to the `--` or the first token that is not a spec. Any other mise
    // subcommand (`mise run`, `mise install`) is not a wrapper and mise stays the head.
    if (base(t) === 'mise') {
      const sub = unquote(toks[i + 1] ?? '')
      if (sub !== 'x' && sub !== 'exec')
        return i
      i += 2
      const miseFlags = WRAP_VALUE_FLAGS.get('mise')
      while (i < toks.length) {
        const a = toks[i]!
        if (a === '--') { i++; break }
        if (a.startsWith('-')) {
          i++
          if (miseFlags?.has(a) && i < toks.length && !wouldHideHead(toks[i]!))
            i++
          continue
        }
        if (/^[\w@./+-]+@[\w./+-]*$/.test(a) && !wouldHideHead(a)) { i++; continue }
        break
      }
      curWrap = 'mise'
      continue
    }
    if (t.startsWith('-')) {
      i++
      const vf = WRAP_VALUE_FLAGS.get(curWrap)
      if (vf?.has(t) && i < toks.length && !wouldHideHead(toks[i]!))
        i++
      continue
    }
    const b = base(t)
    if (WRAP.has(b)) {
      curWrap = b
      i++
      const mode = POSITIONAL_MODE.get(b)
      if (mode) {
        let consumedValue = false
        while (i < toks.length && toks[i]!.startsWith('-')) {
          const f = toks[i]!
          i++
          const vf = WRAP_VALUE_FLAGS.get(b)
          if (vf?.has(f) && i < toks.length && !wouldHideHead(toks[i]!)) {
            consumedValue = true
            i++
          }
        }
        const takePositional = mode === 'always' || !consumedValue
        if (takePositional && i < toks.length && !wouldHideHead(toks[i]!))
          i++
      }
      continue
    }
    // A skipped non-flag, non-wrapper token (VAR=val, redirect, brace, bare digit): advance but
    // keep curWrap so a following option flag still resolves to its wrapper's arity.
    i++
  }
  return i
}

export interface Head { i: number, head: string, probe: boolean }

// Resolve the real command head: lead-skip, detect a leading `command -v` PROBE (never an
// argument to a real head), then LOOP-unwrap `pnpm [flags] exec|dlx|x <cmd>` repeatedly so
// nested `pnpm exec pnpm exec npm` resolves through to `npm`.
export function resolveHead(toks: string[]): Head {
  const i0 = leadIndex(toks)
  const probe = toks.some((t, k) => k < i0 && unquote(t) === 'command' && /^-[vV]$/.test(unquote(toks[k + 1] ?? '')))
  let i = i0
  while (base(toks[i] ?? '') === 'pnpm') {
    let e = i + 1
    while (e < toks.length) {
      const t = unquote(toks[e]!)
      if (t.startsWith('-')) { if (PNPM_VALUE_FLAG.has(t)) e++; e++; continue }
      break
    }
    if (e < toks.length && /^(exec|dlx|x)$/.test(unquote(toks[e]!))) {
      let k = e + 1
      while (k < toks.length && skip(toks[k]!)) k++
      i = k
    }
    else {
      break
    }
  }
  return { i, head: base(toks[i] ?? ''), probe }
}

// `git` global options that take a SEPARATE value token (the `--opt=value` spelling is one token).
const GIT_VALUE_OPT: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

/**
 * The subcommand after `git` and its global options (`git -C x -c k=v push …`): the subcommand,
 * its argv, and the unquoted global-option tokens (values included) for callers that inspect them.
 */
export function gitSubcommand(toks: string[], i: number): { sub: string, args: string[], globals: string[] } {
  let k = i + 1
  while (k < toks.length) {
    const t = unquote(toks[k]!)
    if (!t.startsWith('-'))
      break
    k++
    if (GIT_VALUE_OPT.has(t))
      k++
  }
  return { sub: unquote(toks[k] ?? ''), args: toks.slice(k + 1), globals: toks.slice(i + 1, k).map(unquote) }
}

/**
 * `tool_input.command` of a pre-tool payload, or null when the JSON is malformed or the field is
 * missing, null, or not a string — callers deny (fail closed). A present empty string is a
 * command with nothing to run and is returned as such.
 */
export function commandOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { tool_input?: { command?: unknown } | null } | null
    const cmd = parsed?.tool_input?.command
    return typeof cmd === 'string' ? cmd : null
  }
  catch {
    return null
  }
}

/**
 * What a guard may consult besides the command: the directory the tool call runs in (the
 * push guard resolves an implicit branch there), the environment (PROTECTED_BRANCHES), and
 * the settings file the push guard falls back to when the variable is unset. The dispatcher
 * builds it once per call; the fixture suite builds one per case, so a guard never reads
 * process.cwd(), process.env, or its own location directly.
 */
export interface GuardContext {
  cwd: string
  env: NodeJS.ProcessEnv
  settingsFile: string
}

/** The shape every `deny-*.mts` guard exports: the deny reason for a command, or null to allow. */
export type Verdict = (cmd: string, ctx: GuardContext) => string | null
