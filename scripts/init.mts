/**
 * One-shot initializer for a repository created from the roots template.
 * Run it FIRST, before `pnpm install`: node 24 executes it natively, and it
 * needs nothing outside node builtins. Deletes itself when done. Kept as `.mts`
 * (not `.ts`) so it is unambiguously ESM — it uses top-level await and runs before
 * install, so its module system must not hinge on package.json `"type"`.
 *
 * Interactive by default. Flags for CI and automation:
 *   --defaults        answer every prompt non-interactively (slug from the git
 *                     origin URL, else the directory name)
 *   --no-typescript   take the TypeScript-removal path (works with or without
 *                     --defaults)
 *
 * Executable spec: .github/workflows/init-check.yml asserts every observable
 * outcome of this script on both the TypeScript and non-TypeScript paths.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'

const [major] = process.versions.node.split('.')
if (Number(major) < 24) {
  console.error(`roots requires node >= 24 (found ${process.version}). Install via .node-version.`)
  process.exit(1)
}

const root = process.cwd()
if (!existsSync(join(root, 'scripts/init.mts'))) {
  console.error('Run from the repository root: node scripts/init.mts')
  process.exit(1)
}

const useDefaults = process.argv.includes('--defaults')
const noTs = process.argv.includes('--no-typescript')
const REMOTE_SLUG_RE = /\/([\w.-]+?)(?:\.git)?$/

function deriveSlug(): string {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const m = url.match(REMOTE_SLUG_RE)
    if (m)
      return m[1]!
  }
  catch {}
  return basename(root)
}

// The slug lands in package.json `name` and in the VitePress config TS source.
// Reject anything outside the character class the remote-slug regex assumes, so
// a stray quote, space, or backslash cannot break the generated configs.
function validateSlug(slug: string): string {
  if (!/^[\w.-]+$/.test(slug) || !/[a-z0-9]/i.test(slug)) {
    console.error(`Invalid project slug "${slug}" — letters, digits, '.', '_', '-', and at least one alphanumeric.`)
    process.exit(1)
  }
  return slug
}

interface Answers {
  slug: string
  title: string
  description: string
  typescript: boolean
}

// The subset of package.json this script reads or mutates. Typed so the parsed
// manifest is never `any` (JSON.parse returns `any`); the index signature keeps
// the untouched fields addressable without widening the known ones.
interface PackageJson {
  'name': string
  'version': string
  'description': string
  'scripts': Record<string, string>
  'devDependencies': Record<string, string>
  'simple-git-hooks': Record<string, string>
  'lint-staged'?: unknown
  [key: string]: unknown
}

async function ask(): Promise<Answers> {
  const slugDefault = deriveSlug()
  if (useDefaults) {
    return {
      slug: validateSlug(slugDefault),
      title: slugDefault,
      description: '',
      typescript: !noTs,
    }
  }

  if (!process.stdin.isTTY) {
    console.error('stdin is not a TTY — run non-interactively: node scripts/init.mts --defaults [--no-typescript]')
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const slug = validateSlug((await rl.question(`Project slug [${slugDefault}]: `)).trim() || slugDefault)
  const title = (await rl.question(`Human title [${slug}]: `)).trim() || slug
  const description = (await rl.question('One-line description []: ')).trim()
  let typescript = false
  if (!noTs) {
    const ts = (await rl.question('TypeScript project? [Y/n]: ')).trim().toLowerCase()
    typescript = ts !== 'n' && ts !== 'no'
  }
  rl.close()
  return { slug, title, description, typescript }
}

function replaceInFile(path: string, replacements: [from: string | RegExp, to: string][]): void {
  const abs = join(root, path)
  if (!existsSync(abs))
    return
  let text = readFileSync(abs, 'utf8')
  // Replacements are taken literally: wrap `to` in a function so `$&`, `$1`,
  // `$'` etc. in a user-supplied slug/title/description are not re-interpreted
  // as replacement patterns (which would re-inject matched text or file tails).
  for (const [from, to] of replacements)
    text = typeof from === 'string' ? text.replaceAll(from, () => to) : text.replace(from, () => to)
  writeFileSync(abs, text)
}

const a = await ask()
const today = new Date().toISOString().slice(0, 10)

// 1. Names, titles, and descriptions across the replacement manifest.
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
pkg.name = a.slug
pkg.version = '0.0.0'
pkg.description = a.description || `${a.title}.`
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

replaceInFile('README.md', [
  // README H1 gets the human title (reader-facing); AGENTS.md and the doc-site
  // titles use the slug (an identifier). Under --defaults slug === title, so they
  // only differ when the owner supplies a distinct title — an intentional split.
  ['# roots', `# ${a.title}`],
  [/Rapid Opinionated Onboarding[\s\S]*?wired from day one\./, a.description || `${a.title}.`],
])
replaceInFile('AGENTS.md', [
  [/<!-- roots:template-only -->[\s\S]*?<!-- \/roots:template-only -->\n+/g, ''],
  ['# roots agent rulebook', `# ${a.slug} agent rulebook`],
  // Consume the description AND the guidance comment that follows it: that
  // comment tells the owner to "replace the two lines above", which init just
  // did — leaving it would ship a stale, self-contradicting instruction.
  [/Rapid Opinionated Onboarding — TypeScript\. A template repository[\s\S]*?docs system\.\n<!-- After init:[\s\S]*?-->/, a.description || `${a.title}.`],
  ['@roots/core', `@${a.slug}/core`],
])
// The per-site VitePress configs hard-code titles that override the shared
// fragment, so they must be renamed too. Anchor each rename to the exact
// occurrence — a title assignment or top-of-file heading — instead of a blind
// substring swap, so a future literal "roots" (e.g. a link back to the template
// repo) is never mangled.
const RENAMES: [path: string, from: string, to: string][] = [
  ['docs/.shared/config.ts', `title: 'roots'`, `title: '${a.slug}'`],
  ['docs/internal/.vitepress/config.ts', `title: 'roots — internal handbook'`, `title: '${a.slug} — internal handbook'`],
  ['docs/public/.vitepress/config.ts', `title: 'roots'`, `title: '${a.slug}'`],
  ['docs/internal/index.md', '# roots internal handbook', `# ${a.slug} internal handbook`],
  ['docs/public/index.md', '# roots', `# ${a.slug}`],
  ['docs/README.md', '# roots documentation', `# ${a.slug} documentation`],
]
for (const [f, from, to] of RENAMES)
  replaceInFile(f, [[from, to]])
replaceInFile('packages/core/package.json', [['@roots/core', `@${a.slug}/core`]])
replaceInFile('packages/core/src/index.ts', [['@roots/core', `@${a.slug}/core`]])

// Strip template-only regions from README.
replaceInFile('README.md', [
  [/<!-- roots:template-only -->[\s\S]*?<!-- \/roots:template-only -->\n+/g, ''],
])

// 2. Reset the decision log: the template's meta-decision is replaced by a fresh
//    provenance record so the child's history starts at its own 0001.
rmSync(join(root, 'docs/internal/decisions/0001-adopt-roots-conventions.md'), { force: true })
writeFileSync(join(root, 'docs/internal/decisions/0001-adopt-roots-conventions.md'), `# 0001. Adopt the roots template conventions

- **Status:** accepted
- **Date:** ${today}

## Context and Problem Statement

This repository was created from the roots template (RemiMyrset/roots). Which
conventions govern documentation, decisions, specs, and agent configuration?

## Considered Options

* Adopt the roots conventions wholesale
* Diverge immediately

## Decision Outcome

Chosen option: "Adopt the roots conventions wholesale", because they arrive
pre-wired and CI-enforced: portable markdown (GitHub + VitePress + Obsidian),
MADR-4-minimal decision records, capability and entity specs with three-place
sync, automd-generated indexes, and the AGENTS.md rulebook. Divergences from
this baseline are recorded as superseding decisions.

### Consequences

* Good, because every convention is enforced by \`pnpm docs:check\` and CI, not memory.
* Bad, because the docs toolchain requires node 24 and pnpm even for docs-only edits.
`)

// 3. Optional TypeScript layer removal.
if (!a.typescript) {
  // Also scrub editor config for the TS layer that no longer exists: the .vscode
  // tsdk pin points at a typescript/lib the no-TS child won't install, and the
  // ESLint extension recommendation is moot once eslint.config.ts is gone.
  for (const f of ['tsconfig.json', 'tsconfig.base.json', 'eslint.config.ts', 'turbo.json', 'packages', '.vscode/settings.json'])
    rmSync(join(root, f), { recursive: true, force: true })
  replaceInFile('.vscode/extensions.json', [[', "dbaeumer.vscode-eslint"', '']])
  for (const s of ['build', 'test', 'typecheck', 'lint', 'lint:fix'])
    delete pkg.scripts[s]
  delete pkg['lint-staged']
  pkg['simple-git-hooks']['pre-commit'] = 'pnpm docs:portability'
  for (const d of ['@antfu/eslint-config', 'eslint', 'jiti', 'lint-staged', 'turbo', 'typescript', '@types/node', '@tsconfig/node24', '@tsconfig/strictest'])
    delete pkg.devDependencies[d]
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  // The rulebook and README must not command agents to run deleted scripts or
  // enforce a TypeScript-only policy the owner just opted out of.
  replaceInFile('AGENTS.md', [
    [/- Install: `pnpm install`[\s\S]*?- Docs, preview: `pnpm docs:internal:dev` \/ `pnpm docs:public:dev`/, [
      '- Install: `pnpm install`',
      '- Test hooks: `pnpm test:hooks` (PreToolUse guard allow/deny fixtures)',
      '- Docs, regenerate: `pnpm docs:gen` (automd indexes + llms.txt)',
      '- Docs, validate: `pnpm docs:check && pnpm docs:portability`',
      '- Docs, build (CI-blocking): `pnpm docs:internal:build && pnpm docs:public:build`',
      '- Docs, preview: `pnpm docs:internal:dev` / `pnpm docs:public:dev`',
      '<!-- Add your stack\'s build/test/lint commands here the moment they exist —',
      '     they are the highest-value content in this file for agents. -->',
    ].join('\n')],
    [/- ALWAYS use TypeScript\.[\s\S]*?extensions\.\n/, ''],
    [/## Monorepo map\n[\s\S]*?(?=## Gotchas)/, '## Monorepo map\n\nNot set up — the TypeScript workspace layer was removed at init. Map your\nstack\'s layout here when it lands.\n\n'],
  ])
  replaceInFile('README.md', [
    [/\| `pnpm build`[^\n]*\n/, ''],
    [/\| `pnpm lint`[^\n]*\n/, ''],
  ])

  writeFileSync(join(root, '.github/workflows/ci.yml'), `# Placeholder project CI — the TypeScript layer was removed at init.
# Replace the body with your stack's real gates and change \`on:\` to
# push/pull_request. Until then it runs only manually, so it can never fake a
# green check.
name: ci

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - run: echo "Replace this workflow with real project CI."
`)
}

// 4. Self-delete — this script runs exactly once. The init-check workflow only
//    validates the template itself, so remove it too rather than leave a
//    permanently-skipped workflow in the child.
rmSync(join(root, '.github/workflows/init-check.yml'), { force: true })
rmSync(join(root, 'scripts/init.mts'))

console.log(`
${a.title} initialized from roots.

Manual checklist (things a script cannot do for you):

  [ ] pnpm install && pnpm docs:gen && pnpm docs:check && pnpm docs:portability
  [ ] Branch ruleset (require the "docs"${a.typescript ? ' and "ci"' : ''} checks, block force-push):
        repo Settings -> Rules -> Rulesets (enforcement on private repos needs GitHub Pro)
  [ ] Disable wiki + projects (docs live in-repo):
        gh api -X PATCH repos/<owner>/${a.slug} -f has_wiki=false -f has_projects=false
  [ ] Seed repo labels: gh workflow run labels.yml (or Actions -> labels -> Run workflow)
  [ ] Review LICENSE (template ships MIT).
  [ ] Fill the AGENTS.md guidance comments as sections become real; delete the comments.${a.typescript ? '' : '\n  [ ] AGENTS.md and README were trimmed for the non-TypeScript path — review them.'}
  [ ] Commit: "chore: initialize from roots"
`)
