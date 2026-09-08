/**
 * The agent-skills mirror: `.claude/skills/**` (what Claude Code reads) is copied byte for
 * byte to `.agents/skills/**` (the Agent Skills convention directory Codex and Gemini CLI
 * read). A copy rather than a symlink because a symlink needs privileges on Windows and
 * silently becomes a text file without them. ZERO npm imports: gen-skills.mts runs inside
 * `pnpm docs:gen` and check-docs.mts refuses drift, both in repos that synced scripts/docs
 * but never installed the docs toolchain.
 */
import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { byCodeUnit } from './root.mts'

/** Source of truth for skills; edit these. */
export const SKILLS_SOURCE = '.claude/skills'
/** Generated mirror; never hand-edit — `pnpm docs:gen` rewrites it. */
export const SKILLS_TARGET = '.agents/skills'

/**
 * Every file under `dir`, as forward-slash paths relative to it, sorted; empty when `dir`
 * is absent. A symlink counts as what it points at, so a linked skill directory lists,
 * mirrors, and compares like a real one.
 */
export function listFiles(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
    const abs = join(dir, entry.name)
    const isDirectory = entry.isSymbolicLink() ? statSync(abs).isDirectory() : entry.isDirectory()
    if (isDirectory)
      out.push(...listFiles(abs).map(f => `${entry.name}/${f}`))
    else
      out.push(entry.name)
  }
  return out
}

/**
 * Files whose mirror is missing, different, or stale: `missing` and `different` are paths
 * under the source, `stale` are paths under the target with no source. All empty means the
 * mirror is current.
 */
export function skillDrift(root: string): { missing: string[], different: string[], stale: string[] } {
  const source = join(root, SKILLS_SOURCE)
  const target = join(root, SKILLS_TARGET)
  const sourceFiles = listFiles(source)
  const targetFiles = new Set(listFiles(target))
  const missing: string[] = []
  const different: string[] = []
  for (const f of sourceFiles) {
    if (!targetFiles.has(f)) {
      missing.push(f)
      continue
    }
    if (!readFileSync(join(source, f)).equals(readFileSync(join(target, f))))
      different.push(f)
  }
  const stale = [...targetFiles].filter(f => !sourceFiles.includes(f))
  return { missing, different, stale }
}

/** Repo-relative forward-slash path, whatever the platform separator. */
export function posixRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}
