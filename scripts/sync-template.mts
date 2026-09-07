/**
 * On-demand template update — no cron, no bot, no token, just git. Pulls the roots
 * mechanics (the shared CI workflows, labels, issue/PR templates, the docs generators
 * and checkers, the guard and sync test-suites, agent hooks/rules/skills, and the
 * template-owned docs under docs/template) from the template repo into this one.
 * Works from any repo, whether or not it was created from the template.
 *
 *   pnpm sync:template            # URL from .template-sync.json, else the default
 *   pnpm sync:template <git-url>  # or point at your own fork (recorded for next time)
 *
 * It stages the template's version of the mechanics paths; nothing is committed.
 * Review `git diff --cached`, keep what you want, discard the rest. Your app code
 * (package.json, src/, packages/, docs/internal, docs/public, .claude/settings.json)
 * is never touched — only the paths in MECHANICS below, minus `exclude` plus
 * `include` from .template-sync.json.
 *
 * After staging it prints what a file copy cannot carry: the template commits since
 * the last sync (breaking ones marked `!` with their BREAKING CHANGE paragraph) and
 * the package.json `scripts` that differ from the template's, as follow-ups to apply
 * by hand. The sync point (template URL + commit) is recorded in .template-sync.json
 * and staged with the rest, so the next run knows where to start.
 *
 * Contract and behavior branches: docs/template/sync-template.md. Regression suite:
 * scripts/test-sync.mts (`pnpm test:sync`). Node builtins only. This file is itself
 * synced, so never customize it in a child — use `exclude` / `include` instead.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const TEMPLATE_URL = 'https://github.com/RemiMyrset/roots.git'
const REMOTE = 'template'
const BRANCH = 'main'
const STATE_FILE = '.template-sync.json'
const SELF = 'scripts/sync-template.mts'
const LOG_CAP = 40

// Shared machinery worth keeping current across repos. Rarely customized, so a
// take-theirs-then-review is the right default. Never add package.json, src/,
// packages/, docs/internal, docs/public, or .claude/settings.json: those are yours.
// To pull the shared configs too (tsconfig.base.json, eslint.config.ts, turbo.json,
// automd.config.ts, .editorconfig), list them under `include` in .template-sync.json;
// to skip an entry, list it under `exclude`. Do not edit this list in a child — the
// file is synced, and the edit would be staged for revert on the next run.
const MECHANICS = [
  '.github/workflows/docs.yml',
  '.github/workflows/labels.yml',
  '.github/labels.yml',
  '.github/ISSUE_TEMPLATE',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/template',
  'scripts/docs',
  'scripts/sync-template.mts',
  'scripts/test-hooks.mts',
  'scripts/test-sync.mts',
  'scripts/verify.mts',
  '.claude/hooks',
  '.claude/rules',
  '.claude/skills',
]

// What the state file may hold before validation: declared (optional) properties, not an
// index signature, so field access satisfies both `noPropertyAccessFromIndexSignature` and
// the dot-notation lint rule.
interface RawState {
  url?: unknown
  commit?: unknown
  exclude?: unknown
  include?: unknown
}

interface StateFile {
  $comment: string
  url: string
  commit: string
  exclude?: string[]
  include?: string[]
}

/** The committed sync point: where the mechanics came from and which template commit they match. */
interface SyncState {
  url: string
  commit: string
  exclude?: string[]
  include?: string[]
}

// Plausible git URL / scp-form / local-path characters only. execFileSync passes argv
// without a shell, so this guards against junk and option injection, not shell metachars.
const URL_RE = /^[\w@:/.+~-]+$/
const SHA_RE = /^[0-9a-f]{40}$/
const BREAKING_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!:/
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tryGit(args: string[]): string | null {
  try {
    return git(args)
  }
  catch {
    return null
  }
}

function zList(out: string | null): string[] {
  return (out ?? '').split('\0').filter(Boolean)
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function readState(): { state?: SyncState, warning?: string } {
  if (!existsSync(STATE_FILE))
    return {}
  const bad = (why: string): { warning: string } => ({
    warning: `${STATE_FILE} is unreadable (${why}) — treating this as a first sync; it will be rewritten.`,
  })
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  }
  catch {
    return bad('not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null)
    return bad('not an object')
  const o = raw as RawState
  if (typeof o.url !== 'string' || !URL_RE.test(o.url))
    return bad('missing or invalid "url"')
  if (typeof o.commit !== 'string' || !SHA_RE.test(o.commit))
    return bad('missing or invalid "commit"')
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  const state: SyncState = { url: o.url, commit: o.commit }
  const exclude = list(o.exclude)
  if (exclude)
    state.exclude = exclude
  const include = list(o.include)
  if (include)
    state.include = include
  return { state }
}

function writeState(state: SyncState): void {
  const out: StateFile = {
    $comment: 'Written by scripts/sync-template.mts: the template URL and the last template commit synced into this repo. Commit it together with the sync. "exclude" (mechanics paths to skip) and "include" (extra paths to pull) are yours to edit.',
    url: state.url,
    commit: state.commit,
  }
  if (state.exclude)
    out.exclude = state.exclude
  if (state.include)
    out.include = state.include
  writeFileSync(STATE_FILE, `${JSON.stringify(out, null, 2)}\n`)
}

interface Commit {
  sha: string
  subject: string
  breaking: string[]
}

/** Template commits after `base`, oldest last, with the BREAKING CHANGE paragraph when present. */
function commitsSince(base: string): Commit[] {
  const raw = git(['log', '--format=%H%x00%s%x00%b%x1e', `${base}..${REMOTE}/${BRANCH}`])
  return raw
    .split('\x1E')
    .map(rec => rec.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', subject = '', body = ''] = rec.split('\0')
      const breaking: string[] = []
      const lines = body.replace(/\r/g, '').split('\n')
      const start = lines.findIndex(l => BREAKING_FOOTER_RE.test(l))
      if (start >= 0) {
        for (const l of lines.slice(start)) {
          if (l.trim() === '')
            break
          breaking.push(l)
        }
      }
      return { sha, subject: subject.replace(/\r$/, ''), breaking }
    })
}

function isBreaking(c: Commit): boolean {
  return c.breaking.length > 0 || BREAKING_SUBJECT_RE.test(c.subject)
}

type Scripts = Record<string, string>

/** The `scripts` block of a package.json text; `{}` when absent; undefined when the text is not JSON. */
function scriptsOf(json: string | null): Scripts | undefined {
  if (json === null)
    return undefined
  try {
    const parsed = JSON.parse(json) as { scripts?: unknown }
    const s = parsed.scripts
    if (typeof s !== 'object' || s === null)
      return {}
    return Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === 'string'))
  }
  catch {
    return undefined
  }
}

interface FollowUp {
  key: string
  kind: 'missing' | 'changed'
  template: string
  yours?: string
  note?: string
}

interface FollowUps {
  items: FollowUp[]
  customized: string[]
  skipped?: string
}

/**
 * Three-way compare of package.json scripts: the template now, the template at the last
 * sync (`base`, absent on a first sync or a lost baseline), and this repo. Only template
 * keys are compared, in template order, so a child's own scripts are never mentioned —
 * except to flag one that references a file this sync deletes.
 */
function scriptFollowUps(
  template: Scripts | undefined,
  base: Scripts | undefined,
  local: Scripts | undefined,
  localMissing: boolean,
  deleted: string[],
): FollowUps {
  if (localMissing)
    return { items: [], customized: [], skipped: 'no package.json here' }
  if (!template)
    return { items: [], customized: [], skipped: 'the template has no readable package.json' }
  if (!local)
    return { items: [], customized: [], skipped: 'package.json here is not valid JSON' }
  const items: FollowUp[] = []
  const customized: string[] = []
  const refersToDeleted = (value: string): string | undefined => deleted.find(d => value.includes(d))
  for (const [key, t] of Object.entries(template)) {
    const l = local[key]
    if (l === t)
      continue
    if (l === undefined) {
      if (base && base[key] !== undefined)
        customized.push(`${key} (absent here)`)
      else
        items.push({ key, kind: 'missing', template: t })
      continue
    }
    if (base && base[key] === t) {
      customized.push(key)
      continue
    }
    const item: FollowUp = { key, kind: 'changed', template: t, yours: l }
    const ref = refersToDeleted(l)
    if (ref)
      item.note = `yours references ${ref}, which this sync deletes`
    items.push(item)
  }
  for (const [key, l] of Object.entries(local)) {
    const ref = key in template ? undefined : refersToDeleted(l)
    if (ref)
      items.push({ key, kind: 'changed', template: '(not on the template)', yours: l, note: `yours references ${ref}, which this sync deletes` })
  }
  return { items, customized }
}

// ---------------------------------------------------------------------------------

const toplevel = tryGit(['rev-parse', '--show-toplevel'])
if (toplevel === null)
  fail('Not a git repository — run this from inside your project.')
process.chdir(toplevel.trim())

const { state, warning } = readState()
if (warning)
  console.error(`Warning: ${warning}`)

const urlArg = process.argv[2]
if (urlArg !== undefined && (!URL_RE.test(urlArg) || urlArg.startsWith('-')))
  fail(`Refusing suspicious template URL: ${urlArg}`)
const existingRemote = tryGit(['remote', 'get-url', REMOTE])?.trim()
const url = urlArg ?? state?.url ?? existingRemote ?? TEMPLATE_URL
if (existingRemote === undefined)
  git(['remote', 'add', '--no-tags', REMOTE, url])
else
  git(['remote', 'set-url', REMOTE, url])
// Never import the template's release tags: changelogen in the child would version from them.
git(['config', `remote.${REMOTE}.tagOpt`, '--no-tags'])

const exclude = new Set(state?.exclude ?? [])
const paths = [...MECHANICS.filter(p => !exclude.has(p)), ...(state?.include ?? []).filter(p => !MECHANICS.includes(p))]

// Refuse to clobber uncommitted work in the synced paths. The one exemption is this
// script itself, untracked or modified: a repo that predates it, or holds an older
// tracked copy, bootstraps by dropping a fresh copy in place and running it — and
// the checkout below replaces it with the template's version anyway.
const dirty: string[] = []
const statusEntries = zList(tryGit(['status', '--porcelain', '-z', '--', ...paths, STATE_FILE]))
for (let i = 0; i < statusEntries.length; i++) {
  const entry = statusEntries[i] ?? ''
  const xy = entry.slice(0, 2)
  const file = entry.slice(3)
  if (xy.startsWith('R') || xy.startsWith('C'))
    i++ // the following entry is the rename source
  if (file === SELF)
    continue
  dirty.push(entry)
}
if (dirty.length > 0)
  fail(`Uncommitted changes in template-managed paths — commit or stash first:\n\n${dirty.join('\n')}`)

if (tryGit(['fetch', '--no-tags', REMOTE, BRANCH]) === null)
  fail(`Could not fetch ${REMOTE}/${BRANCH} from ${url}. Check the URL (git remote -v) and your network.`)
const head = git(['rev-parse', `${REMOTE}/${BRANCH}`]).trim()

const base = state?.commit
const baseInHistory = base !== undefined && tryGit(['merge-base', '--is-ancestor', base, `${REMOTE}/${BRANCH}`]) !== null

// Take the template's version of every synced path it still ships, then stage removals
// for tracked files under those paths that the template retired. Files outside the
// synced paths are never touched.
const deleted: string[] = []
let pulled = 0
for (const path of paths) {
  const upstream = new Set(zList(tryGit(['ls-tree', '-r', '-z', '--name-only', `${REMOTE}/${BRANCH}`, '--', path])))
  if (upstream.size === 0)
    continue
  if (tryGit(['checkout', `${REMOTE}/${BRANCH}`, '--', path]) !== null)
    pulled++
  for (const file of zList(tryGit(['ls-files', '-z', '--', path]))) {
    if (!upstream.has(file) && tryGit(['rm', '--quiet', '--', file]) !== null)
      deleted.push(file)
  }
}
if (pulled === 0)
  fail(`Nothing to pull — none of the synced paths exist on ${REMOTE}/${BRANCH}. Is ${url} a roots template?`)

const followUps = scriptFollowUps(
  scriptsOf(tryGit(['show', `${REMOTE}/${BRANCH}:package.json`])),
  baseInHistory ? scriptsOf(tryGit(['show', `${base}:package.json`])) : undefined,
  existsSync('package.json') ? scriptsOf(readFileSync('package.json', 'utf8')) : undefined,
  !existsSync('package.json'),
  deleted,
)

const next: SyncState = { url, commit: head }
if (state?.exclude)
  next.exclude = state.exclude
if (state?.include)
  next.include = state.include
if (!state || state.url !== url || state.commit !== head || warning) {
  writeState(next)
  git(['add', '--', STATE_FILE])
}

// ---------------------------------------------------------------------------------
// Report. Stable tokens (M/A/D lines, `!` on breaking commits, the section headers)
// so the sync-template skill can parse it.

const out: string[] = [`Template: ${url}`]
if (base === undefined) {
  out.push(`Fetched ${REMOTE}/${BRANCH} at ${short(head)} — first sync, no previous sync point recorded.`)
  out.push(`Recorded it in ${STATE_FILE} (staged); the next run lists template commits since.`)
}
else if (!baseInHistory) {
  out.push(`Fetched ${REMOTE}/${BRANCH} at ${short(head)} — recorded sync point ${short(base)} is not in its history (template rebased or force-pushed, or the state file points at another fork). Skipping the commit list; the staged diff below is complete regardless.`)
}
else if (base === head) {
  out.push(`Fetched ${REMOTE}/${BRANCH} at ${short(head)} — unchanged since last sync.`)
}
else {
  const commits = commitsSince(base)
  out.push(`Fetched ${REMOTE}/${BRANCH} at ${short(head)} — ${commits.length} commit${commits.length === 1 ? '' : 's'} since last sync (${short(base)}):`)
  for (const c of commits.slice(0, LOG_CAP)) {
    out.push(`  ${isBreaking(c) ? '!' : ' '} ${short(c.sha)} ${c.subject}`)
    for (const line of c.breaking)
      out.push(`      ${line}`)
  }
  if (commits.length > LOG_CAP)
    out.push(`  … and ${commits.length - LOG_CAP} more`)
  out.push(`  Full log: git log ${short(base)}..${REMOTE}/${BRANCH}`)
}

const staged = zList(tryGit(['diff', '--cached', '--name-status', '-z', '--', ...paths, STATE_FILE]))
out.push('')
if (staged.length === 0) {
  out.push('Already up to date — nothing staged.')
}
else {
  out.push('Staged (review with git diff --cached):')
  for (let i = 0; i < staged.length; i += 2) {
    const status = (staged[i] ?? '').slice(0, 1)
    const file = staged[i + 1] ?? ''
    if (status === 'R' || status === 'C')
      i++ // rename: status, source, destination
    const note = file === SELF ? '   (this script — the new version runs next time)' : ''
    out.push(`  ${status}  ${file}${note}`)
  }
}

out.push('')
if (followUps.skipped) {
  out.push(`Follow-ups: skipped — ${followUps.skipped}.`)
}
else if (followUps.items.length === 0) {
  out.push('Follow-ups: none new.')
}
else {
  out.push('Follow-ups — package.json is yours, sync never edits it. Apply by hand where they apply:')
  for (const f of followUps.items) {
    const label = f.kind === 'missing' ? 'missing here' : baseInHistory ? 'changed on the template since last sync' : 'differs'
    out.push(`  scripts.${f.key}  ${label}`)
    out.push(`    template: ${f.template}`)
    if (f.yours !== undefined)
      out.push(`    yours:    ${f.yours}`)
    if (f.note)
      out.push(`    note: ${f.note}`)
  }
}
if (followUps.customized.length > 0)
  out.push(`  Customized locally (unchanged on the template since last sync): ${followUps.customized.map(k => `scripts.${k}`).join(', ')}`)

out.push('', 'Next:')
out.push('  git diff --cached                                    # review')
out.push('  git restore --staged --worktree <path>               # discard one path')
out.push('  git commit -m "chore: sync mechanics from template"  # keep')
console.log(out.join('\n'))
