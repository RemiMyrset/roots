/**
 * `pnpm install` lifecycle hook: installs the git hooks (listed in
 * docs/template/guards.md, Hook bypass) through simple-git-hooks when this is a git checkout
 * whose `.git` is a directory. A tarball install and a CI checkout without .git skip it
 * silently. A linked worktree (or a submodule), whose `.git` is a file, skips it with a note:
 * its hooks are the main checkout's, shared by every worktree, and simple-git-hooks would
 * fail there writing to `.git/hooks`. Behaves the same on every platform, which the shell
 * form `test -d .git && … || true` did not.
 */
import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

if (existsSync('.git')) {
  if (statSync('.git').isDirectory())
    execSync('simple-git-hooks', { stdio: 'inherit' })
  else
    console.log('prepare: git hooks not installed: .git is a file here, as in a linked worktree, whose hooks are the main checkout\'s (run pnpm install there).')
}
