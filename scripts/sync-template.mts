/**
 * On-demand template update — no cron, no bot, no token, just git. Pulls the roots
 * mechanics (the shared docs, labels, and guards CI workflows, the docs generators
 * and guard test-suite, agent hooks/rules/skills) from the template repo into this
 * one. Works from any repo, whether or not it was created from the template.
 *
 *   pnpm sync:template            # pull from the default template URL
 *   pnpm sync:template <git-url>  # or point at your own fork
 *
 * It stages the template's version of the mechanics paths; nothing is committed.
 * Review `git diff --cached`, keep what you want, discard the rest. Your app code
 * (package.json, src/, packages/, docs content, .claude/settings.json) is never
 * touched — only the paths in MECHANICS below.
 */
import { execSync } from 'node:child_process'
import process from 'node:process'

const TEMPLATE_URL = 'https://github.com/RemiMyrset/roots.git'
const REMOTE = 'template'
const BRANCH = 'main'

// Shared machinery worth keeping current across repos. Rarely customized, so a
// take-theirs-then-review is the right default. Add the shared configs
// (tsconfig.base.json, eslint.config.ts, turbo.json, automd.config.ts,
// .editorconfig) here if you want those pulled too — omitted by default because
// projects tend to tune them. Never add package.json, src/, packages/, docs
// content, or .claude/settings.json: those are yours.
const MECHANICS = [
  '.github/workflows/docs.yml',
  '.github/workflows/labels.yml',
  '.github/workflows/guards.yml',
  '.github/labels.yml',
  '.github/ISSUE_TEMPLATE',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'scripts/docs',
  'scripts/test-hooks.mts',
  '.claude/hooks',
  '.claude/rules',
  '.claude/skills',
]

function git(args: string, opts: { capture?: boolean } = {}): string {
  return execSync(`git ${args}`, {
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  }) ?? ''
}

function tryGit(args: string): boolean {
  try {
    git(args, { capture: true })
    return true
  }
  catch {
    return false
  }
}

if (!tryGit('rev-parse --is-inside-work-tree')) {
  console.error('Not a git repository — run this from your project root.')
  process.exit(1)
}

// Ensure the `template` remote. An explicit URL arg always wins; otherwise keep
// an existing remote (a fork's own template) and only add the default if absent.
const urlArg = process.argv[2]
// Validate the operator-supplied URL before it flows into a git() shell string: accept only
// plausible git URL / scp-form / local-path characters, reject anything carrying a shell
// metachar (space, ; & | $ ` () <> quotes …) so `pnpm sync:template 'x; rm -rf ~'` cannot inject.
if (urlArg !== undefined && !/^[\w@:/.+~-]+$/.test(urlArg)) {
  console.error(`Refusing suspicious template URL (contains shell-unsafe characters): ${urlArg}`)
  process.exit(1)
}
if (tryGit(`remote get-url ${REMOTE}`)) {
  if (urlArg)
    git(`remote set-url ${REMOTE} ${urlArg}`, { capture: true })
}
else {
  git(`remote add ${REMOTE} ${urlArg ?? TEMPLATE_URL}`, { capture: true })
}

// Refuse to clobber uncommitted work in the mechanics paths.
const dirty = git(`status --porcelain -- ${MECHANICS.join(' ')}`, { capture: true }).trim()
if (dirty) {
  console.error('Uncommitted changes in template-managed paths — commit or stash first:\n')
  console.error(dirty)
  process.exit(1)
}

try {
  git(`fetch ${REMOTE} ${BRANCH}`)
}
catch {
  console.error(`\nCould not fetch ${REMOTE}/${BRANCH}. Check the remote URL (git remote -v) and your network.`)
  process.exit(1)
}

// For each synced path: take the template's version of the files it still ships
// (add/update via checkout), then stage removals for local files the template
// retired upstream so those deletions also surface in `git diff --cached`.
// Deletions are scoped to the tracked files under each MECHANICS path — a file
// outside these paths is never touched.
const pulled: string[] = []
const removed: string[] = []
for (const path of MECHANICS) {
  const upstream = new Set(
    git(`ls-tree -r --name-only ${REMOTE}/${BRANCH} -- ${path}`, { capture: true })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  )
  const local = git(`ls-files -- ${path}`, { capture: true })
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  if (tryGit(`checkout ${REMOTE}/${BRANCH} -- ${path}`))
    pulled.push(path)

  for (const file of local) {
    if (!upstream.has(file) && tryGit(`rm --quiet -- ${file}`))
      removed.push(file)
  }
}

if (pulled.length === 0 && removed.length === 0) {
  console.log('Nothing to pull — no mechanics paths found on the template.')
  process.exit(0)
}

console.log(`
Staged template mechanics: ${pulled.join(', ') || '(none)'}${removed.length ? `\nStaged deletions (retired upstream): ${removed.join(', ')}` : ''}

Review, then keep or discard:
  git diff --cached                                   # what changed
  git commit -m "chore: sync mechanics from template" # keep it all
  git restore --staged --worktree <path>              # discard one path
`)
