/**
 * One-shot initializer for a repository created from the roots template.
 * Run it FIRST, before `pnpm install`: node 24 executes it natively, and it
 * needs nothing outside node builtins. Deletes itself when done. Kept as `.mts`
 * (not `.ts`) so it is unambiguously ESM — it uses top-level await and runs before
 * install, so its module system must not hinge on package.json `"type"`.
 *
 * Interactive by default. `--defaults` answers every prompt non-interactively
 * (slug from the git origin URL, else the directory name).
 *
 * Executable spec: .github/workflows/init-check.yml asserts every observable
 * outcome of this script.
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
}

// The subset of package.json this script mutates. Typed so the parsed manifest
// is never `any` (JSON.parse returns `any`); the index signature keeps the
// untouched fields addressable without widening the known ones.
interface PackageJson {
  name: string
  version: string
  description: string
  [key: string]: unknown
}

async function ask(): Promise<Answers> {
  const slugDefault = deriveSlug()
  if (useDefaults) {
    return {
      slug: validateSlug(slugDefault),
      title: slugDefault,
      description: '',
    }
  }

  if (!process.stdin.isTTY) {
    console.error('stdin is not a TTY — run non-interactively: node scripts/init.mts --defaults')
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const slug = validateSlug((await rl.question(`Project slug [${slugDefault}]: `)).trim() || slugDefault)
  const title = (await rl.question(`Human title [${slug}]: `)).trim() || slug
  const description = (await rl.question('One-line description []: ')).trim()
  rl.close()
  return { slug, title, description }
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
  [/<!-- roots:template-only -->[\s\S]*?<!-- \/roots:template-only -->\n+/g, ''],
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
// The sample test greets the project by name; the slug is validated to a safe
// character class above, so it cannot break the string literal.
replaceInFile('packages/core/test/index.test.ts', [
  [`greet('roots')`, `greet('${a.slug}')`],
  [`'Hello, roots!'`, `'Hello, ${a.slug}!'`],
])

// 2. Clear the decision log and the specs: those folders belong to the child, so
//    it starts with only the index and template files. The template's own
//    rationale lives in docs/template/ (template-owned, synced) and stays.
for (const dir of ['docs/internal/decisions', 'docs/internal/specs']) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md' || entry.name === '_template.md')
      continue
    rmSync(join(entry.parentPath, entry.name), { force: true })
  }
}

// 3. Self-delete — this script runs exactly once. The init-check workflow only
//    validates the template itself, so remove it too rather than leave a
//    permanently-skipped workflow in the child.
rmSync(join(root, '.github/workflows/init-check.yml'), { force: true })
rmSync(join(root, 'scripts/init.mts'))

console.log(`
${a.title} initialized from roots.

Manual checklist (things a script cannot do for you):

  [ ] pnpm install && pnpm docs:gen && pnpm docs:check && pnpm docs:portability
  [ ] Branch ruleset (require the "docs" and "ci" checks, block force-push):
        repo Settings -> Rules -> Rulesets (enforcement on private repos needs GitHub Pro)
  [ ] Disable wiki + projects (docs live in-repo):
        gh api -X PATCH repos/<owner>/${a.slug} -f has_wiki=false -f has_projects=false
  [ ] Seed repo labels: gh workflow run labels.yml (or Actions -> labels -> Run workflow)
  [ ] Review LICENSE (template ships MIT).
  [ ] Fill the AGENTS.md guidance comments as sections become real; delete the comments.
  [ ] Commit: "chore: initialize from roots"
`)
