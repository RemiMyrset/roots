import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  typescript: true,
  ignores: [
    'docs/**/.vitepress/cache',
    'docs/**/.vitepress/dist',
    'docs/llms-full.txt',
    'docs/llms.txt',
  ],
})
// Note: antfu default-ignores `.claude`, so the PreToolUse guard sources
// (`.claude/hooks/*.mts`) are NOT ESLint-linted — intentionally. They are covered by the
// root tsconfig typecheck (they are in its `include`) and by `pnpm test:hooks` (the behavioural
// suite in scripts/test-hooks.mts), which is the coverage that actually matters
// for them. Do not un-ignore them to "add lint": they are not antfu-clean and doing so turns
// CI red for ~style-only findings on zero-dependency, node-builtin shell-lexing code.
