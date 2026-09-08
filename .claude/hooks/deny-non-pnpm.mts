/**
 * deny-non-pnpm guard body (run via dispatch.mts). Blocks npm/yarn/bun/bunx at a
 * command head. Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md. exit 2 = deny.
 */
import process from 'node:process'
import { BANNED, commandOf, exit, resolveHead, run, segments, tokenize } from './_lexer.mts'

run((s) => {
  const cmd = commandOf(s)
  if (cmd === null) {
    process.stderr.write('pnpm guard: hook input is not a pre-tool payload with tool_input.command; denying by default (fail closed).\n')
    exit(2)
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
    exit(2)
  }
  exit(0)
})
