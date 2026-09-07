/**
 * Regenerates `.agents/skills/**` as an exact copy of `.claude/skills/**` (see skills.mts
 * for why a copy and not a symlink). Runs as part of `pnpm docs:gen`; the copies are
 * committed and marked generated, the CI drift gate catches a stale copy, and
 * `pnpm docs:check` refuses one that differs from its source. Never hand-edit the mirror.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './root.mts'
import { listFiles, SKILLS_SOURCE, SKILLS_TARGET } from './skills.mts'

const root = repoRoot()
const source = join(root, SKILLS_SOURCE)
const target = join(root, SKILLS_TARGET)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`${SKILLS_TARGET} (${listFiles(target).length} files) mirrored from ${SKILLS_SOURCE}`)
