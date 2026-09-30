/**
 * `pnpm lint:secrets`: secretlint over every tracked file, a force-added gitignored one
 * included, and every untracked file .gitignore does not exclude. secretlint 13 applies the
 * .gitignore cascade to globs and literal paths alike and exits 0 when that leaves nothing to
 * scan, so its every-file glob alone passes a force-added `.env`. Two passes, and the scan
 * fails when either does:
 *
 * - secretlint over the every-file glob, as before, which honours .gitignore, so a
 *   developer's real untracked `.env` stays unread.
 * - `secretlint --no-glob --no-gitignore` over the tracked files git's own ignore rules match
 *   (`git ls-files -c -i --exclude-standard`), in chunks that stay under the Windows
 *   command-line limit, spawned without a shell.
 *
 * Outside a git checkout, or without git, nothing is tracked and the second pass is skipped
 * with a note; any other git failure fails the scan, since a skip there would pass a tracked
 * secret. Runs from the cwd, the root under pnpm. Node builtins only.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Windows caps a command line at 32,767 characters; this leaves room for node, the secretlint
// path, and the quotes node adds around each path.
const ARG_BUDGET = 24_000

/** The secretlint CLI script, resolved from this file so it runs without a shell or a `.bin` shim. */
function secretlintBin(): string | undefined {
  try {
    const manifest = fileURLToPath(import.meta.resolve('secretlint/package.json'))
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | { secretlint?: string } }
    const script = typeof bin === 'string' ? bin : bin?.secretlint
    return script === undefined ? undefined : join(dirname(manifest), script)
  }
  catch {
    return undefined
  }
}

/** Runs secretlint with `args`; whether it passed. */
function secretlint(bin: string, args: string[]): boolean {
  const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
  if (r.error)
    console.error(`lint:secrets: could not run secretlint: ${r.error.message}`)
  return r.status === 0
}

/**
 * The tracked files that git's ignore rules match, as paths from the cwd, or why there are
 * none to read: `skip` when git is missing or this is no git checkout, `error` otherwise. Git
 * runs in the C locale so its "not a git repository" message matches in any language.
 */
function trackedIgnored(): { files: string[] } | { skip: string } | { error: string } {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error)
    return (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? { skip: 'git is not installed' } : { error: r.error.message }
  if (r.status === 0) {
    // A path deleted from the working tree, or a submodule, has no file to scan. A leading
    // `./` keeps a name that starts with `-` from reading as a flag.
    const files = r.stdout.split('\0').filter(p => p !== '' && statSync(p, { throwIfNoEntry: false })?.isFile())
    return { files: files.map(p => p.startsWith('-') ? `./${p}` : p) }
  }
  if (/\bnot a git repository\b/.test(r.stderr))
    return { skip: 'not a git checkout' }
  return { error: r.stderr.trim() || `git ls-files exited with ${r.status}` }
}

/** `files` in runs whose summed length stays under ARG_BUDGET. */
function chunks(files: string[]): string[][] {
  const out: string[][] = []
  let run: string[] = []
  let size = 0
  for (const file of files) {
    if (run.length > 0 && size + file.length + 3 > ARG_BUDGET) {
      out.push(run)
      run = []
      size = 0
    }
    run.push(file)
    size += file.length + 3
  }
  if (run.length > 0)
    out.push(run)
  return out
}

const bin = secretlintBin()
if (bin === undefined) {
  console.error('lint:secrets: secretlint is not installed; run pnpm install')
  process.exit(1)
}

let ok = secretlint(bin, ['**/*'])
const tracked = trackedIgnored()
if ('skip' in tracked) {
  console.log(`  (tracked gitignored files not scanned: ${tracked.skip})`)
}
else if ('error' in tracked) {
  console.error(`lint:secrets: git ls-files failed, so the tracked files .gitignore matches were not scanned:\n${tracked.error}`)
  ok = false
}
else {
  let trackedOk = true
  for (const run of chunks(tracked.files))
    trackedOk = secretlint(bin, ['--no-glob', '--no-gitignore', ...run]) && trackedOk
  if (!trackedOk) {
    console.error('lint:secrets: git tracks the files above although .gitignore matches them. Remove the secret and rotate it;')
    console.error('  untrack a file that must never be committed with `git rm --cached <path>`.')
    ok = false
  }
}
process.exit(ok ? 0 : 1)
