/**
 * deny-non-pnpm guard body (invoked by deny-non-pnpm.sh). Blocks npm/yarn/bun/bunx at a
 * command head. Shared lexing lives in ./_lexer.mts. Node builtins only. exit 2 = deny.
 */
import process from 'node:process'
import { BANNED, resolveHead, segments, tokenize } from './_lexer.mts'

let s = ''
process.stdin.on('data', (d) => { s += d }).on('end', () => {
  let cmd: string
  try {
    cmd = String((JSON.parse(s).tool_input || {}).command || '')
  }
  catch {
    process.stderr.write('pnpm guard: could not parse hook input as JSON; denying by default (fail closed).\n')
    process.exit(2)
  }
  const heads: string[] = []
  for (const seg of segments(cmd)) {
    const { head, probe } = resolveHead(tokenize(seg))
    if (probe)
      continue
    if (head)
      heads.push(head)
  }
  if (heads.some(h => BANNED.has(h))) {
    process.stderr.write('Blocked: this repo uses pnpm exclusively (AGENTS.md non-negotiable rules). Re-run with pnpm.\n')
    process.exit(2)
  }
  process.exit(0)
})
