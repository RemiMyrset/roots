/**
 * Repository-root discovery and the constants every docs script shares. Kept in its own
 * module with ZERO npm imports so the lint-only scripts (check-docs, check-portability) run
 * in a repo that has synced `scripts/docs` but not installed `automd` — the pre-commit hook
 * depends on that. generators.mts is the one file that imports automd.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** A decision record filename, NNNN-kebab-title.md — one definition so the checker and the generators agree. */
export const DECISION_FILE_RE = /^\d{4}-[a-z0-9-]+\.md$/
/** The Status metadata bullet of a decision record; group 1 is the raw value. */
export const STATUS_BULLET_RE = /^- \*\*Status:\*\*(.*)$/m
/** Directories no docs walk descends into: VCS, caches, build output, editor state. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', '.obsidian', '.turbo', '.vitepress', 'coverage', 'dist', 'node_modules'])
// Named key: tsc (noPropertyAccessFromIndexSignature) refuses dot access on process.env and
// eslint (dot-notation) refuses a literal in brackets; a const key satisfies both.
const CI_KEY = 'GITHUB_ACTIONS'
/** Warning-line prefix: a GitHub Actions annotation in CI, plain text everywhere else. */
export const WARN = process.env[CI_KEY] ? '::warning::' : 'warning: '

let cachedRoot: string | undefined

function findUp(marker: string): string | undefined {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, marker)))
      return dir
    const parent = dirname(dir)
    if (parent === dir)
      return undefined
    dir = parent
  }
}

function gitToplevel(): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || undefined
}

/**
 * The repository root, in this order: the nearest directory above cwd holding
 * automd.config.ts (the roots docs layout); else the git top level (a repo that synced
 * scripts/docs without the config); else the nearest package.json (no git either). Git
 * comes before package.json because inside a workspace package the nearest package.json
 * is the wrong root. Lazy + memoized so importing this module stays side-effect free.
 */
export function repoRoot(): string {
  if (cachedRoot)
    return cachedRoot
  const root = findUp('automd.config.ts') ?? gitToplevel() ?? findUp('package.json')
  if (!root)
    throw new Error('repo root not found: no automd.config.ts or package.json above cwd and not a git checkout — run from inside the repo')
  cachedRoot = root
  return root
}
