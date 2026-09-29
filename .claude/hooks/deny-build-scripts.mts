/**
 * deny-build-scripts guard (imported by dispatch.mts). Blocks pnpm invocations that enable
 * dependency build/postinstall scripts (`approve-builds`, `--allow-build`, a config set of
 * `allowBuilds` or `onlyBuiltDependencies`) and an exported `pnpm_config_*` variable that does
 * the same. Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { base, exportedAssignments, leadIndex, resolveHead, segments, tokenize } from './_lexer.mts'

// The subcommand, the flags, the settings (`allowBuilds`, `onlyBuiltDependencies`), and the
// `pnpm_config_*` variables that let a dependency's build scripts run.
const BUILD = /approve-builds|--allow-build|allow[-_]?builds|only[-_]?built[-_]?dependencies|dangerously[-_]?allow[-_]?all[-_]?builds/i

/**
 * Denies a segment where pnpm is a command word (before or after `exec`/`dlx` unwrapping) and
 * a build-script approval appears, and an `export` or `declare -x` of a `pnpm_config_*`
 * variable that allows build scripts.
 */
export const verdict: Verdict = (cmd) => {
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const pnpm = base(toks[leadIndex(toks)] ?? '') === 'pnpm' || resolveHead(toks).head === 'pnpm'
    const exported = exportedAssignments(toks).some(a => /^p?npm_config_/i.test(a) && BUILD.test(a.split('=')[0]!))
    if ((pnpm && BUILD.test(toks.join(' '))) || exported)
      return 'enabling dependency build scripts (approve-builds / allow-build flags / allowBuilds) is a supply-chain code-exec vector. Human-only: run it yourself in a terminal.'
  }
  return null
}
