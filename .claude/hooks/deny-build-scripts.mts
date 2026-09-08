/**
 * deny-build-scripts guard body (run via dispatch.mts). Blocks pnpm invocations
 * that enable dependency build/postinstall scripts. Shared lexing in ./_lexer.mts. Scope and out-of-scope: SECURITY.md. exit 2 = deny.
 */
import process from 'node:process'
import { commandOf, exit, resolveHead, run, segments, tokenize } from './_lexer.mts'

const BUILD = /(approve-builds|--allow-build|dangerously[-_]?allow[-_]?all[-_]?builds|dangerouslyAllowAllBuilds)/i

run((s) => {
  const cmd = commandOf(s)
  if (cmd === null) {
    process.stderr.write('build-scripts guard: hook input is not a pre-tool payload with tool_input.command; denying by default (fail closed).\n')
    exit(2)
  }
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    if (resolveHead(toks).head === 'pnpm' && BUILD.test(toks.join(' '))) {
      process.stderr.write('Blocked: enabling dependency build scripts (approve-builds / allow-build flags) is a supply-chain code-exec vector. Human-only: run it yourself in a terminal.\n')
      exit(2)
    }
  }
  exit(0)
})
