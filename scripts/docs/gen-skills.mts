/**
 * Regenerates `.agents/skills/**` as an exact copy of `.claude/skills/**` (see skills.mts
 * for why a copy and not a symlink). Runs as part of `pnpm docs:gen`; the copies are
 * committed and marked generated, the CI drift gate catches a stale copy, and
 * `pnpm docs:check` refuses one that differs from its source. Never hand-edit the mirror.
 * Without a `.claude/skills` the mirror is removed and the run succeeds, so a repo that
 * dropped its skills keeps no stale copy.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './root.mts'
import { listFiles, SKILLS_SOURCE, SKILLS_TARGET } from './skills.mts'

const root = repoRoot()
const source = join(root, SKILLS_SOURCE)
const target = join(root, SKILLS_TARGET)
rmSync(target, { recursive: true, force: true })
if (existsSync(source)) {
  mkdirSync(target, { recursive: true })
  // Dereferenced so a symlinked skill directory mirrors as real files, the way listFiles
  // lists it; a copied symlink would break on Windows.
  cpSync(source, target, { recursive: true, dereference: true })
  console.log(`${SKILLS_TARGET} (${listFiles(target).length} files) mirrored from ${SKILLS_SOURCE}`)
}
else {
  console.log(`(${SKILLS_SOURCE}: not present, mirror removed)`)
}
