/**
 * `pnpm install` lifecycle hook: points git at the tracked hooks in `.githooks` (listed in
 * docs/template/guards.md, Hook bypass) by setting `core.hooksPath` in the repository's local
 * config. A tarball install and a CI checkout without .git skip it silently. The path stays
 * relative because git resolves it against the root of the working tree that runs the hook:
 * a linked worktree, which shares the local config, runs its own branch's hooks, and a local
 * value outranks a global one. Behaves the same on every platform, which a shell form in
 * package.json would not.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.git'))
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
