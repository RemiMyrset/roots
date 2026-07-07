/**
 * deny-build-scripts guard body (invoked by deny-build-scripts.sh). Blocks pnpm invocations
 * that enable dependency build/postinstall scripts. Shared lexing in ./_lexer.mts. exit 2 = deny.
 */
import process from 'node:process'
import { resolveHead, segments, tokenize } from './_lexer.mts'

const BUILD = /(approve-builds|--allow-build|dangerously[-_]?allow[-_]?all[-_]?builds|dangerouslyAllowAllBuilds)/i

let s = ''
process.stdin.on('data', (d) => { s += d }).on('end', () => {
  let cmd: string
  try {
    cmd = String((JSON.parse(s).tool_input || {}).command || '')
  }
  catch {
    process.stderr.write('build-scripts guard: could not parse hook input as JSON; denying by default (fail closed).\n')
    process.exit(2)
  }
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    if (resolveHead(toks).head === 'pnpm' && BUILD.test(toks.join(' '))) {
      process.stderr.write('Blocked: enabling dependency build scripts (approve-builds / allow-build flags) is a supply-chain code-exec vector. Human-only: run it yourself in a terminal.\n')
      process.exit(2)
    }
  }
  process.exit(0)
})
