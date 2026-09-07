/**
 * Repository-root discovery shared by every docs script. Kept in its own module with
 * ZERO npm imports so the lint-only scripts (check-docs, check-portability) run in a repo
 * that has synced `scripts/docs` but not installed `automd` — the pre-commit hook depends on
 * that. generators.mts is the one file that imports automd.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

let cachedRoot: string | undefined

/**
 * Walk up from cwd to the directory containing automd.config.ts — the one
 * guaranteed root marker: these docs scripts are synced (via sync:template) into
 * arbitrary repos that need not be pnpm workspaces, so a workspace file is not a
 * reliable marker. Lazy + memoized so importing this module stays side-effect free.
 */
export function repoRoot(): string {
  if (cachedRoot)
    return cachedRoot
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, 'automd.config.ts'))) {
      cachedRoot = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir)
      throw new Error('automd.config.ts not found walking up from cwd — run from inside the repo')
    dir = parent
  }
}
