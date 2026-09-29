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
  'busybox',
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

/**
 * The command name a word runs, as the guards compare it: quotes and directories (either
 * separator) dropped, lowercased, and a Windows launcher suffix (`.exe`, `.cmd`, `.bat`,
 * `.ps1`) and an `@version` suffix (`corepack yarn@1`) stripped, so `NPM`, `npm.cmd`, and
 * `C:\nodejs\npm.exe` all name npm.
 */
export function base(t: string): string {
  const name = (unquote(t).split(/[/\\]/).pop() ?? '').toLowerCase()
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/, '').replace(/(?<=.)@[^@]*$/, '')
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
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'ash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'pwsh', 'powershell', 'su', 'source', '.'])

// Whether a command starts a shell that reads its stdin as commands: a shell head (`bash`,
// `busybox sh`, `sudo su`), or `sudo -s`, `sudo -i`, or `doas -s` with no command after them.
function startsShell(toks: string[]): boolean {
  const argv = withoutRedirects(toks)
  const { i, head } = resolveHead(argv)
  if (SHELLS.has(head))
    return true
  if (i < argv.length)
    return false
  let wrap = ''
  for (const t of argv) {
    const flag = unquote(t)
    if (WRAP.has(base(t)))
      wrap = base(t)
    else if (wrap === 'sudo' && /^(?:-[A-Za-z]*[is][A-Za-z]*|--shell|--login)$/.test(flag))
      return true
    else if (wrap === 'doas' && /^-[A-Za-z]*s[A-Za-z]*$/.test(flag))
      return true
  }
  return false
}

// Reserved words a command can follow, so a `(` glued to one still opens a subshell
// (`if(npm i)`, `{(npm i)}`). A `(` glued to any other word is part of that word, as in an
// extglob (`@(a|b)`) or a `[[ =~ ]]` regex (`^(#|$)`), or a syntax error bash never runs.
const BEFORE_COMMAND: ReadonlySet<string> = new Set(['!', '{', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', 'time', 'coproc'])

// One command context: the input itself, a `(` subshell, or a `$(` / backtick substitution.
// `q` is the quote state inside it: `"`, `'`, `$` (ANSI-C `$'…'`), or `h` (the body of a
// heredoc with an unquoted delimiter, where only `$(`, backticks, and `\` are special).
// `pipe` is the index in the output where its current pipeline's first segment lands, and
// `here` holds the heredocs of that pipeline. `lead` caches leadOf(cur) once it is final, and
// `script` records, once asked, whether a shell runs what the frame prints (feedsShell).
// `test` is set inside `[[ … ]]`, and `paren` counts the open parentheses that belong to a word
// or a `[[` expression (`@(a|b)`, `^(#|$)`) rather than to a subshell. `cmd` is set while the
// next word stands where a command starts, where `[[`, `{`, and `}` are reserved words.
// `group` is the frame itself as a group of its parent (null for the input), `braces` the open
// `{ … }` groups, `closed` the groups closed in the current segment, and `sinks` those whose
// pipeline is still open. `joined` is set when the last segment ended in `|` or `|&`.
interface Frame {
  close: '' | ')' | '`'
  subst: boolean
  arith: boolean
  q: '' | '"' | '\'' | '$' | 'h'
  cur: string
  brace: number
  pipe: number
  here: Heredoc[]
  test: boolean
  paren: number
  cmd: boolean
  group: Group | null
  braces: Group[]
  closed: Group[]
  sinks: Group[]
  joined: boolean
  lead?: Lead | undefined
  script?: boolean
}
// A heredoc, the output range of the pipeline that owns it (`to` is -1 while that pipeline is
// open), its body once read, and the innermost group around it. A shell head in that range
// reads the body as commands, and so does a shell that runs the frame it sits in (`script`),
// or a shell in a later stage of the pipeline that carries any group around it.
interface Heredoc { delim: string, strip: boolean, quoted: boolean, from: number, to: number, script: boolean, group: Group | null, body?: string }
// A `{ … }` group or a nested frame, whose output flows on through the pipeline holding it:
// [from, to) are the segments of that pipeline after the one holding the group (-1 until
// known), and `up` is the group around this one. `reaches` records, once worked out, whether a
// shell follows this group or any group around it.
interface Group { from: number, to: number, up: Group | null, reaches?: boolean }

// What a command does with the text of a substitution in it, read from its leading words:
// `shell` when a shell heads it, `runs` when it runs a command string (`eval`, a shell's `-c`).
// `final` once later words cannot change either. Only the first LEAD characters are read: the
// head and its options sit there, and the bound keeps a huge command linear.
interface Lead { shell: boolean, runs: boolean, final: boolean }
const LEAD = 1024

function leadOf(cur: string): Lead {
  const toks = tokenize(cur.slice(0, LEAD))
  const long = cur.length > LEAD
  const { i, head } = resolveHead(toks)
  if (toks.slice(0, i).some(t => base(t) === 'eval'))
    return { shell: false, runs: true, final: true }
  if (!SHELLS.has(head))
    return { shell: false, runs: false, final: long || (i + 1 < toks.length && head !== 'pnpm') }
  for (let k = i + 1; k < toks.length; k++) {
    const t = unquote(toks[k]!)
    if (/^-[a-z]*c[a-z]*$/i.test(t))
      return { shell: true, runs: true, final: true }
    if (/^[-+]o$/i.test(t)) { k++; continue } // `bash -o pipefail -c …`
    if (!/^[-+]/.test(t))
      return { shell: true, runs: false, final: true }
  }
  return { shell: true, runs: false, final: long }
}

// Whether a shell runs what `child` prints as commands, judged by the parent's command before
// the child opened: a process substitution handed to a shell as its script (`bash <(…)`,
// `source <(…)`), a substitution in a shell's here-string (`bash <<< "$(…)"`), or one under
// `eval` or a shell's `-c`. One passed to a shell as a plain argument (`bash x.sh "$(…)"`) is
// data the script receives.
function feedsShell(parent: Frame, child: Frame): boolean {
  let lead = parent.lead
  if (!lead) {
    lead = leadOf(parent.cur)
    if (lead.final)
      parent.lead = lead
  }
  return lead.runs || (lead.shell && ((!child.subst && parent.cur.endsWith('<')) || /<<<\s*"?$/.test(parent.cur)))
}

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
  const frame = (close: Frame['close'], subst: boolean, arith: boolean, group: Group | null): Frame =>
    ({ close, subst, arith, q: '', cur: '', brace: 0, pipe: out.length, here: [], test: false, paren: 0, cmd: true, group, braces: [], closed: [], sinks: [], joined: false })
  const stack: Frame[] = [frame('', false, false, null)]
  let f = stack[0]!
  if (body)
    f.q = 'h'
  let ws = true // at the start of a word, where `#` opens a comment
  let op = false // the last character was an unquoted `<` or `>`, so a `&` or `|` extends it
  const pending: Heredoc[] = [] // heredocs whose body starts at the next newline
  const bodies: Heredoc[] = [] // heredocs whose body is read, judged once the input ends
  // Per output index: whether a shell heads that segment. Tokenized at most once, so many
  // heredocs in one long pipeline stay linear.
  const shellAt: (boolean | undefined)[] = []
  const isShellAt = (x: number): boolean => (shellAt[x] ??= startsShell(tokenize(out[x]!)))
  // Whether a shell runs what the innermost open frame prints. A parent's text stays fixed
  // while a child is open, so each frame's answer is worked out once and kept.
  const scripted = (): boolean => {
    let k = stack.length - 1
    while (k > 0 && stack[k]!.script === undefined) k--
    let on = k > 0 && stack[k]!.script === true
    for (k++; k < stack.length; k++) {
      on ||= feedsShell(stack[k - 1]!, stack[k]!)
      stack[k]!.script = on
    }
    return on
  }
  const inner = (): Group | null => f.braces.at(-1) ?? f.group
  const open = (close: ')' | '`', subst: boolean, arith: boolean): void => {
    f = frame(close, subst, arith, { from: -1, to: -1, up: inner() })
    stack.push(f)
    ws = true
  }
  // A segment ends: its text goes out and the frame starts a new command. A group closed in it
  // flows into the segments that follow.
  const cut = (): void => {
    out.push(f.cur)
    f.cur = ''
    f.lead = undefined
    f.cmd = true
    for (const g of f.closed) {
      g.from = out.length
      f.sinks.push(g)
    }
    f.closed = []
    ws = true
  }
  // `;`, `&`, `&&`, `||`, and a newline end the current frame's pipeline.
  const endPipe = (): void => {
    for (const h of f.here)
      h.to = out.length
    f.here = []
    for (const g of f.sinks)
      g.to = out.length
    f.sinks = []
    f.pipe = out.length
  }
  // A word ends. At a command start, `[[` opens a conditional, `{` a group, and `}` closes one;
  // inside `[[ … ]]`, `]]` closes it. Only the last seven characters are read (no reserved word
  // is longer), so a long segment stays linear.
  const endWord = (): void => {
    const tail = f.cur.slice(-7)
    const at = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\t'), tail.lastIndexOf('\n'))
    const w = at < 0 && f.cur.length > 7 ? '\0' : tail.slice(at + 1)
    if (w === '')
      return
    if (f.test) {
      if (w === ']]') {
        f.test = false
        f.paren = 0
        f.cmd = false
      }
      return
    }
    if (f.cmd && w === '[[')
      f.test = true
    else if (f.cmd && w === '{')
      f.braces.push({ from: -1, to: -1, up: inner() })
    else if (f.cmd && w === '}' && f.braces.length > 0)
      f.closed.push(f.braces.pop()!)
    f.cmd &&= BEFORE_COMMAND.has(w)
  }
  // Whether the `(` at n is glued to the word before it, and not to a reserved word (none is
  // longer than six characters, so only the last seven are read).
  const glued = (n: number): boolean => {
    if (/[\s;&|<>()`=]/.test(s[n - 1] ?? ' '))
      return false
    const tail = f.cur.slice(-7)
    const word = tail.slice(tail.search(/\S*$/))
    return word.length === 7 || !BEFORE_COMMAND.has(word)
  }
  // A frame closes: its last segment goes out, its pipelines end, and as a group it flows into
  // the segments of its parent's pipeline that follow the one holding it.
  const pop = (): void => {
    cut()
    endPipe()
    const done = stack.pop()!
    f = stack.at(-1)!
    if (done.group)
      f.closed.push(done.group)
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
    if (c === '(') {
      // Inside `[[ … ]]` a `(` groups, except a process substitution (`<(…)`), which runs.
      if ((f.test || f.paren > 0) ? !/[<>]/.test(s[n - 1] ?? '') : glued(n)) { f.paren++; f.cur += c; ws = false; continue }
      open(')', false, f.arith || s[n + 1] === '(')
      continue
    }
    if (c === ')') {
      endWord()
      if (f.paren > 0) { f.paren--; f.cur += c; ws = false; continue }
      if (f.close === ')') { pop(); continue }
    }
    // A comment runs to the end of the line; inside backticks, to the closing backtick. Inside
    // `[[ … ]]` and a word's own parentheses, bash reads a `#` as text.
    if (c === '#' && ws && f.brace === 0 && !f.arith && !f.test && f.paren === 0) {
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
      if (k > from) {
        const h: Heredoc = { delim, strip, quoted, from: f.pipe, to: -1, script: scripted(), group: inner() }
        pending.push(h)
        f.here.push(h)
      }
      f.cur += s.slice(n, k)
      n = k - 1
      ws = false
      continue
    }
    // `&` inside `2>&1`, `<&3`, and `&>file`, and `|` inside `>|file`, belong to a redirect.
    if ((c === '&' && (afterOp || s[n + 1] === '>')) || (c === '|' && afterOp && s[n - 1] === '>')) { f.cur += c; ws = false; continue }
    if (c === '\n') {
      endWord()
      // A line ending in `|` or `|&` continues its pipeline after any heredoc bodies, so
      // `cat <<EOF |`, the body, then `bash` hands the body to bash.
      const joined = f.joined && /^\s*$/.test(f.cur)
      cut()
      // Bodies start on the next line, in order. Each is read here and judged at the end, once
      // every pipeline that can carry it to a shell has ended.
      let k = n + 1
      for (const h of pending) {
        const { end, next } = heredocEnd(s, k, h, f.close)
        h.body = s.slice(k, end)
        bodies.push(h)
        k = next
      }
      pending.length = 0
      n = k - 1
      if (!joined) {
        endPipe()
        f.joined = false
      }
      continue
    }
    if (c === ';' || c === '&' || c === '|') {
      endWord()
      cut()
      // `|` and `|&` join a pipeline; `;`, `&`, `&&`, and `||` end it.
      f.joined = (c === '|' && s[n + 1] !== '|' && s[n - 1] !== '|') || (c === '&' && s[n - 1] === '|')
      if (!f.joined)
        endPipe()
      continue
    }
    if (c === ' ' || c === '\t')
      endWord()
    f.cur += c
    // Bash separates words only at a space, a tab, or a newline (handled above): a `#` after a
    // no-break space, CR, form feed, or vertical tab is part of the word, not a comment.
    ws = c === ' ' || c === '\t'
    op = c === '<' || c === '>'
  }
  // The input ends: the text of every open frame goes out, and every open range ends.
  for (const [k, fr] of stack.entries()) {
    if (!(body && k === 0))
      out.push(fr.cur)
  }
  for (const fr of stack) {
    for (const h of fr.here)
      h.to = out.length
    for (const g of [...fr.closed, ...fr.sinks]) {
      if (g.from < 0)
        g.from = out.length
      g.to = out.length
    }
  }
  // A body is data unless a shell reads it: a shell heads its pipeline, runs the frame it sits
  // in, or follows a group around it in that group's pipeline. Then it is lexed as commands; an
  // unquoted delimiter still runs the body's substitutions. Heredocs in one pipeline share its
  // range, so each range is scanned once.
  const ranges = new Map<string, boolean>()
  const shellIn = (from: number, to: number): boolean => {
    const key = `${from}:${to}`
    let found = ranges.get(key)
    if (found === undefined) {
      found = false
      for (let x = from; x < to && !found; x++)
        found = isShellAt(x)
      ranges.set(key, found)
    }
    return found
  }
  // Whether a shell follows a group or any group around it, kept on each group on the way, so
  // many heredocs in deeply nested groups stay linear.
  const reaches = (g: Group | null): boolean => {
    const path: Group[] = []
    let known = false
    for (let x = g; x; x = x.up) {
      if (x.reaches !== undefined) {
        known = x.reaches
        break
      }
      path.push(x)
    }
    for (const x of path.reverse()) {
      known ||= shellIn(x.from, x.to)
      x.reaches = known
    }
    return known
  }
  for (const h of bodies) {
    const shell = h.script || shellIn(h.from, h.to) || reaches(h.group)
    if (shell)
      out.push(...lex(h.body ?? '', false))
    else if (!h.quoted)
      out.push(...lex(h.body ?? '', true))
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

/**
 * The NAME=VALUE words a segment exports to every later command of the session, unquoted:
 * each assignment after `export`, or after `declare`, `typeset`, or `local` given `-x`
 * (`declare -gx`). Any other segment exports none; an inline prefix (`X=1 cmd`) reaches only
 * its own command and is read from the tokens directly.
 */
export function exportedAssignments(toks: string[]): string[] {
  const { i, head } = resolveHead(toks)
  const words = toks.slice(i + 1).map(unquote)
  const exports = head === 'export' || (/^(?:declare|typeset|local)$/.test(head) && words.some(w => /^-[A-Za-z]*x/.test(w)))
  return exports ? words.filter(w => /^[A-Za-z_]\w*=/.test(w)) : []
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
