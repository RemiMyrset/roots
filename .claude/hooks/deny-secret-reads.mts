/**
 * deny-secret-reads guard body (invoked by deny-secret-reads.sh). Blocks shell reads of
 * secret files (.env*, secrets/, *.pem, *.key) — direct readers, `<` redirects, pnpm-exec
 * wrappers, and `find -exec` at a secret literal. Shared lexing in ./_lexer.mts. exit 2 = deny.
 */
import process from 'node:process'
import { resolveHead, segments, tokenize, unquote } from './_lexer.mts'

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

function isSecret(arg: string): boolean {
  const p = unquote(arg).replace(/\)+$/, '').replace(/^(?:if|of)=/, '')
  if (/(?:^|\/)secrets(?:\/|$)/i.test(p))
    return true
  if (/\.(?:pem|key)$/i.test(p))
    return true
  // Lowercased so the match is case-insensitive, matching the *.pem/*.key branch above (a
  // case-insensitive filesystem treats `.ENV` as `.env`, and lowercase is the safe direction).
  const b = (p.split('/').pop() ?? '').toLowerCase()
  // Secret env files: `.env`, any separator-suffixed variant (.env.production, .env-prod,
  // .env_x, the `.env~` editor backup), and `.envrc` (direnv, holds exports) plus its own
  // suffixed variants (.envrc.bak, .envrc~) — but NOT an unrelated basename that merely starts
  // with those letters (.environment). `(?:rc)?` = optional `rc`, then require end-or-separator
  // so a backup/copy spelling can never slip a byte-identical secret. `.env.example` is the ONE
  // deliberate carve-out; other placeholder spellings (.env.sample/.template/.dist) fail closed
  // ON PURPOSE — a filename guard cannot verify they hold no real secret, so they are denied
  // (safe direction, documented in the .sh header; never a bypass).
  return /^\.env(?:rc)?(?:$|[.\-_~])/.test(b) && b !== '.env.example'
}

function braceMembers(a: string): string[] {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(a)
  return m ? m[2]!.split(',').map(x => m[1]! + x + m[3]!) : [a]
}

let s = ''
process.stdin.on('data', (d) => { s += d }).on('end', () => {
  let cmd: string
  try {
    cmd = String((JSON.parse(s).tool_input || {}).command || '')
  }
  catch {
    process.stderr.write('secret-read guard: could not parse hook input as JSON; denying by default (fail closed).\n')
    process.exit(2)
  }
  const deny = (): never => {
    process.stderr.write('Blocked: reading secrets (.env, .env.*, secrets/, *.pem, *.key) via the shell is denied — same policy as the Read tool.\n')
    process.exit(2)
  }
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    // `<` redirect into a secret (`$(<.env)`, `read x < .env`, `cat <.env`, `cat <>.env`),
    // regardless of the head command. Strip a leading `>` off the `<>` read-write target.
    for (let j = 0; j < toks.length; j++) {
      const m = /^\d*<+(.*)$/.exec(toks[j]!)
      if (!m)
        continue
      let tgt = m[1]!.replace(/^>/, '').replace(/\)+$/, '')
      if (!tgt)
        tgt = toks[j + 1] ?? ''
      if (tgt && isSecret(tgt))
        deny()
    }
    const { i, head, probe } = resolveHead(toks)
    if (probe)
      continue
    // find ... -exec|-ok <reader> {} pointed at a secret literal.
    if (head === 'find' && toks.some(t => /^-(?:exec|ok)(?:dir)?$/.test(unquote(t))) && toks.slice(i + 1).flatMap(braceMembers).some(isSecret))
      deny()
    if (!READERS.has(head))
      continue
    const args: string[] = []
    for (let k = i + 1; k < toks.length; k++) {
      if (OUTPUT_O.has(head) && /^(?:-o|--output)$/.test(unquote(toks[k]!))) { k++; continue }
      args.push(toks[k]!)
    }
    if (args.flatMap(braceMembers).some(isSecret))
      deny()
  }
  process.exit(0)
})
