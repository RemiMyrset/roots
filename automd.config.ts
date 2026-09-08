import { decisionsIndex, specIndex } from './scripts/docs/generators.mts'

// automd has no --check mode; CI runs `pnpm docs:gen` then fails if `git status --porcelain`
// is non-empty (catches untracked outputs too), and `pnpm docs:check` compares the two index
// regions to the generators. The glob lets a marker anywhere under docs/ regenerate; automd's
// default ignore (`**/.*`, `**/dist`, `**/node_modules`) keeps .vitepress and .obsidian out.
// automd's block regex ignores fences, so a fenced `<!-- automd:x -->` example under docs/
// with both markers at line start would be executed: indent such an example.
export default {
  input: ['docs/**/*.md'],
  generators: { decisionsIndex, specIndex },
}
