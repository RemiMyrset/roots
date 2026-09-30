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
// wrapper words are documented out-of-scope in docs/template/guards.md. bash's reserved words
// that start a command are a closed set, so every one of them is here.
export const WRAP: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'runuser', 'env', 'command', 'exec', 'eval', 'time', 'timeout', 'nice',
  'ionice', 'taskset', 'chrt', 'nohup', 'setsid', 'stdbuf', 'unbuffer', 'flock', 'xargs',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'builtin', 'corepack', 'mise',
  'busybox', 'coproc',
])

// The words that open a compound command, after which `coproc NAME` names the coprocess
// (`coproc X { …; }`); before any other word, NAME is the command itself (`coproc npm i`).
const COMPOUND: ReadonlySet<string> = new Set(['{', 'while', 'until', 'if', 'for', 'select', 'case', '[['])

// pnpm global flags that take a separate value (between `pnpm` and its subcommand).
export const PNPM_VALUE_FLAG: ReadonlySet<string> = new Set([
  '--filter', '-F', '--filter-prod', '-C', '--dir', '--config',
  '--workspace-concurrency', '--reporter', '--loglevel', '--store-dir',
])

// Wrapper option flags that consume a SEPARATE value token — PER WRAPPER, because a flag is
// value-taking for one wrapper (nice -n 10, timeout -s KILL) yet boolean for another (sudo -n,
// flock -n). A single global set mis-parsed both directions and let the value/head shift; keep
// these lists complete per wrapper. Command-string flags (-c) are deliberately excluded: the
// string is no head, and segments() reads it as a command of its own. Unknown/keyword wrappers
// are absent from the map and so consume no value.
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
  // mise x|exec: directory, env profile, jobs, profile take a value; -c/--command takes a
  // command string, which segments() reads as a command of its own.
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

// A command substitution as the lexer leaves it (SUBST) or a parameter expansion (`${x}`, `$x`,
// `$1`, `$@`): text whose value is unknown here and may be empty. A `${…}` holding a quote, a
// backslash, or a backtick stays text: bash ends it past a quoted `}` (`${x:-'}'}`), which this
// pattern cannot follow, and reading it short would desync globTokens from tokenize.
const EXPANSION = String.raw`\$\(\)|\$\{[^{}'"\\\x60]*\}|\$(?:[A-Za-z_]\w*|[\d@*#?$!-])`
const EXPANSIONS = new RegExp(EXPANSION, 'g')
const LEADING_EXPANSIONS = new RegExp(String.raw`^(?:\(|${EXPANSION})+`)

/** A word with every substitution and parameter expansion in it dropped, as when each is empty. */
export function withoutExpansions(t: string): string {
  return t.replace(EXPANSIONS, '')
}

/**
 * The command name a word runs, as the guards compare it: quotes and directories (either
 * separator) dropped, lowercased, and a Windows launcher suffix (`.exe`, `.cmd`, `.bat`,
 * `.ps1`) and an `@version` suffix (`corepack yarn@1`) stripped, so `NPM`, `npm.cmd`, and
 * `C:\nodejs\npm.exe` all name npm. pnpm's own `pn` names pnpm. A leading `(` is dropped too:
 * the lexer opens a subshell there, so a word that still starts with one is a misread, and it
 * names what it runs. So is a substitution glued before the name (`$(true)npm`, SUBST in the
 * word), which may print nothing, and a parameter expansion (`${x}npm`, `$x/npm`), which may be
 * empty.
 */
export function base(t: string): string {
  const name = (unquote(t).replace(LEADING_EXPANSIONS, '').split(/[/\\]/).pop() ?? '').toLowerCase()
  const bare = name.replace(/\.(?:exe|cmd|bat|ps1)$/, '').replace(/(?<=.)@[^@]*$/, '')
  return bare === 'pn' ? 'pnpm' : bare
}

/** pnpm's own shorthands for `pnpm dlx`, which resolveHead() unwraps like it. */
export const PNPM_DLX: ReadonlySet<string> = new Set(['pnpx', 'pnx'])

// Would consuming `tok` as a wrapper positional / value-flag argument hide a command the guards
// must inspect? If so, refuse to consume it and let it fall through as the head (fail toward
// deny). Covers the banned package managers and pnpm (its shorthands too) and corepack — the
// heads the lexer natively knows; a reader head (deny-secret-reads) mis-consumed by a
// duration-less `timeout` is left as a documented, shell-rejected non-exploitable edge.
export function wouldHideHead(tok: string): boolean {
  const b = base(tok)
  return BANNED.has(b) || b === 'pnpm' || PNPM_DLX.has(b) || b === 'corepack'
}

/**
 * Whether the head search passes over a word: a brace, an assignment, a wrapper, a redirect, a
 * number, a flag, or a word made only of unquoted substitutions (SUBST) and parameter
 * expansions, which expands to nothing when they are empty, so the word after it may be the
 * command (`$(true) npm i`, `$(a)$(b) npm i`, `$x npm i`). An expansion with a default stays
 * the head: defaulted() reads the command it runs (`${x:-npm} i`).
 */
export function skip(t: string): boolean {
  return t === '{' || t === '}' || (t !== '' && withoutExpansions(t) === '' && !DEFAULTED.test(t)) || /^[A-Za-z_]\w*=/.test(t) || WRAP.has(base(t))
    || /^(?:\d*[<>]|&>)/.test(t) || /^\d+$/.test(t) || t.startsWith('-')
}

/**
 * The word a command substitution leaves behind in the command around it, and a process
 * substitution after its `<` or `>`. Its output is unknowable here, so the enclosing word keeps
 * this marker instead: argument positions stay aligned, and the push guard resolves a target
 * that is only this marker like `HEAD`.
 */
export const SUBST = '$()'

// Heads that run a heredoc body as shell commands, so that body is lexed like the command line.
const SHELLS: ReadonlySet<string> = new Set(['bash', 'rbash', 'sh', 'ash', 'zsh', 'dash', 'ksh', 'mksh', 'oksh', 'yash', 'posh', 'csh', 'tcsh', 'fish', 'pwsh', 'powershell', 'su', 'source', '.'])

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

// Whether a segment starts such a shell itself or in what it hands back to the parser
// (reparsed(): `eval "bash -s" <<'EOF'`), read again as segments() reads it.
function shellReads(seg: string, pass = 0): boolean {
  if (startsShell(tokenize(seg)))
    return true
  return pass < REPARSE && reparsed(seg).some(source => lex(source, false).some(x => shellReads(x, pass + 1)))
}

// Reserved words a command can follow, so a `(` glued to one still opens a subshell
// (`if(npm i)`, `{(npm i)}`). A `(` glued to any other word is part of that word, as in an
// extglob (`@(a|b)`) or a `[[ =~ ]]` regex (`^(#|$)`), or a syntax error bash never runs.
const BEFORE_COMMAND: ReadonlySet<string> = new Set(['!', '{', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', 'time', 'coproc'])

// One command context: the input itself, a `(` subshell, a `$(`, backtick, or `${ …; }`
// substitution, or a `$[…]` arithmetic expansion, which `close` ends. `q` is the quote state
// inside it: `"`, `'`, `$` (ANSI-C `$'…'`), or `h` (the body of a heredoc with an unquoted
// delimiter, where only `$(`, backticks, and `\` are special). `brace` counts the open `${…}`
// expansions, and `dq` holds the depths of those opened inside double quotes, which resume at
// their `}`. `bracket` counts the open `[` inside a `$[…]`, or inside an array's `[…]` span.
// `pipe` is the index in the output where its current pipeline's first segment lands, and
// `here` holds the heredocs of that pipeline. `lead` caches leadOf(cur) once it is final, and
// `script` records, once asked, whether a shell runs what the frame prints (feedsShell).
// `test` is set inside `[[ … ]]`, and `paren` counts the open parentheses that belong to a word
// or a `[[` expression (`@(a|b)`, `^(#|$)`) rather than to a subshell. `cmd` is set while the
// next word stands where a command starts, where `[[`, `{`, `}`, `case`, and `function` are
// reserved words. `closer` is set right after a word that ends a compound command (`}`, `fi`,
// `done`, `esac`, `]]`), after which bash still reads a `}`, `fi`, `done`, `esac`, and the
// words that start a command as reserved words (`fi }`, `} }`, `fi done`, `} then`).
// `fn` is set after `function`, whose next word names the function. `cases`
// counts the open `case` statements, `subject` the words left before their patterns (the tested
// word, then `in`), and `pat` is set inside a pattern, which runs to its `)`.
// `group` is the frame itself as a group of its parent (null for the input), `braces` the open
// `{ … }` groups, `closed` the groups closed in the current segment, and `sinks` those whose
// pipeline is still open. `joined` is set when the last segment ended in `|` or `|&`. `word` is
// set on a `(` that belongs to the word before it, a process substitution (`<(…)`) or an array
// (`x=(…)`), so the word runs on after its `)`, as it does after a substitution's; `array` marks
// the array, whose words bash reads one by one (rejects()). `held` counts
// the heredocs waiting for a body when the frame opened: bash ends one opened inside backticks
// at the closing backtick, with no body (`` `cat <<E` ``), so the next line is a command.
// `tick` is the stack index of the innermost backtick frame at or below this one (-1 if none):
// bash ends that substitution at its first unescaped backtick, whatever is open inside it.
// In the bash 3.2 reading (lex()'s `old`), `scan` marks a frame inside the parenthesis count that
// bash 3.2 runs to find the end of a `$(…)`, `<(…)`, or `>(…)`, and `hash` one where that count
// skips a `#` comment; `sub` counts the open `[` of an assignment's subscript (`a[…]=`), whose
// bracket count ends it, and `subBrace` is the `brace` count when it opened.
interface Frame {
  close: '' | ')' | '`' | '}' | ']'
  subst: boolean
  word: boolean
  array: boolean
  arith: boolean
  tick: number
  scan: boolean
  hash: boolean
  sub: number
  subBrace: number
  q: '' | '"' | '\'' | '$' | 'h'
  cur: string
  brace: number
  bracket: number
  dq: number[]
  pipe: number
  here: Heredoc[]
  test: boolean
  paren: number
  cmd: boolean
  closer: boolean
  fn: boolean
  cases: number
  subject: number
  pat: boolean
  group: Group | null
  braces: Group[]
  closed: Group[]
  sinks: Group[]
  joined: boolean
  held: number
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

// A heredoc body ends at its delimiter line (leading tabs dropped for `<<-`), compared with and
// without a trailing CR, so a CRLF line ends it and so does a delimiter that keeps its CR
// (`<<EOF\r>x`). With an unquoted delimiter, a line ending in an odd number of backslashes runs
// on into the next, as bash joins them (`EO\<newline>F` is `EOF`). Inside `$(`, a line starting
// with the delimiter and `)` also ends it, and inside backticks (`tick`, at any depth) the first
// unescaped backtick does, as bash does. Returns the body's end and where lexing resumes.
function heredocEnd(s: string, k: number, h: Heredoc, close: Frame['close'], tick: boolean): { end: number, next: number } {
  const lineEnd = (x: number): number => {
    const e = s.indexOf('\n', x)
    return e < 0 ? s.length : e
  }
  // Whether the line that ends at `e` ends in an odd number of backslashes.
  const continues = (e: number): boolean => {
    let x = e
    while (x > k && s[x - 1] === '\\') x--
    return (e - x) % 2 === 1
  }
  while (k < s.length) {
    const first = lineEnd(k)
    let e = first
    while (!h.quoted && e < s.length && continues(e)) e = lineEnd(e + 1)
    const span = s.slice(k, e)
    const bt = tick ? tickIn(s, k, e) : -1
    if (bt >= 0)
      return { end: bt, next: bt }
    const joined = e === first ? span : span.replace(/\\\n/g, '')
    const lead = h.strip ? joined.length - joined.replace(/^\t+/, '').length : 0
    const raw = joined.slice(lead)
    const text = raw.replace(/\r$/, '')
    if (text === h.delim || raw === h.delim)
      return { end: k, next: e + 1 }
    if (close === ')' && text.startsWith(`${h.delim})`)) {
      // Where the `)` sits in the input, past the continuations the joined line dropped.
      let p = k
      for (let c = 0; c <= lead + h.delim.length; c++) {
        while (s[p] === '\\' && s[p + 1] === '\n') p += 2
        if (c < lead + h.delim.length)
          p++
      }
      return { end: k, next: p }
    }
    k = e + 1
  }
  return { end: s.length, next: s.length }
}

// Where bash ends a backtick substitution's scan in s[from, to): the first backtick there that
// no backslash escapes, a backslash escaping whatever follows it, or -1.
function tickIn(s: string, from: number, to: number): number {
  for (let k = from; k < to; k++) {
    if (s[k] === '\\')
      k++
    else if (s[k] === '`')
      return k
  }
  return -1
}

// The segment lexer behind segments(). `body` lexes the text as a heredoc body with an unquoted
// delimiter: only the substitutions in it are commands, and the text itself is dropped.
// `funsubs` reads a `${ …; }` as bash 5.3 runs it; without it, every `${` is a parameter
// expansion, as bash before 5.3 reads it. `discard` drops the rest of a line bash rejects, as
// bash drops it (rejects()). `old` reads the input as bash 3.2 (macOS /bin/bash) scans it, with
// `funsubs` off: the end of a `$(…)`, `<(…)`, or `>(…)` is found by counting parentheses, and
// that of an assignment's subscript (`a[…]=`) by counting brackets, past any `${` open inside,
// and a `${…}` ends at its first `}`, past any `$(`, `<(`, `>(`, or `$[` open inside it.
function lex(s: string, body: boolean, funsubs = true, discard = false, old = false): string[] {
  const out: string[] = []
  const frame = (close: Frame['close'], subst: boolean, arith: boolean, group: Group | null, word = false, array = false): Frame =>
    ({ close, subst, word, array, arith, tick: -1, scan: false, hash: false, sub: 0, subBrace: 0, q: '', cur: '', brace: 0, bracket: 0, dq: [], pipe: out.length, here: [], test: false, paren: 0, cmd: true, closer: false, fn: false, cases: 0, subject: 0, pat: false, group, braces: [], closed: [], sinks: [], joined: false, held: 0 })
  const stack: Frame[] = [frame('', false, false, null)]
  let f = stack[0]!
  if (body)
    f.q = 'h'
  let ws = true // at the start of a word, where `#` opens a comment
  let op = false // the last character was an unquoted `<` or `>`, so a `&` or `|` extends it
  // bash drops a backslash-newline outside single quotes and `$'…'` before it reads anything
  // else, so a line continuation can split a word or an operator (`FOO=1 \<newline>npm i`,
  // `$\<newline>(…)`). `joinFrom` and `joinTo` bound the last run of them the loop skipped;
  // past(k) is the first index at or after k that no continuation hides, prior(k) the character
  // before k with a run that ends at k skipped.
  let joinFrom = -1
  let joinTo = -1
  const past = (k: number): number => {
    while (s[k] === '\\' && s[k + 1] === '\n') k += 2
    return k
  }
  const prior = (k: number): string => s[(k === joinTo ? joinFrom : k) - 1] ?? ' '
  // Whether a whole name (`a`, `x_1`) ends right before n in the input, read there rather than in
  // the frame's text, which slicing would copy on every call.
  const nameBefore = (n: number): boolean => {
    let k = n
    while (k > 0 && /\w/.test(s[k - 1]!)) k--
    return k < n && !/\d/.test(s[k]!) && (k === 0 || /[ \t\n;&|(]/.test(s[k - 1]!))
  }
  // Whether the `${` whose `{` sits at k runs commands, as bash 5.3, mksh, and ksh93 run them:
  // a blank, a newline, or a `|` after the `{` makes it a substitution (`${ cmd; }`,
  // `${| cmd; }`), whose body ends at a `}` that bash reads as a reserved word. Any other `${`
  // is a parameter expansion, and so is every one when `funsubs` is off.
  const funsub = (k: number): boolean => funsubs && /[ \t\n|]/.test(s[past(k + 1)] ?? '')
  // Open the substitution whose `{` sits at k, and return where its body starts, past a `|`.
  const openFunsub = (k: number): number => {
    const at = past(k + 1)
    open('}', true, false)
    return s[at] === '|' ? at : k
  }
  const pending: Heredoc[] = [] // heredocs whose body starts at the next newline
  const bodies: Heredoc[] = [] // heredocs whose body is read, judged once the input ends
  // Per output index: whether a shell heads that segment. Tokenized at most once, so many
  // heredocs in one long pipeline stay linear.
  const shellAt: (boolean | undefined)[] = []
  const isShellAt = (x: number): boolean => (shellAt[x] ??= shellReads(out[x]!))
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
  // A frame opens. In the bash 3.2 reading, a `$(`, `<(`, or `>(` starts a parenthesis count, and
  // every `(` frame inside one belongs to it; outside double quotes and a heredoc body, that count
  // skips a `#` comment, and inside them it does not.
  const open = (close: ')' | '`' | '}' | ']', subst: boolean, arith: boolean, word = false, array = false): void => {
    const up = f
    f = frame(close, subst, arith, { from: -1, to: -1, up: inner() }, word, array)
    f.held = pending.length
    f.tick = close === '`' ? stack.length : up.tick
    f.scan = old && close === ')' && (subst || (word && !array) || up.scan)
    f.hash = f.scan && up.q === '' && (up.scan ? up.hash : true)
    stack.push(f)
    ws = true
  }
  // A segment ends: its text goes out and the frame starts a new command. A group closed in it
  // flows into the segments that follow.
  const cut = (): void => {
    out.push(f.cur)
    f.cur = ''
    f.sub = 0
    f.lead = undefined
    f.cmd = true
    f.closer = false
    f.fn = false
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
  // A word ends. At a command start, `[[` opens a conditional, `{` a group, `}` closes one, and
  // `case` a case statement; inside `[[ … ]]`, `]]` closes it. Right after a word that ends a
  // compound command (`closer`), `}`, `fi`, `done`, `esac`, and the words that start a command
  // are still reserved words, as bash reads them (`{ if …; fi }`, `{ { …; } }`). The word after
  // `function` names a function, so its body starts a new command, as the list after a case
  // pattern does. Only the last nine characters are read (no reserved word is longer than
  // `function`), so a long segment stays linear.
  const endWord = (): void => {
    const tail = f.cur.slice(-9)
    const at = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\t'), tail.lastIndexOf('\n'))
    const w = at < 0 && f.cur.length > 9 ? '\0' : tail.slice(at + 1)
    if (w === '')
      return
    const reserved = f.cmd || f.closer
    f.closer = false
    if (f.test) {
      if (w === ']]') {
        f.test = false
        f.paren = 0
        f.cmd = false
        f.closer = true
      }
      return
    }
    if (f.fn) {
      cut()
      return
    }
    if (f.subject > 0) {
      f.subject--
      f.pat = f.subject === 0
      return
    }
    if (f.pat || (reserved && f.cases > 0 && w === 'esac')) {
      if (w === 'esac') {
        f.cases--
        f.pat = false
        f.cmd = false
        f.closer = true
      }
      return
    }
    if (f.cmd && w === 'case') {
      f.cases++
      f.subject = 2
      f.cmd = false
      return
    }
    if (f.cmd && w === 'function') {
      f.fn = true
      return
    }
    if (f.cmd && w === '[[') {
      f.test = true
    }
    else if (f.cmd && w === '{') {
      f.braces.push({ from: -1, to: -1, up: inner() })
    }
    else if (reserved && w === '}' && f.braces.length > 0) {
      f.closed.push(f.braces.pop()!)
      f.closer = true
    }
    else if (reserved && (w === 'fi' || w === 'done')) {
      f.closer = true
    }
    f.cmd = reserved && BEFORE_COMMAND.has(w)
  }
  // Whether the `(` at n is glued to the word before it, and not to a reserved word standing
  // where a command starts (none is longer than six characters, so only the last seven are
  // read). As an argument, `!(…)` is an extglob, not a negated subshell.
  const glued = (n: number): boolean => {
    if (/[\s;&|<>()`=]/.test(prior(n)))
      return false
    const tail = f.cur.slice(-7)
    const word = tail.slice(tail.search(/\S*$/))
    return word.length === 7 || !(f.cmd && BEFORE_COMMAND.has(word))
  }
  // A frame closes: its last segment goes out, its pipelines end, and as a group it flows into
  // the segments of its parent's pipeline that follow the one holding it. After a subshell's
  // `)` a new word starts, so a `#` there opens a comment; after a substitution's, a process
  // substitution's, or an array's, the word around it runs on. A substitution leaves SUBST in
  // that word, and so does a process substitution, which expands to a path: `<(…)` stays a word
  // of its own (`<$()`), never a bare `<` that would take the next word as its target.
  const pop = (): void => {
    cut()
    endPipe()
    const done = stack.pop()!
    f = stack.at(-1)!
    if (done.close === '`')
      pending.length = Math.min(pending.length, done.held)
    if (done.group)
      f.closed.push(done.group)
    if (done.subst || (done.word && !done.array))
      f.cur += SUBST
    ws = !done.subst && !done.word
  }
  // bash reads an array (`x=(…)`) word by word and rejects an operator or a `(` at n in it,
  // outside a `[…]` span that starts a word (`x=([k]=v)`, `x=(a [[ (b) ]])`) and a process
  // substitution (`<(…)`); an extglob (`@(a)`) is rejected only while extglob is off, as it is in
  // `bash -c`. Unlike any other syntax error, that one drops only the rest of its physical line,
  // a line continuation or a heredoc on it included, and bash reads the next line as a new
  // command (`x=((1))\<newline>npm i` runs npm). With `discard`, the lexer drops it there too:
  // `drop` is that line's newline, or -1.
  let drop = -1
  const rejects = (n: number): void => {
    if (discard && f.array && f.paren === 0 && f.bracket === 0 && !f.test && drop < 0) {
      const e = s.indexOf('\n', n)
      drop = e < 0 ? s.length : e
    }
  }
  // The next line starts as the input does, with every frame, quote, and pending heredoc dropped.
  const restart = (): void => {
    while (stack.length > 1) pop()
    cut()
    endPipe()
    pending.length = 0
    f = frame('', false, false, null)
    stack[0] = f
    ws = true
    op = false
    joinFrom = -1
    joinTo = -1
    drop = -1
  }
  for (let n = 0; n < s.length; n++) {
    if (drop >= 0 && n >= drop)
      restart()
    const c = s[n]!
    if (c === '\\' && s[n + 1] === '\n' && f.q !== '\'' && f.q !== '$') {
      if (n !== joinTo)
        joinFrom = n
      joinTo = n + 2
      n++
      continue
    }
    const afterOp = op
    op = false
    // bash finds a backtick substitution's end before parsing it, so an unescaped backtick
    // closes it whatever quote, substitution, or expansion is open inside, and those close with
    // it (`` `echo $[ '` ``). That scan pairs a backslash with what follows it, in single quotes
    // too, so `\\` there escapes nothing after it.
    if (f.tick >= 0 && c === '\\' && (s[n + 1] === '`' || (s[n + 1] === '\\' && f.q === '\''))) { f.cur += c + s[n + 1]!; n++; continue }
    if (f.tick >= 0 && c === '`') {
      const t = f.tick
      while (stack.length - 1 > t) pop()
      pop()
      continue
    }
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
      if (c === '$' && s[past(n + 1)] === '(') { n = past(n + 1); open(')', true, s[past(n + 1)] === '('); continue }
      if (c === '$' && s[past(n + 1)] === '[') { n = past(n + 1); open(']', true, true); continue }
      if (c === '`') { open('`', true, false); continue }
      if (c === '$' && s[past(n + 1)] === '$' && s[past(past(n + 1) + 1)] !== '(') { f.cur += '$$'; n = past(n + 1); continue }
      if (c === '$' && s[past(n + 1)] === '{' && funsub(past(n + 1))) { n = openFunsub(past(n + 1)); continue }
      // Inside double quotes, a `${…}` is read as unquoted text until its `}`, so a quote in it
      // nests (`"${x:-"a b"}"`); `dq` records the depth at which the double quote resumes.
      if (c === '$' && s[past(n + 1)] === '{' && f.q === '"') {
        f.brace++
        f.dq.push(f.brace)
        f.q = ''
        f.cur += '${'
        n = past(n + 1)
        continue
      }
      f.cur += c
      if (c === '"' && f.q === '"')
        f.q = ''
      continue
    }
    if (c === '\\') { f.cur += c + (s[n + 1] ?? ''); n++; ws = false; continue }
    if (c === '\'' || c === '"') { f.q = c; f.cur += c; ws = false; continue }
    const next = past(n + 1)
    if (c === '$' && s[next] === '\'') { f.q = '$'; f.cur += '$\''; n = next; ws = false; continue }
    // bash 3.2 ends an unquoted `${…}` at its `}` whatever `$(`, `<(`, `>(`, or `$[` is open
    // inside it, so in that reading none of them opens a frame there.
    const plain = old && f.brace > 0
    if (c === '$' && s[next] === '(' && !plain) { n = next; open(')', true, f.arith || s[past(n + 1)] === '('); continue }
    // `$[…]` is arithmetic, which bash ends at the `]` that matches its `[`, whatever `${` is
    // open inside (`$[ ${x) ]`), so the frame's close drops that expansion with it.
    if (c === '$' && s[next] === '[' && !plain) { n = next; open(']', true, true); continue }
    if (f.close === ']' && c === '[') { f.bracket++; f.cur += c; ws = false; continue }
    if (f.close === ']' && c === ']') {
      if (f.bracket === 0) { pop(); continue }
      f.bracket--
      f.cur += c
      ws = false
      continue
    }
    // bash 3.2 ends an assignment's subscript (`a[…]=`) at the `]` that matches its `[`, whatever
    // unquoted `${` is open inside, so `a[${x]=1` fails and the next line runs. In that reading
    // a `[` glued to a name opens one, and its `]` drops the expansions opened since.
    if (old && f.sub > 0 && (c === '[' || c === ']') && (f.dq.at(-1) ?? 0) <= f.subBrace) {
      if (c === '[')
        f.sub++
      else if (--f.sub === 0)
        f.brace = f.subBrace
      f.cur += c
      ws = false
      continue
    }
    if (old && c === '[' && !ws && f.brace === 0 && f.close !== ']' && !f.array && !f.test && !f.pat && nameBefore(n)) {
      f.sub = 1
      f.subBrace = f.brace
      f.cur += c
      continue
    }
    // In an array, a `[` that starts a word opens a span bash reads whole, up to its matching `]`.
    if (f.array && c === '[' && (ws || f.bracket > 0)) { f.bracket++; f.cur += c; ws = false; continue }
    if (f.array && c === ']' && f.bracket > 0) { f.bracket--; f.cur += c; ws = false; continue }
    // `$$` is the shell's PID, so a `{` after it opens no expansion (`$${x; …}`). Before a `(`
    // the second `$` still opens a substitution: PowerShell runs `$$(…)`.
    if (c === '$' && s[next] === '$' && s[past(next + 1)] !== '(') { f.cur += '$$'; n = next; ws = false; continue }
    if (c === '$' && s[next] === '{' && funsub(next)) { n = openFunsub(next); continue }
    if (c === '$' && s[next] === '{') { f.brace++; f.cur += '${'; n = next; ws = false; continue }
    // A `}` ends a `${ …; }` substitution where bash reads it as a reserved word, as it ends a
    // group: where a command starts (after a `;`, `&`, a newline, or a subshell's `)`:
    // `${ cmd; }`, `${ (cmd)}`), or after a word that ends a compound command (a group's `}`,
    // `fi`, `done`, `esac`, or `]]`: `${ { cmd; } }`, `${ if a; then b; fi }`). Inside one, bash
    // ends a group's `}` at that `}`, so a `}` glued after it is read again (`${ { cmd; }}`).
    const shut = f.close === '}' && f.brace === 0 && !f.test && !f.pat && f.paren === 0
    if (c === '}' && shut && !ws && (f.cmd || f.closer) && f.braces.length > 0 && f.cur.endsWith('}') && /[ \t\n]/.test(f.cur.at(-2) ?? ' ')) {
      endWord()
      f.cur += ' '
      ws = true
    }
    if (c === '}' && shut && ws && (f.cmd || f.closer) && f.braces.length === 0) { pop(); continue }
    if (c === '}' && f.brace > 0) {
      if (f.dq.at(-1) === f.brace) {
        f.dq.pop()
        f.q = '"'
      }
      f.brace--
      f.cur += c
      ws = false
      continue
    }
    if (c === '`') { open('`', true, false); continue }
    // A process substitution still runs inside an unquoted expansion (`${x:-<(cmd)}`); inside
    // double quotes it is text, and so it is to the scan of bash 3.2 and 4.4 (`old`).
    if (f.brace > 0 && !f.arith && !old && f.dq.length === 0 && (c === '<' || c === '>') && s[next] === '(') { f.cur += c; n = next; open(')', false, false, true); continue }
    // Any other operator or blank in a parameter expansion is text, since bash reads one up to
    // its `}` (`${x//(/}`, `${x:-a b}`, `${x:-a;b}`). One that never closes runs to the end of
    // the input, as an unclosed quote does: bash rejects that command and runs nothing after it.
    // The exceptions are the scans bash makes before it parses: a backtick substitution ends at
    // its first unescaped backtick, `$((…))` at the `)` that matches its `(` and `$[…]` at the
    // `]` that matches its `[`, each counted whatever `${` is open, and in bash 3.2 (`old`) a
    // `$(…)`, `<(…)`, or `>(…)` ends at the `)` that matches its `(` too. There bash drops the
    // expansion with the scan, fails it when it runs, and runs the commands after it
    // (`$((${x) a); npm i`, and `$(${x) a; npm i` in bash 3.2), so in arithmetic every operator
    // stays structural here, and in that bash 3.2 count the parentheses do (`scan`), with a `#`
    // after a blank still opening a comment there (`hash`), as bash 3.2 reads one.
    if (f.scan && f.brace > 0 && f.dq.length === 0 && !f.arith && (c === '(' || c === ')')) {
      if (c === ')' && f.paren === 0) { pop(); continue }
      f.paren += c === '(' ? 1 : -1
      f.cur += c
      ws = false
      continue
    }
    if (f.brace > 0 && !f.arith && /[()<>;&| \t\n]/.test(c)) { f.cur += c; ws = false; continue }
    if (c === '(') {
      if (!/[<>]/.test(prior(n)))
        rejects(n)
      // A case pattern may open with a `(`, which is text; one after `?`, `*`, `+`, `@`, or `!`
      // is an extglob's (`@(a|b)`), whose `)` does not end the pattern.
      if (f.pat) {
        if (/[?*+@!]/.test(prior(n)))
          f.paren++
        f.cur += c
        ws = false
        continue
      }
      // A function header (`f()`, `f ()`, `function f()`) ends where its body, a new command,
      // starts. Outside one, an empty `( )` is a syntax error bash never runs.
      if (!f.test && !f.arith && f.paren === 0) {
        let k = past(n + 1)
        while (s[k] === ' ' || s[k] === '\t') k = past(k + 1)
        if (s[k] === ')' && (/[ \t]/.test(prior(n)) || (f.cmd && glued(n)))) {
          f.cur += s.slice(n, k + 1)
          n = k
          cut()
          continue
        }
      }
      // Inside `[[ … ]]` a `(` groups, except a process substitution (`<(…)`), which runs. Inside
      // `$[…]` it groups too, and bash's scan for the `]` passes over it (`$[ (${x ]`).
      if (f.close === ']' || ((f.test || f.paren > 0) ? !/[<>]/.test(prior(n)) : glued(n))) { f.paren++; f.cur += c; ws = false; continue }
      open(')', false, f.arith || s[next] === '(', /[<>=]/.test(prior(n)), prior(n) === '=' && !f.arith)
      continue
    }
    if (c === ')') {
      endWord()
      if (f.paren > 0) { f.paren--; f.cur += c; ws = false; continue }
      // bash's scan for the end of a `$((…))` counts this `)` even inside a `$[…]` in it, so the
      // `$[` ends here and the `)` is read again in the arithmetic around it (`$(( $[${x))`).
      if (f.close === ']' && stack.at(-2)?.arith === true && stack.at(-2)?.close === ')') { pop(); n--; continue }
      // A case pattern ends at its `)`, and the commands after it start a new segment.
      if (f.pat) {
        f.pat = false
        f.cur += c
        cut()
        continue
      }
      if (f.close === ')') { pop(); continue }
    }
    // A comment runs to the end of the line; inside backticks, to the first unescaped backtick.
    // Inside `[[ … ]]` and a word's own parentheses, bash reads a `#` as text, and so it does
    // inside `${…}`, except in the bash 3.2 count that ends a `$(…)` (`hash`).
    if (c === '#' && ((ws && f.brace === 0 && !f.arith && !f.test && f.paren === 0) || (f.hash && f.brace > 0 && f.dq.length === 0 && /[ \t\n]/.test(prior(n))))) {
      let e = s.indexOf('\n', n)
      if (e < 0)
        e = s.length
      if (f.tick >= 0) {
        const bt = tickIn(s, n, e)
        if (bt >= 0)
          e = bt
      }
      n = e - 1
      continue
    }
    // A redirect operator ends the word before it, so `]]>log` closes a `[[` and `{<in` opens a
    // group. The `&` of `>&2` belongs to the operator already open.
    if (c === '<' || c === '>' || (c === '&' && s[next] === '>' && !afterOp)) {
      endWord()
      if (c === '&' || s[next] !== '(')
        rejects(n)
    }
    if (c === '<' && s[next] === '<' && s[past(next + 1)] === '<') { f.cur += '<<<'; n = past(next + 1); ws = false; continue }
    // A heredoc operator (`<<`, `<<-`) and its delimiter word; `<<` in arithmetic is a shift.
    // The word ends where bash ends it: at a space, a tab, or an operator character, and at a CR
    // only right before the newline, since a heredocEnd() line drops that CR too. A quoted part
    // runs on across lines, and bash removes its quotes: inside `"…"` a backslash escapes `"`,
    // `\`, `$`, and a backtick, and a backslash-newline vanishes (`<<"EO\<newline>F"` is `EOF`).
    if (c === '<' && s[next] === '<' && !f.arith) {
      let k = past(next + 1)
      const strip = s[k] === '-'
      if (strip)
        k = past(k + 1)
      while (s[k] === ' ' || s[k] === '\t') k = past(k + 1)
      let delim = ''
      let quoted = false
      let wq = ''
      const from = k
      while (k < s.length && (drop < 0 || k < drop) && (wq !== '' || s[k] !== '\n')) {
        const d = s[k]!
        // Inside backticks, bash finds the closing backtick first, whatever quote is open, and a
        // backslash escapes a backtick or a backslash after it in any quote.
        if (f.tick >= 0 && d === '`')
          break
        if (wq) {
          if (f.tick >= 0 && d === '\\' && (s[k + 1] === '`' || s[k + 1] === '\\')) { delim += s[k + 1]!; k += 2; continue }
          if (wq === '"' && d === '\\' && s[k + 1] === '\n') { k += 2; continue }
          if (wq === '"' && d === '\\' && /["$`\\]/.test(s[k + 1] ?? '')) { delim += s[k + 1]!; k += 2; continue }
          if (d === wq)
            wq = ''
          else
            delim += d
          k++
          continue
        }
        if (d === '\\' && s[k + 1] === '\n') { k += 2; continue }
        if (d === '\'' || d === '"') { wq = d; quoted = true; k++; continue }
        if (d === '\\') { quoted = true; delim += s[k + 1] ?? ''; k += 2; continue }
        if (/[ \t;&|()<>`]/.test(d) || (d === '\r' && s[k + 1] === '\n'))
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
    if ((c === '&' && (afterOp || s[next] === '>')) || (c === '|' && afterOp && prior(n) === '>')) { f.cur += c; ws = false; continue }
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
        const { end, next } = heredocEnd(s, k, h, f.close, f.tick >= 0)
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
    // In a case pattern, `|` separates alternatives (`a|b)`). The word before it may be the
    // `esac` that ends the statement, and then `|` is a pipe (`esac|cmd`).
    if (c === '|' && f.pat) {
      endWord()
      if (f.pat) {
        f.cur += c
        ws = false
        continue
      }
    }
    if (c === ';' || c === '&' || c === '|') {
      rejects(n)
      endWord()
      cut()
      // `|` and `|&` join a pipeline; `;`, `&`, `&&`, and `||` end it.
      f.joined = (c === '|' && s[next] !== '|' && prior(n) !== '|') || (c === '&' && prior(n) === '|')
      if (!f.joined)
        endPipe()
      // `;;`, `;&`, and `;;&` end a case arm, so a pattern follows.
      if (f.cases > 0 && c === ';' && (prior(n) === ';' || s[next] === '&'))
        f.pat = true
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
      out.push(...lex(h.body ?? '', false, funsubs, discard, old))
    else if (!h.quoted)
      out.push(...lex(h.body ?? '', true, funsubs, false, old))
  }
  return out
}

// How many times segments() lexes again what a segment hands back to the parser (reparsed()).
// Each pass removes one layer of quotes (`eval "eval 'npm i'"` takes two) or one expansion
// (`${x:-${y:-npm i}}`), and the bound keeps a hostile nesting linear: past it, what is still
// handed back is lexed once more flat(), so the chain still ends at the command it runs.
const REPARSE = 8

// Source with every quote, backslash, defaulted-expansion opening, and `}` dropped.
function flat(source: string): string {
  return source.replace(/[\\'"]/g, '').replace(DEFAULTED_ALL, '').replace(/\}/g, ' ')
}

// A byte JavaScript counts as whitespace that bash keeps inside a word: a no-break space, U+3000,
// a vertical tab, a form feed, a CR, and the like. PowerShell, which the guards also run for,
// reads each as a blank (U+0085 too) and a CR as a line end.
const SPACE_LIKE = /[^\S \t\n]|\u0085/
const SPACE_LIKE_ALL = /[^\S \t\n]|\u0085/g

// A segment as PowerShell splits it: a CR ends the line and any other space-like byte is a blank.
function blankReading(seg: string): string {
  return seg.replace(SPACE_LIKE_ALL, c => c === '\r' ? '\n' : ' ')
}

// A `${` that bash 5.3 reads as a `${ …; }` substitution, any `${`, and an array (`x=(`), line
// continuations included.
const FUNSUB = /\$(?:\\\n)*\{(?:\\\n)*[ \t\n|]/
const BRACE = /\$(?:\\\n)*\{/
const ARRAY = /=(?:\\\n)*\(/

// The segments of a source as bash 5.3 splits it and, when the source holds a `${ …; }`, as
// bash before 5.3 splits it too. That bash (macOS /bin/bash 3.2, Git for Windows, Ubuntu 24.04)
// reads every `${` as a parameter expansion that ends at its `}`, fails it when it runs, and runs
// the next line, so `echo "${ x }"<newline>npm i` runs npm there. When the source holds any `${`,
// it is also split as bash 3.2 scans it (lex()'s `old`): that bash ends a `$(…)`, `<(…)`, `>(…)`,
// or an assignment's `a[…]` at the parenthesis or bracket that matches its opening, whatever
// `${` is open inside, so `echo $(${x) a; npm i` runs npm there, and ends a `${…}` at its `}`
// whatever substitution is open inside it. When the source holds an array, each is also read
// with the lines bash rejects in it dropped (lex()'s `discard`), so a quote, a heredoc, or a line
// continuation on such a line hides nothing.
function readings(source: string): string[] {
  const out: string[] = []
  const read = (funsubs: boolean, old: boolean): void => {
    out.push(...lex(source, false, funsubs, false, old))
    if (ARRAY.test(source))
      out.push(...lex(source, false, funsubs, true, old))
  }
  read(true, false)
  if (FUNSUB.test(source))
    read(false, false)
  if (BRACE.test(source))
    read(false, true)
  return out
}

/**
 * Split a command string into the simple commands bash would run: at `;`, `&`, `|`, and
 * newlines, and into `(…)`, `$(…)`, `${ …; }`, and backtick bodies, including a substitution
 * inside double quotes or an unquoted-delimiter heredoc, where bash still runs it. Quoted text,
 * comments, and heredoc bodies are data, except a body a shell reads. A substitution leaves
 * SUBST in the word around it. A line continuation (backslash-newline) joins its lines, as bash
 * joins them, outside single quotes. What `eval` runs (its words, quotes removed), the string
 * `env -S` splits into a command, and the string pnpm's shell mode, `flock`, `mise x`, or
 * `runuser` hands a shell are split again into commands of their own. An input holding a
 * space-like byte other than a space, a tab, or a newline is also split as PowerShell reads it,
 * with that byte as a blank and a CR as a line end, and so is each segment holding one. An
 * input holding a `${ …; }` is also split as bash before 5.3 reads it, with that `${` as a
 * parameter expansion, one holding any `${` as bash 3.2 scans it (`$(${x) a; npm i`), and one
 * holding an array with each line bash rejects in it dropped (`x=((1))`). So a caller judging
 * every segment denies what any of these would run.
 */
export function segments(s: string): string[] {
  const out = readings(s)
  // PowerShell ends a line at a CR that bash leaves inside a comment or a heredoc body, so the
  // whole input is read that way too, not only the segments bash produced.
  if (SPACE_LIKE.test(s))
    out.push(...readings(blankReading(s)))
  // The readings often agree, so a segment that recurs is read again only once.
  const seen = new Set<string>()
  let from = 0
  for (let pass = 0; from < out.length; pass++) {
    const to = out.length
    for (let x = from; x < to; x++) {
      const seg = out[x]!
      if (seen.has(seg))
        continue
      seen.add(seg)
      if (SPACE_LIKE.test(seg))
        out.push(...readings(blankReading(seg)))
      for (const source of reparsed(seg))
        out.push(...readings(pass < REPARSE ? source : flat(source)))
    }
    from = to
  }
  return out
}

// The shell sources a segment hands back to the parser, each lexed as a reading of its own: the
// words after an `eval` among its leading words, quotes removed and joined by spaces as eval
// joins them, or `env` with the string of its `-S` (`--split-string`) option, which env splits
// into a command, and the words after that. The string is lexed like shell input, which reads
// env's own splitting closely enough: `\_` separates words in both once it is read as a space.
// Words that lose no quote or escape read back as they already read, so they are not handed
// back. Otherwise, the string a leading wrapper passes to a shell (wrappedString()), the words
// pnpm runs in its shell mode (shellModeAt()), the default of a head that is an expansion with
// one (defaulted()), and the replacement of a pattern substitution that may stand as the head
// (replaced()) are handed back.
function reparsed(seg: string): string[] {
  if (!/eval|env|\$\{|pn|flock|mise|runuser/i.test(seg))
    return []
  const raw = words(seg)
  const toks = raw.map(unescapeWord)
  const lead = leadIndex(toks)
  const out: string[] = []
  for (let k = 0; k < lead; k++) {
    const b = base(toks[k]!)
    if (b === 'eval') {
      const args = raw.slice(unquote(toks[k + 1] ?? '') === '--' ? k + 2 : k + 1)
      const plain = args.map(dequote)
      if (plain.some((w, x) => w !== args[x]))
        return [...out, plain.join(' ')]
      break
    }
    const split = b === 'env' ? envSplit(raw.map(dequote), k + 1) : null
    if (split)
      return [...out, ['env', split.value.replace(/\\(.)/g, (m, x: string) => x === '_' ? ' ' : m), ...raw.slice(split.next)].join(' ')]
    const string = wrappedString(raw, toks, k, b, lead)
    if (string !== null)
      out.push(string)
  }
  // The runners resolveHead() unwraps, in the same order, up to one in shell mode. Its words,
  // like eval's, are handed back only when one loses a quote or an escape; plain words already
  // read as the command they run, the next runner included.
  for (let h = lead; h < toks.length;) {
    const s = shellModeAt(toks, h)
    if (s >= 0) {
      const args = raw.slice(s)
      const plain = args.map(dequote)
      if (plain.some((w, x) => w !== args[x]))
        out.push(plain.join(' '))
      break
    }
    const b = base(toks[h] ?? '')
    const dlx = PNPM_DLX.has(b)
    if (b !== 'pnpm' && !dlx)
      break
    let e = h + 1
    while (e < toks.length) {
      const t = unquote(toks[e]!)
      if (t.startsWith('-')) { if (PNPM_VALUE_FLAG.has(t)) e++; e++; continue }
      break
    }
    if (!dlx) {
      if (e >= toks.length || !/^(exec|dlx|x)$/.test(unquote(toks[e]!)))
        break
      e++
    }
    h = e
    while (h < toks.length && skip(toks[h]!)) h++
  }
  for (const source of [defaulted(raw, lead), replaced(raw, toks, lead)]) {
    if (source !== null)
      out.push(source)
  }
  // A run of wrappers often hands back the same string (`flock a -c flock b -c …`).
  return [...new Set(out)]
}

// The opening of a pattern substitution, `${x/`, `${x//`, `${x/#`, or `${x/%`, for a name, an
// array element, or a special parameter.
const PATSUB = /^\$\{(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|\d+|[@*#?$!-])\/[/#%]?/

// Where the pattern of the substitution in `w`, read from `n`, ends: at the `/` that opens its
// replacement, outside quotes and not escaped, or -1 when the expansion's `}` at `close` comes
// first and there is no replacement.
function patternEnd(w: string, n: number, close: number): number {
  for (let k = n; k < close; k++) {
    const q = quoteAt(w, k)
    if (w[k] === '\\' || (w[k] === '$' && w[k + 1] === '$')) {
      k++
    }
    else if (q !== '') {
      k = quoteEnd(w, k, q)
      if (k < 0)
        return -1
    }
    else if (w[k] === '/') {
      return k
    }
  }
  return -1
}

// Whether a word expands to nothing: it is empty, or only substitutions and parameter
// expansions without a default or a replacement to read.
function vanishes(w: string): boolean {
  return withoutExpansions(w) === '' && !DEFAULTED.test(w) && !PATSUB.test(w)
}

// The command the unquoted pattern substitutions among a segment's leading words run when their
// replacement stands as the head (`${x/a/npm i}`, `${x/a/npm} i`, `sudo ${x/a/npm} i`): bash
// removes the replacement's quotes and splits the value into words, so the replacement, the rest
// of its word, and the words after it are read as a command. What the pattern leaves of the
// variable is unknowable here and read as empty, and so is every other word that may expand to
// nothing. A replacement the head search passes over (`${x/a/sudo}`) leaves the head to the
// words after it, so each such replacement is read in place, in one reading, up to the first
// that names a head. Null when no replacement is read. That each value may be empty is the
// reading of the segment itself, since skip() passes over the substitution.
function replaced(raw: string[], toks: string[], lead: number): string | null {
  const parts: string[] = []
  let read = false
  for (let k = 0; k <= lead && k < raw.length; k++) {
    const w = raw[k]!
    const open = PATSUB.exec(w)
    const close = open ? quoteEnd(w, 0, '{') : -1
    const slash = open && close >= 0 ? patternEnd(w, open[0].length, close) : -1
    const value = slash < 0 ? '' : dequote(w.slice(slash + 1, close)) + w.slice(close + 1)
    const valueToks = words(value).map(unescapeWord)
    if (slash < 0 || valueToks.every(vanishes)) {
      if (!vanishes(toks[k]!))
        parts.push(w)
      continue
    }
    parts.push(value)
    read = true
    if (!valueToks.every(skip))
      return [...parts, ...raw.slice(k + 1)].join(' ')
  }
  return read ? [...parts, ...raw.slice(lead + 1)].join(' ') : null
}

// The string a `-c` or `--command` option among raw[from..to) passes to a shell, quotes removed:
// `-c STRING`, `-cSTRING`, a cluster of one-letter flags ending in it (`-lc STRING`),
// `--command STRING`, or `--command=STRING` (runuser's `--session-command` too). The search
// ends at a `--` and at the next wrapper, whose own options are read in its turn, so the scans of
// a run of wrappers stay linear. Null when no such option is there.
function commandOption(raw: string[], toks: string[], from: number, to: number): string | null {
  for (let p = from; p < Math.min(to, raw.length); p++) {
    if (toks[p] === '--' || (p > from && WRAP.has(base(toks[p]!))))
      break
    const w = dequote(raw[p]!)
    const m = /^(?:-[A-Za-z]*?c|--(?:session-)?command(?:=|$))/.exec(w)
    if (m)
      return m[0].length < w.length || m[0].endsWith('=') ? w.slice(m[0].length) : dequote(raw[p + 1] ?? '')
  }
  return null
}

// The command string the wrapper at `toks[k]`, whose base() is `b`, passes to a shell, or null:
// `flock [flags] FILE -c|--command STRING`, which util-linux reads only right after the lock
// file, and the `-c` or `--command` option of `mise x|exec` and of `runuser`, read up to the
// head at `lead` (`runuser -c STRING USER`).
function wrappedString(raw: string[], toks: string[], k: number, b: string, lead: number): string | null {
  if (b === 'flock') {
    const vf = WRAP_VALUE_FLAGS.get('flock')
    let p = k + 1
    while (p < toks.length && toks[p]!.startsWith('-'))
      p += vf?.has(toks[p]!) ? 2 : 1
    return commandOption(raw, toks, p + 1, p + 2)
  }
  if (b === 'mise')
    return /^(?:x|exec)$/.test(unquote(toks[k + 1] ?? '')) ? commandOption(raw, toks, k + 2, lead + 1) : null
  return b === 'runuser' ? commandOption(raw, toks, k + 1, lead + 1) : null
}

// pnpm's options that take a separate value, as shellModeAt() reads them: the global ones and
// those of `exec` and `dlx` (`pnpm --package cowsay -c dlx '…'`).
const PNPM_RUN_VALUE: ReadonlySet<string> = new Set([...PNPM_VALUE_FLAG, '--package', '--allow-build', '--resume-from', '--cpu', '--os', '--libc'])

// pnpm's shell mode: `-c`, alone or in a cluster of one-letter flags (`-rc`), or `--shell-mode`.
const PNPM_SHELL_MODE = /^(?:-[a-z]*c[a-z]*|--shell-mode(?:=(?!false$).*)?)$/

// Where the command string starts that pnpm runs in a shell for `pnpm [flags] exec|dlx|x
// [flags] …` or `pnx|pnpx [flags] …` with its shell mode among the flags before or after the
// subcommand (`pnpm -r -c exec '…'`, `pnpm exec -c '…'`): the first word after the flags and a
// `--`. pnpm joins the words from there by spaces and hands them to a shell. -1 for any other
// word at `toks[i]`.
function shellModeAt(toks: string[], i: number): number {
  const b = base(toks[i] ?? '')
  const dlx = PNPM_DLX.has(b)
  if (b !== 'pnpm' && !dlx)
    return -1
  let shell = false
  let e = i + 1
  const flags = (): void => {
    for (let t = unquote(toks[e] ?? ''); t.startsWith('-') && t !== '--'; t = unquote(toks[e] ?? '')) {
      shell ||= PNPM_SHELL_MODE.test(t)
      e += PNPM_RUN_VALUE.has(t) ? 2 : 1
    }
  }
  flags()
  if (!dlx) {
    if (!/^(?:exec|dlx|x)$/.test(unquote(toks[e] ?? '')))
      return -1
    e++
    flags()
  }
  if (!shell)
    return -1
  return unquote(toks[e] ?? '') === '--' ? e + 1 : e
}

// The opening of a parameter expansion whose value can be the text after it: `${x:-`, `${x-`,
// `${x:=`, `${x:+`, and the same for an array element or a special parameter.
const DEFAULTED = /^\$\{(?:[A-Za-z_]\w*(?:\[[^\]]*\])?|\d+|[@*#?$!-]):?[-=+]/
const DEFAULTED_ALL = new RegExp(DEFAULTED.source.slice(1), 'g')

// The command an unquoted expansion with a default runs when it stands as the head
// (`${x:-npm i}`): bash splits its value into words and runs them, so the default, the rest of
// its word, and the words after it are read as a command. A default that splits into no word
// leaves the head to the next one (`${x:-} ${y:-npm} i`), read in the same pass. Null for any
// other head; the value of a plain `$x` is unknowable here.
function defaulted(raw: string[], i: number): string | null {
  const parts: string[] = []
  let k = i
  for (let blank = true; blank && k < raw.length; k++) {
    const w = raw[k]!
    const open = DEFAULTED.exec(w)
    const close = open ? quoteEnd(w, 0, '{') : -1
    if (!open || close < 0)
      break
    const part = w.slice(open[0].length, close) + w.slice(close + 1)
    parts.push(part)
    blank = /^[ \t\n]*$/.test(part)
  }
  return k === i ? null : [...parts, ...raw.slice(k)].join(' ')
}

// env's options that take a separate value, by short letter and long name.
const ENV_VALUE_SHORT = /^[uCa]$/
const ENV_VALUE_LONG: readonly string[] = ['--unset', '--chdir', '--argv0']

// The string env's `-S` or `--split-string` option takes (clustered, glued, or `=`), read from
// env's own argv starting at `a`, and the index of the first word after it; null when env's
// options end without one. GNU env accepts a unique prefix of a long option (`--split`).
function envSplit(argv: string[], a: number): { value: string, next: number } | null {
  for (; a < argv.length; a++) {
    const t = argv[a]!
    if (t === '--' || t === '-' || !t.startsWith('-'))
      return null
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq < 0 ? t : t.slice(0, eq)
      if (name.length > 2 && '--split-string'.startsWith(name))
        return eq < 0 ? { value: argv[a + 1] ?? '', next: a + 2 } : { value: t.slice(eq + 1), next: a + 1 }
      if (eq < 0 && name.length > 2 && ENV_VALUE_LONG.some(o => o.startsWith(name)))
        a++
      continue
    }
    for (let c = 1; c < t.length; c++) {
      if (t[c] === 'S')
        return c + 1 < t.length ? { value: t.slice(c + 1), next: a + 1 } : { value: argv[a + 1] ?? '', next: a + 2 }
      if (ENV_VALUE_SHORT.test(t[c]!)) {
        if (c + 1 === t.length)
          a++
        break
      }
    }
  }
  return null
}

// The ANSI-C escapes dequote() reads inside `$'…'`; any other keeps its backslash.
const ANSI_C: Readonly<Record<string, string>> = { 'n': '\n', 't': '\t', 'r': '\r', '\\': '\\', '\'': '\'', '"': '"', '?': '?' }

// A word as the program it is passed to receives it, after bash's quote removal: quotes
// dropped, a backslash escape resolved outside single quotes (inside double quotes only before
// `$`, `` ` ``, `"`, and `\`), and the common `$'…'` escapes read.
function dequote(raw: string): string {
  let out = ''
  let q = ''
  for (let n = 0; n < raw.length; n++) {
    const c = raw[n]!
    if (q === '\'') {
      if (c === '\'')
        q = ''
      else
        out += c
    }
    else if (q === '$') {
      if (c === '\\') {
        const x = raw[++n] ?? ''
        out += ANSI_C[x] ?? `\\${x}`
      }
      else if (c === '\'') {
        q = ''
      }
      else {
        out += c
      }
    }
    else if (q === '"') {
      if (c === '\\' && /["$`\\]/.test(raw[n + 1] ?? ''))
        out += raw[++n]
      else if (c === '"')
        q = ''
      else
        out += c
    }
    else if (c === '\\') {
      out += raw[++n] ?? ''
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

// Where the `$'…'` span whose text starts at `k` closes: at the next `'` no backslash escapes.
function ansiEnd(s: string, k: number): number {
  for (; k < s.length; k++) {
    if (s[k] === '\\')
      k++
    else if (s[k] === '\'')
      return k
  }
  return -1
}

// Where the quoted span or expansion that opens at `n` closes, -1 when it never does: `'…'` at
// the next `'`, `$'…'` (`q` is `$`) at the next unescaped `'`, and `"…"` and `${…}` (`q` is `{`)
// at their own `"` or `}`. bash reads a `${…}`, bare or inside double quotes, as unquoted text up
// to its `}`, so quotes and expansions nest in it (`"${x:-"a b"}"`, `${x:-'}'}`); `$$` is the
// PID, so a `{` after it opens nothing. A loop with its own stack, so deep nesting stays linear.
function quoteEnd(s: string, n: number, q: string): number {
  if (q === '\'')
    return s.indexOf('\'', n + 1)
  if (q === '$')
    return ansiEnd(s, n + 2)
  const open: string[] = [q]
  for (let k = n + (q === '{' ? 2 : 1); k < s.length; k++) {
    const c = s[k]!
    if (c === '\\' || (c === '$' && s[k + 1] === '$')) {
      k++
      continue
    }
    if (c === '$' && s[k + 1] === '{') {
      open.push('{')
      k++
      continue
    }
    if (open.at(-1) === '"') {
      if (c === '"')
        open.pop()
    }
    else if (c === '}') {
      open.pop()
    }
    else if (c === '"') {
      open.push('"')
    }
    else if (c === '\'' || (c === '$' && s[k + 1] === '\'')) {
      k = c === '\'' ? s.indexOf('\'', k + 1) : ansiEnd(s, k + 2)
      if (k < 0)
        return -1
    }
    if (open.length === 0)
      return k
  }
  return -1
}

// The quote or expansion a word opens at `n`, as quoteEnd() takes it (`{` for `${`), or '' when
// none opens there.
function quoteAt(s: string, n: number): string {
  const c = s[n]
  if (c === '$')
    return s[n + 1] === '\'' ? '$' : s[n + 1] === '{' ? '{' : ''
  return c === '\'' || c === '"' ? c : ''
}

// The words of a segment as bash splits them, each still quoted and escaped, with a glued
// redirect operator peeled off (splitRedirect). A word ends only at an unescaped space, tab, or
// newline outside a quoted span or a `${…}` expansion, so a quoted span (`"a b"`, `'a b'`,
// `$'a b'`), an expansion (`${x:-a b}`), or an escaped blank (`a\ b`) stays in its word, and a
// no-break space, a CR, a form feed, or a vertical tab is part of it, as bash reads them.
// A backslash-newline outside single quotes and `$'…'` is a line continuation and vanishes.
// The segment's leading blanks are trimmed, and its trailing blanks and CR, which a CRLF line
// leaves at the end. A span that never closes opens none: from it on the segment splits at any
// whitespace, so a flag after it is still read (bash rejects such a command). The quote rules
// are globTokens()'s, so the two line up word for word.
function words(seg: string): string[] {
  const s = seg.replace(/^[ \t\n]+/, '').replace(/[ \t\n\r]+$/, '')
  const out: string[] = []
  const push = (word: string, quoted: boolean): void => {
    const split = splitRedirect(word, quoted)
    if (split)
      out.push(...split)
    else
      out.push(word)
  }
  let cur = ''
  for (let n = 0; n < s.length; n++) {
    const c = s[n]!
    if (c === ' ' || c === '\t' || c === '\n') {
      if (cur !== '')
        push(cur, true)
      cur = ''
      continue
    }
    if (c === '\\') {
      if (s[n + 1] !== '\n')
        cur += c + (s[n + 1] ?? '')
      n++
      continue
    }
    if (c === '$' && s[n + 1] === '$') {
      cur += '$$'
      n++
      continue
    }
    const q = quoteAt(s, n)
    if (q === '') {
      cur += c
      continue
    }
    const close = quoteEnd(s, n, q)
    if (close < 0) {
      const rest = s.slice(n).split(/\s+/)
      push(cur + rest[0]!, false)
      for (const w of rest.slice(1).filter(Boolean))
        push(w, false)
      return out
    }
    const span = s.slice(n, close + 1)
    cur += q === '"' ? span.replace(/\\([\s\S])/g, (m, x: string) => x === '\n' ? '' : m) : span
    n = close
  }
  if (cur !== '')
    push(cur, true)
  return out
}

// A redirect operator glued after a command word: `npm</dev/null` splits to `npm`,
// `</dev/null` so the head is not hidden. The operator starts at the first `<` or `>` outside
// quotes and not escaped (`quoted`; a word after a quote that never closed takes the first of
// either), or at a `&` just before it. An empty or all-digit prefix (`2>&1`, `&>/dev/null`)
// stays one token, handled by skip() and the secret redirect scan. A plain scan: the regex this
// replaced backtracked quadratically over a long run of digits.
function splitRedirect(raw: string, quoted: boolean): [string, string] | null {
  let at = quoted ? operatorAt(raw) : raw.search(/[<>]/)
  if (at < 0)
    return null
  if (raw[at] === '>' && raw[at - 1] === '&')
    at--
  const word = raw.slice(0, at)
  return word === '' || /^\d+$/.test(word) ? null : [word, raw.slice(at)]
}

// The index of the first `<` or `>` in a word outside a quoted span or `${…}` and not escaped,
// or -1.
function operatorAt(raw: string): number {
  for (let n = 0; n < raw.length; n++) {
    const c = raw[n]!
    const q = quoteAt(raw, n)
    if (c === '\\' || (c === '$' && raw[n + 1] === '$')) {
      n++
    }
    else if (q !== '') {
      n = quoteEnd(raw, n, q)
      if (n < 0)
        return -1
    }
    else if (c === '<' || c === '>') {
      return n
    }
  }
  return -1
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

/**
 * The words of a segment as bash splits them (a quoted or escaped blank and a `${…}` expansion
 * stay inside their word, and only a space, a tab, or a newline separates), with a glued redirect
 * operator peeled off each and backslash escapes resolved.
 * Quotes stay in the text: unquote() or base() drop them.
 */
export function tokenize(seg: string): string[] {
  return words(seg).map(unescapeWord)
}

// The length of the substitution or parameter expansion that starts at s[n], or 0.
const STICKY_EXPANSION = new RegExp(EXPANSION, 'y')
function expansionAt(s: string, n: number): number {
  STICKY_EXPANSION.lastIndex = n
  return STICKY_EXPANSION.exec(s)?.[0].length ?? 0
}

// A glob character bash leaves as text, hidden behind a byte no glob or separator uses.
function hideGlob(c: string): string {
  return c === '*' || c === '?' || c === '[' ? '\0' : c
}

/**
 * tokenize(seg) with every glob character (`*`, `?`, `[`) that bash never expands, one inside
 * quotes or after a backslash, replaced by NUL. It lines up word for word with tokenize(seg):
 * read a word's text from that and the globs bash expands in it from this, so a quoted grep
 * pattern (`".*"`) is never taken for a path glob. A substitution (SUBST) or a parameter
 * expansion outside single quotes becomes a `*`, since its value may be any text or none:
 * `.env$(…)`, `` ".env`…`" ``, and `.env$x` can name `.env`.
 */
export function globTokens(seg: string): string[] {
  let text = ''
  let q = '' // the open quote: `"`, `'`, or `$` for ANSI-C `$'…'`
  for (let n = 0; n < seg.length; n++) {
    const c = seg[n]!
    const expansion = c === '$' && (q === '' || q === '"') ? expansionAt(seg, n) : 0
    if (c === '\\' && q !== '\'') {
      text += c + hideGlob(seg[n + 1] ?? '')
      n++
    }
    else if (expansion > 0) {
      text += '*'
      n += expansion - 1
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
 * from tokenize(), which keeps a quoted word whole, so a quoted `>` never reads as an operator;
 * an escaped one (`\>`) is unescaped there and still does, so use it only where no free text is
 * expected (`git push` refspecs).
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

// Index of the command head: skip leading VAR=val, wrapper words + a value-flag's value (and a
// coproc's name), redirects, brace-group tokens and option flags. A flag's arity is PER
// WRAPPER — tracked via `curWrap` (the base() of the most recent wrapper word) so `sudo -n`
// stays boolean while `nice -n 10` consumes its value. For a positional-taking wrapper
// (timeout/flock/taskset), also consume its one leading positional after any of its own flags.
// All wrapper decisions use base() so a path-prefixed wrapper (`/usr/bin/sudo`) is recognised.
// A positional/value that would itself be a banned head is never consumed (fail toward deny).
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
      // `coproc NAME { …; }` names the coprocess; the name is skipped only before a compound
      // command, as bash reads it, and never when it would hide a head.
      if (b === 'coproc' && /^[A-Za-z_]\w*$/.test(toks[i] ?? '') && COMPOUND.has(toks[i + 1] ?? '') && !wouldHideHead(toks[i]!))
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
    // keep curWrap so a following option flag still resolves to its wrapper's arity. A redirect
    // operator standing alone takes the next word as its target (`> log npm i`), unless that word
    // is a head the guards must see.
    i += redirectWidth(toks, i) === 2 && !wouldHideHead(toks[i + 1]!) ? 2 : 1
  }
  return i
}

export interface Head { i: number, head: string, probe: boolean }

// Resolve the real command head: lead-skip, detect a leading `command -v` PROBE (never an
// argument to a real head), then LOOP-unwrap `pnpm [flags] exec|dlx|x <cmd>` and its
// `pnx|pnpx [flags] <cmd>` shorthands repeatedly so nested `pnpm exec pnpm exec npm` resolves
// through to `npm`.
export function resolveHead(toks: string[]): Head {
  const i0 = leadIndex(toks)
  const probe = toks.some((t, k) => k < i0 && unquote(t) === 'command' && /^-[vV]$/.test(unquote(toks[k + 1] ?? '')))
  let i = i0
  for (;;) {
    const b = base(toks[i] ?? '')
    const dlx = PNPM_DLX.has(b)
    if (b !== 'pnpm' && !dlx)
      break
    let e = i + 1
    while (e < toks.length) {
      const t = unquote(toks[e]!)
      if (t.startsWith('-')) { if (PNPM_VALUE_FLAG.has(t)) e++; e++; continue }
      break
    }
    if (!dlx) {
      if (e >= toks.length || !/^(exec|dlx|x)$/.test(unquote(toks[e]!)))
        break
      e++
    }
    while (e < toks.length && skip(toks[e]!)) e++
    i = e
  }
  return { i, head: base(toks[i] ?? ''), probe }
}

/**
 * The words a segment exports to every later command of the session, unquoted: each NAME=VALUE
 * assignment or bare NAME (a variable assigned earlier) after `export`, or after `declare`,
 * `typeset`, or `local` given `-x` (`declare -gx`). Any other segment exports none; an inline
 * prefix (`X=1 cmd`) reaches only its own command and is read from the tokens directly.
 */
export function exportedWords(toks: string[]): string[] {
  const { i, head } = resolveHead(toks)
  const words = toks.slice(i + 1).map(unquote)
  const exports = head === 'export' || (/^(?:declare|typeset|local)$/.test(head) && words.some(w => /^-[A-Za-z]*x/.test(w)))
  return exports ? words.filter(w => /^[A-Za-z_]\w*(?:=|$)/.test(w)) : []
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
