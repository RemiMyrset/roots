/**
 * `pnpm install` lifecycle hook: points git at the tracked hooks in `.githooks` (listed in
 * docs/template/guards.md, Hook bypass) by setting `core.hooksPath` in `githooks.config`, a file
 * in the git directory that the repository's config includes. A tarball install and a CI
 * checkout without .git skip it silently. Where git cannot set it (no git on PATH, as in a
 * container that copies .git, or a checkout another user owns, which git refuses), the install
 * goes on without hooks and says so.
 *
 * The path stays relative because git resolves it against the root of the working tree that
 * runs the hook: a linked worktree, which shares the config, runs its own branch's hooks, and a
 * local value outranks a global one. The include keeps the value out of `.git/config` itself,
 * the only place the simple-git-hooks of a branch from before `.githooks` reads it; finding it
 * there, that tool wrote its hooks into `.githooks` as untracked files, which then blocked the
 * switch back. Nothing is written once all is in place: every install that changes something
 * reruns this, in parallel when agents set up worktrees, and a rewrite of `.git/config` races
 * the git commands of the other worktrees.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const INCLUDE = 'githooks.config'
const SETTING = '[core]\n\thooksPath = .githooks\n'

/** Runs git; its exit status (null when git could not start), trimmed stdout, and what went wrong. */
function git(...args: string[]): { status: number | null, out: string, why: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  return { status: r.status, out: (r.stdout ?? '').trim(), why: `\`git ${args.join(' ')}\` failed: ${(r.error?.message ?? r.stderr ?? '').trim()}` }
}

/** Points git at .githooks, writing only what differs; why it could not, or undefined. */
function setHooksPath(): string | undefined {
  const common = git('rev-parse', '--git-common-dir')
  if (common.status !== 0)
    return common.why
  const file = join(resolve(common.out), INCLUDE)
  if (!existsSync(file) || readFileSync(file, 'utf8') !== SETTING)
    writeFileSync(file, SETTING)
  if (!git('config', '--local', '--get-all', 'include.path').out.split('\n').includes(INCLUDE)) {
    const add = git('config', '--local', '--add', 'include.path', INCLUDE)
    if (add.status !== 0)
      return add.why
  }
  // An earlier version of this script set the value in .git/config itself.
  if (git('config', '--local', '--get', 'core.hooksPath').out === '.githooks') {
    const unset = git('config', '--local', '--unset', 'core.hooksPath')
    if (unset.status !== 0)
      return unset.why
  }
  return undefined
}

if (existsSync('.git')) {
  let problem: string | undefined
  try {
    problem = setHooksPath()
  }
  catch (error) {
    problem = (error as Error).message
  }
  if (problem)
    console.log(`prepare: git hooks not set, so commits here skip them; ${problem}`)
}
