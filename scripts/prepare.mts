/**
 * `pnpm install` lifecycle hook: installs the git hooks (commitlint, lint-staged,
 * secretlint, docs:portability) through simple-git-hooks when this is a git checkout.
 * A tarball install, a CI checkout without .git, or a worktree whose .git is a file all
 * behave the same on every platform — the shell form `test -d .git && … || true` did not.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.git'))
  execSync('simple-git-hooks', { stdio: 'inherit' })
