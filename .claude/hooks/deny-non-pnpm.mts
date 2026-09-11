/**
 * deny-non-pnpm guard (imported by dispatch.mts). Blocks npm/yarn/bun/bunx at a
 * command head. Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { BANNED, resolveHead, segments, tokenize } from './_lexer.mts'

/** Denies when any segment's command head is a banned package manager. */
export const verdict: Verdict = (cmd) => {
  const heads: string[] = []
  for (const seg of segments(cmd)) {
    const { head, probe } = resolveHead(tokenize(seg))
    if (probe)
      continue
    if (head)
      heads.push(head)
  }
  if (heads.some(h => BANNED.has(h)))
    return 'this repo uses pnpm exclusively (AGENTS.md non-negotiable rules). Re-run with pnpm.'
  return null
}
