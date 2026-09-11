/**
 * deny-build-scripts guard (imported by dispatch.mts). Blocks pnpm invocations
 * that enable dependency build/postinstall scripts. Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { resolveHead, segments, tokenize } from './_lexer.mts'

const BUILD = /(approve-builds|--allow-build|dangerously[-_]?allow[-_]?all[-_]?builds|dangerouslyAllowAllBuilds)/i

/** Denies a pnpm segment that carries a build-script approval flag or subcommand. */
export const verdict: Verdict = (cmd) => {
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    if (resolveHead(toks).head === 'pnpm' && BUILD.test(toks.join(' ')))
      return 'enabling dependency build scripts (approve-builds / allow-build flags) is a supply-chain code-exec vector. Human-only: run it yourself in a terminal.'
  }
  return null
}
