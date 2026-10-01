/**
 * deny-build-scripts guard (imported by dispatch.mts). Blocks pnpm invocations that enable
 * dependency build/postinstall scripts (`approve-builds`, `--allow-build`, a flag or a
 * `pnpm config set` that sets `allowBuilds`, `onlyBuiltDependencies`, or
 * `dangerouslyAllowAllBuilds`), run directly or through npx, and a `pnpm_config_*` variable
 * that does the same, assigned or exported. Reading a setting (`pnpm config get allowBuilds`)
 * passes. Shared lexing in ./_lexer.mts. Scope and out-of-scope: docs/template/guards.md.
 */
import type { Verdict } from './_lexer.mts'
import { base, exportedWords, leadIndex, npxTarget, PNPM_DLX, segments, tokenize, unquote } from './_lexer.mts'

// The subcommand and the flag that approve a dependency's build scripts, anywhere on a pnpm line.
const APPROVE = /approve-builds|--allow-build/i
// The settings that let a dependency's build scripts run, in each spelling pnpm reads: a config
// key (`allowBuilds`, `only-built-dependencies`), a flag, or a `pnpm_config_*` variable.
const SETTING = /allow[-_]?builds|only[-_]?built[-_]?dependencies|dangerously[-_]?allow[-_]?all[-_]?builds/i

// Whether the pnpm command at `lead` (`pn`, `pnx`, and `pnpx` too) enables builds: it approves
// them, sets a setting through a flag (`--config.allowBuilds=…`,
// `--dangerously-allow-all-builds`), or names one after `pnpm config set` or its `pnpm set`
// shorthand. A setting named anywhere else is read, not set.
function pnpmEnables(toks: string[], lead: number): boolean {
  const b = base(toks[lead] ?? '')
  if (b !== 'pnpm' && !PNPM_DLX.has(b))
    return false
  const words = toks.slice(lead + 1).map(unquote)
  const set = words.indexOf('set')
  return words.some((w, k) => APPROVE.test(w) || (SETTING.test(w) && (w.startsWith('-') || (set >= 0 && k > set))))
}

// Whether the segment assigns or exports a `pnpm_config_*` variable that allows builds: a prefix
// (`X=1 pnpm i`), a plain assignment that a later `export X` or an earlier `set -a` exports, or
// an `export` or `declare -x` of it.
function assignsBuilds(toks: string[], lead: number): boolean {
  const assigned = toks.slice(0, lead).map(unquote).filter(w => w.includes('='))
  return [...assigned, ...exportedWords(toks)].some((w) => {
    const name = w.split('=')[0]!
    return /^p?npm_config_/i.test(name) && SETTING.test(name)
  })
}

// The lead word past any npx in front of it and past the wrapper words npx runs, skipped as
// leadIndex() skips them on a bare line: `npx -y pnpm@11 approve-builds` and
// `npx corepack pnpm approve-builds` both run pnpm.
function pastNpx(toks: string[], lead: number): number {
  while (base(toks[lead] ?? '') === 'npx') {
    const target = npxTarget(toks, lead)
    if (target < 0)
      break
    lead = target + leadIndex(toks.slice(target))
  }
  return lead
}

/**
 * Denies a segment whose pnpm command (the lead word, past npx but before `exec`/`dlx`
 * unwrapping) approves build scripts or sets a setting that allows them, and one that assigns
 * or exports a `pnpm_config_*` variable that does.
 */
export const verdict: Verdict = (cmd) => {
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg)
    const lead = pastNpx(toks, leadIndex(toks))
    if (pnpmEnables(toks, lead) || assignsBuilds(toks, lead))
      return 'enabling dependency build scripts (approve-builds / allow-build flags / allowBuilds) is a supply-chain code-exec vector. Human-only: run it yourself in a terminal.'
  }
  return null
}
