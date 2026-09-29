import { decisionsIndex, specIndex } from './scripts/docs/generators.mts'

// The template's pages carry no region: a list committed into a page conflicts whenever two
// branches each add an entry, so the sidebar and `pnpm docs:list` read the lists from the files.
// The generators stay registered so a page may opt in with their marker pair.
// automd has no --check mode; CI runs `pnpm docs:gen` then fails if `git status --porcelain`
// is non-empty (catches untracked outputs too), and `pnpm docs:check` compares any index
// region to its generator. The glob lets a marker anywhere under docs/ regenerate; automd's
// default ignore (`**/.*`, `**/dist`, `**/node_modules`) keeps .vitepress and .obsidian out.
// automd's block regex ignores fences, so a fenced `<!-- automd:x -->` example under docs/
// with both markers at line start would be executed: indent such an example.
export default {
  input: ['docs/**/*.md'],
  generators: { decisionsIndex, specIndex },
}
