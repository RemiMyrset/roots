import { decisionsIndex, specIndex } from './scripts/docs/generators.mts'

// automd has no --check mode; CI runs `pnpm docs:gen` then fails if
// `git status --porcelain` is non-empty (catches untracked outputs too).
export default {
  input: [
    'docs/internal/decisions/index.md',
    'docs/internal/specs/index.md',
  ],
  generators: { decisionsIndex, specIndex },
}
