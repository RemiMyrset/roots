import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    typescript: true,
    ignores: [
      'docs/**/.vitepress/cache',
      'docs/**/.vitepress/dist',
      // Checker fixtures, one of them deliberately broken; linting them would couple two gates
      // to a tree whose job is to be wrong.
      'scripts/docs/fixtures/**',
    ],
  },
  {
    name: 'repo/ban-class-and-enum',
    // Flat config REPLACES a rule's options rather than merging them, so antfu's own
    // `no-restricted-syntax` array is discarded here: `TSExportAssignment` is re-listed,
    // and `TSEnumDeclaration` supersedes its const-enum-only selector. `ignores` keeps
    // antfu's carve-outs (it turns this rule off in `.d.ts` and markdown code fences) so
    // ambient declarations and doc samples stay legal. Enums are also rejected by tsc
    // (`erasableSyntaxOnly`); classes are not, so ESLint is their only gate. The ban is on
    // DECLARING a class — instantiating a dependency's class (`new Map()`) is untouched.
    ignores: ['**/*.d.?([cm])ts', '**/*.md/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        'TSExportAssignment',
        { selector: 'TSEnumDeclaration', message: 'Enums are banned. Use a `const` object plus a union type.' },
        { selector: 'ClassDeclaration', message: 'Classes are banned — use functions and plain objects. If a dependency requires a subclass: // eslint-disable-next-line no-restricted-syntax -- <reason>' },
        { selector: 'ClassExpression', message: 'Class expressions are banned — use functions and plain objects.' },
      ],
    },
  },
  {
    name: 'repo/tests-live-in-test-dir',
    // Tests belong in `<package>/test/`, never beside the code they exercise. Vitest's
    // default glob is `**/`-anchored, so a stray colocated test still RUNS — it is caught
    // loudly here rather than skipped silently.
    files: ['**/src/**/*.{test,spec}.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Program', message: 'Tests live in `<package>/test/`, not colocated in `src/`. Move this file.' },
      ],
    },
  },
)
  // A flat-config rule must be declared in an object that registers its plugin, so the
  // `eslint-comments` rule is layered onto antfu's own block rather than a new one.
  // Every escape from a rule must carry a written reason (`-- why`) so the exception is
  // greppable and reviewable; antfu ships this rule off.
  .override('antfu/eslint-comments/rules', {
    rules: { 'eslint-comments/require-description': 'error' },
  })
  // Every exported symbol carries a `/** */` block (AGENTS.md rule), enforced here rather
  // than by convention: `publicOnly` limits the check to ESM exports, the `require` keys cover
  // exported functions in every spelling, and the contexts add exported interfaces, type
  // aliases, and plain values. What the block must SAY (purpose plus constraints a caller
  // cannot see, never a restatement) stays on the author. Layered onto antfu's jsdoc block,
  // which registers the plugin but leaves this rule off.
  .override('antfu/jsdoc/rules', {
    rules: {
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: { FunctionDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true },
        contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'ExportNamedDeclaration > VariableDeclaration'],
      }],
    },
  })
// Note: antfu default-ignores `.claude`, so the agent guard sources
// (`.claude/hooks/*.mts`) are NOT ESLint-linted — intentionally. They are covered by the
// root tsconfig typecheck (they are in its `include`) and by `pnpm test:hooks` (the behavioural
// suite in scripts/test-hooks.mts), which is the coverage that actually matters
// for them. Do not un-ignore them to "add lint": they are not antfu-clean and doing so turns
// CI red for ~style-only findings on zero-dependency, node-builtin shell-lexing code.
// Consequence: the class ban above does not reach them; their enums are still caught by tsc.
