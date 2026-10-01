import antfu from '@antfu/eslint-config'

/**
 * The `jsdoc/require-jsdoc` options: `publicOnly` limits the check to ESM exports, the
 * `require` keys cover exported functions in every spelling, and the contexts add exported
 * interfaces, type aliases, and plain values. A default export is added below, outside a tool
 * config.
 */
const docBlocks = {
  publicOnly: true,
  require: { FunctionDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true },
  contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'ExportNamedDeclaration > VariableDeclaration'],
}

export default antfu(
  {
    type: 'app',
    typescript: true,
    // antfu ignores every `.claude` directory. The guard sources under `.claude/hooks` are
    // TypeScript the repo rules hold for, so they are linted; the rest of `.claude` stays out.
    ignores: originals => [
      ...originals.filter(glob => glob !== '**/.claude'),
      '**/.claude/*',
      '!.claude/hooks/',
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
        // The dynamic-import half of `repo/ts-import-specifiers` below, listed here because a
        // second `no-restricted-syntax` block would discard the bans above. `\x2F` is a `/`,
        // which an esquery regex cannot contain.
        { selector: 'ImportExpression[source.value=/^\\.\\.?\\x2F.*\\.[cm]?jsx?$/]', message: 'Import the .ts/.mts source: node runs it as written and has no .js file to load.' },
        // `jsdoc/require-jsdoc` reads a `/** */` block at the declaration, so a symbol exported
        // through a local list (`export { a }`, `export type { T }`) escapes it. A re-export
        // (`export { a } from './a.ts'`) is checked where it is declared.
        { selector: 'ExportNamedDeclaration[declaration=null][source=null][specifiers.length>0]', message: 'Export at the declaration (`export const a`), where jsdoc/require-jsdoc checks its /** */ block.' },
      ],
    },
  },
  {
    name: 'repo/typescript-only',
    // No JavaScript source (AGENTS.md): a .js/.mjs file escapes the typecheck, since tsc has no
    // `allowJs`. `ignores` keeps ```js fences in markdown legal. The escape is a whole-file
    // disable because the report sits on `Program`; a next-line disable does not reach it.
    files: ['**/*.{js,mjs,cjs,jsx}'],
    ignores: ['**/*.md/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Program', message: 'TypeScript only: rename this file to .ts or .mts. If a tool reads only a JavaScript config: /* eslint-disable no-restricted-syntax -- <reason> */ as line 1.' },
      ],
    },
  },
  {
    name: 'repo/ts-import-specifiers',
    // Node runs the TypeScript source directly and loads a relative specifier as written, so
    // `./util.js` throws ERR_MODULE_NOT_FOUND at runtime while tsc (nodenext maps .js to .ts)
    // and vitest both resolve it. Declarations keep the .js form they describe.
    files: ['**/*.{ts,mts,cts,tsx}'],
    ignores: ['**/*.d.?([cm])ts', '**/*.md/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ regex: '^\\.\\.?/.*\\.[cm]?jsx?$', message: 'Import the .ts/.mts source: node runs it as written and has no .js file to load.' }],
      }],
    },
  },
  {
    name: 'repo/trust-policy-exact-versions',
    // A bare package name under `trustPolicyExclude` waives pnpm's no-downgrade check for every
    // future release of that package, including a hijacked one; an entry names exact versions.
    files: ['pnpm-workspace.yaml'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'YAMLPair[key.value=\'trustPolicyExclude\'] > YAMLSequence > YAMLScalar[value=/^@?[^@]+$/]', message: 'Exclude exact versions (name@1.2.3 || 1.2.4), never a whole package.' },
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
  // Every escape from a rule must carry a written reason (`-- why`) so the exception is
  // greppable and reviewable; antfu ships this rule off. Layered onto antfu's own block.
  .override('antfu/eslint-comments/rules', {
    rules: { 'eslint-comments/require-description': 'error' },
  })
  // Every exported symbol carries a `/** */` block (AGENTS.md rule), enforced here rather
  // than by convention, with `docBlocks` above plus a default export that is no function
  // (`export default {…}`; the `require` keys already cover a function). A local export list,
  // which this rule cannot see through, is banned in `repo/ban-class-and-enum`. What the block
  // must SAY (purpose plus constraints a caller cannot see, never a restatement) stays on the
  // author. Layered onto antfu's jsdoc block, which registers the plugin but leaves this rule
  // off.
  .override('antfu/jsdoc/rules', {
    rules: {
      'jsdoc/require-jsdoc': ['error', { ...docBlocks, contexts: [...docBlocks.contexts, 'ExportDefaultDeclaration[declaration.type!=/Function/]'] }],
    },
  })
  // A tool config's default export is read by its tool, never by a caller, so the default
  // export alone is exempt there; a named export in a config still needs its block.
  .append({
    name: 'repo/tool-config-default-export',
    files: ['**/*.config.?([cm])ts', '**/.vitepress/config.?([cm])ts'],
    rules: { 'jsdoc/require-jsdoc': ['error', docBlocks] },
  })
