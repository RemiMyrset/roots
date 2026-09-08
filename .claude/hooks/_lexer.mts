/**
 * Shared lexical core for the agent guards (deny-non-pnpm / deny-build-scripts /
 * deny-secret-reads / deny-push-protected / deny-hook-bypass), plus the git-option parsing and
 * the hook-payload reader they share. Consolidated here so a fix lands ONCE — the
 * previous triplication is why the guards regressed every audit.
 *
 * ZERO external dependencies (node builtins only): the guards run before `pnpm install`
 * and are synced into arbitrary repos, so this module must never require an npm package.
 * Best-effort lexical detection, NOT a shell — scope and out-of-scope live in docs/template/guards.md.
 */
import process from 'node:process'

export const BANNED: ReadonlySet<string> = new Set(['npm', 'yarn', 'bun', 'bunx'])

// Pass-through wrappers whose argv IS the real command: skip them to find the head. An
// allowlist can never be exhaustive (proxychains/firejail/setarch/catchsegv/...); unknown
// wrapper words are documented out-of-scope in docs/template/guards.md.
export const WRAP: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'runuser', 'env', 'command', 'exec', 'eval', 'time', 'timeout', 'nice',
  'ionice', 'taskset', 'chrt', 'nohup', 'setsid', 'stdbuf', 'unbuffer', 'flock', 'xargs',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'builtin', 'corepack',
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
    || /^\d*[<>]/.test(t) || /^\d+$/.test(t) || t.startsWith('-')
}

// Split a command string into segments at ; & | newline ( ` $( — OUTSIDE quotes only, so
// a metacharacter inside a quoted argument never starts a new command segment.
export function segments(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let n = 0; n < s.length; n++) {
    const c = s[n]!
    if (q) {
      if (q === '"' && c === '\\') { cur += c + (s[n + 1] ?? ''); n++; continue }
      cur += c
      if (c === q)
        q = null
      continue
    }
    if (c === '\'' || c === '"') { q = c; cur += c; continue }
    if (c === '\\') { cur += c + (s[n + 1] ?? ''); n++; continue }
    if (c === '$' && s[n + 1] === '(') { out.push(cur); cur = ''; n++; continue }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === '`') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

// A redirect operator glued after a command word: `npm</dev/null` splits to `npm`,
// `</dev/null` so the head is not hidden. `2>&1` / `<>.env` / `>/dev/null` (empty or
// all-digit prefix) stay one token — already handled by skip() / the secret redirect scan.
const REDIR = /^([^<>]*)(\d*(?:<<<|<<|>>|<>|&>|>&|[<>]).*)$/

// Whitespace-tokenize a segment, peel a glued redirect operator off each word, and unescape.
export function tokenize(seg: string): string[] {
  const out: string[] = []
  for (const raw of seg.trim().split(/\s+/).filter(Boolean)) {
    const m = REDIR.exec(raw)
    if (m && m[1] !== '' && !/^\d+$/.test(m[1]!))
      out.push(m[1]!.replace(/\\(.)/g, '$1'), m[2]!.replace(/\\(.)/g, '$1'))
    else
      out.push(raw.replace(/\\(.)/g, '$1'))
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

// Guards run inside a stdin 'end' handler. On Windows, stdio pipes are asynchronous, and
// process.exit() from inside that handler right after a stderr write aborts the process
// (STATUS_STACK_BUFFER_OVERRUN, exit 3221226505) instead of returning the code. So a guard
// never calls process.exit(): exit() records the code and unwinds the handler by throwing a
// sentinel that run() swallows, and the loop drains on its own once stdin has ended.
const EXIT: unique symbol = Symbol('exit')

/** Records the guard's exit code and stops the handler; `never` so deny helpers keep their type. */
export function exit(code: 0 | 2): never {
  process.exitCode = code
  throw EXIT
}

/** Reads all of stdin, then runs the guard body with it; exit() is the only way the body ends early. */
export function run(body: (raw: string) => void): void {
  let raw = ''
  process.stdin.on('data', (d) => { raw += d }).on('end', () => {
    try {
      body(raw)
    }
    catch (e) {
      if (e !== EXIT)
        throw e
    }
  })
}
