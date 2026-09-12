/**
 * On-demand template update — no cron, no bot, no token, just git. Pulls the roots
 * mechanics (the paths in `MECHANICS` below) from the template repo into this one. Works
 * for a repo made with "Use this template" (no shared git history), a fork or clone
 * (shared history), or one that predates the template.
 *
 *   pnpm sync:template                # URL and ref from .template-sync.json, else the defaults
 *   pnpm sync:template <git-url>      # or point at your own fork (recorded for next time)
 *   pnpm sync:template --ref v0.1.0   # pin a template tag or branch (recorded for next time)
 *
 * It stages the template's version of the synced paths; nothing is committed.
 * Review `git diff --cached`, keep what you want, discard the rest. Nothing else is
 * touched — only the paths in `MECHANICS` below, minus `exclude` plus `include` from
 * .template-sync.json.
 *
 * After staging it prints what a file copy cannot carry: the template commits since
 * the last sync (breaking ones marked `!` with their BREAKING CHANGE paragraph), the
 * package.json `scripts` that differ from the template's, and the .claude/settings.json
 * allow and deny rules and hook command the template has and this repo lacks, as
 * follow-ups to apply by hand. A first sync infers where this repo branched off the template — shared
 * history, the root commit's tree, or the root commit's time — so the list starts
 * there. The sync point (template URL, ref, commit) is recorded in .template-sync.json
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
const DEFAULT_REF = 'main'
// Template tags land here, never under refs/tags/, so changelogen in this repo cannot
// version off the template's releases.
const TAG_NS = 'refs/template-tags'
const STATE_FILE = '.template-sync.json'
const SELF = 'scripts/sync-template.mts'
const LOG_CAP = 40

// Shared mechanics worth keeping current across repos. Rarely customized, so a
// take-theirs-then-review is the right default. The sync touches only the paths in
// this list; what stays a child's own is in docs/template/sync-template.md (Non-goals).
// To pull the shared configs too (tsconfig.base.json, eslint.config.ts, turbo.json,
// automd.config.ts, .editorconfig), list them under `include` in .template-sync.json;
// to skip an entry (say .gemini/settings.json once you have customized it), list it
// under `exclude`. Do not edit this list in a child — the file is synced, and the edit
// would be staged for revert on the next run.
const MECHANICS = [
  '.github/workflows/ci.yml',
  '.github/workflows/docs.yml',
  '.github/workflows/labels.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/labeler.yml',
  '.github/labels.yml',
  '.github/labeler.yml',
  '.github/ISSUE_TEMPLATE/agent-task.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'renovate.json',
  'docs/template',
  'scripts/docs',
  'scripts/prepare.mts',
  'scripts/sync-template.mts',
  'scripts/test-hooks.mts',
  'scripts/test-sync.mts',
  'scripts/test-docs.mts',
  'scripts/test-gates.mts',
  'scripts/verify.mts',
  '.claude/hooks',
  '.claude/rules',
  '.claude/output-styles',
  '.claude/skills',
  '.codex/hooks.json',
  '.gemini/settings.json',
  '.agents',
]

// What the state file may hold before validation: declared (optional) properties, not an
// index signature, so field access satisfies both `noPropertyAccessFromIndexSignature` and
// the dot-notation lint rule.
interface RawState {
  url?: unknown
  ref?: unknown
  commit?: unknown
  exclude?: unknown
  include?: unknown
}

interface StateFile {
  $comment: string
  url: string
  ref?: string
  commit: string
  exclude?: string[]
  include?: string[]
}

/** The committed sync point: where the mechanics came from, which ref is tracked, and which template commit they match. */
interface SyncState {
  url: string
  ref?: string
  commit: string
  exclude?: string[]
  include?: string[]
}

// Plausible git URL / scp-form / local-path characters only, percent-encoding included
// (pathToFileURL encodes a `~` in a Windows temp path as %7E). execFileSync passes argv
// without a shell, so this guards against junk and option injection, not shell metachars.
const URL_RE = /^[\w@:/.+~%-]+$/
const REF_RE = /^\w[\w./+-]*$/
const SHA_RE = /^[0-9a-f]{40}$/
const BREAKING_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!:/
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/

function isRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.includes('..')
}

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

/** Runs git and returns the failure reason (the first non-empty stderr line), or null on success. */
function gitError(args: string[]): string | null {
  try {
    git(args)
    return null
  }
  catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' ? stderr : ''
    return text.split('\n').map(l => l.trim()).find(Boolean) ?? `git ${args[0] ?? ''} failed`
  }
}

function zList(out: string | null): string[] {
  return (out ?? '').split('\0').filter(Boolean)
}

function lines(out: string | null): string[] {
  return (out ?? '').split('\n').map(l => l.trim()).filter(Boolean)
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(1)
}

interface Args {
  url?: string
  ref?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--ref' || t.startsWith('--ref=')) {
      const value = t === '--ref' ? argv[++i] : t.slice('--ref='.length)
      if (value === undefined || !isRef(value))
        fail(`Refusing suspicious ref: ${value ?? '(missing)'}`)
      args.ref = value
      continue
    }
    if (t.startsWith('-'))
      fail(`Unknown option: ${t}`)
    if (args.url !== undefined)
      fail(`Unexpected argument: ${t}`)
    if (!URL_RE.test(t))
      fail(`Refusing suspicious template URL: ${t}`)
    args.url = t
  }
  return args
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
  if (o.ref !== undefined && (typeof o.ref !== 'string' || !isRef(o.ref)))
    return bad('invalid "ref"')
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  const state: SyncState = { url: o.url, commit: o.commit }
  if (typeof o.ref === 'string')
    state.ref = o.ref
  const exclude = list(o.exclude)
  if (exclude)
    state.exclude = exclude
  const include = list(o.include)
  if (include)
    state.include = include
  return { state }
}

function writeState(state: SyncState): void {
  // Field order in the file: url, ref, commit, exclude, include.
  const out: StateFile = {
    $comment: 'Written by scripts/sync-template.mts: the template URL, the branch or tag it tracks ("ref", absent means main), and the last template commit synced into this repo. Commit it together with the sync. "exclude" (synced paths to skip) and "include" (extra paths to pull) are yours to edit.',
    url: state.url,
    ...(state.ref !== undefined ? { ref: state.ref } : {}),
    commit: state.commit,
    ...(state.exclude ? { exclude: state.exclude } : {}),
    ...(state.include ? { include: state.include } : {}),
  }
  writeFileSync(STATE_FILE, `${JSON.stringify(out, null, 2)}\n`)
}

/** The host and path of a git URL (https, ssh, scp-form) or a local path, for comparing remotes. */
function hostPath(url: string): string {
  return url.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()
}

interface Fetched {
  head: string
  kind: 'branch' | 'tag'
}

/** Fetches `ref` as a branch first, then as a tag (into the private tag namespace); null when neither exists. */
function fetchRef(ref: string): Fetched | null {
  if (tryGit(['fetch', '--no-tags', REMOTE, `+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]) !== null) {
    const sha = tryGit(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${ref}^{commit}`])?.trim()
    if (sha)
      return { head: sha, kind: 'branch' }
  }
  if (tryGit(['fetch', '--no-tags', REMOTE, `+refs/tags/${ref}:${TAG_NS}/${ref}`]) !== null) {
    const sha = tryGit(['rev-parse', '-q', '--verify', `${TAG_NS}/${ref}^{commit}`])?.trim()
    if (sha)
      return { head: sha, kind: 'tag' }
  }
  return null
}

interface Baseline {
  commit: string
  how: 'shared history' | 'root tree' | 'root time'
  note: string
}

/**
 * Where this repo branched off the template, for a first sync with nothing recorded:
 * a merge-base when history is shared (fork, clone); else the template commit whose tree
 * the root commit carries verbatim (GitHub's "Use this template" copies the tree as one
 * commit); else the template commit at the root commit's time, accepted only when at
 * least one synced path is identical between the two (approximate, and says so).
 */
function inferBaseline(head: string, label: string, paths: string[]): Baseline | undefined {
  const mergeBase = tryGit(['merge-base', 'HEAD', head])?.trim()
  if (mergeBase)
    return { commit: mergeBase, how: 'shared history', note: `git merge-base HEAD ${label}` }
  const rootCommits = lines(tryGit(['rev-list', '--max-parents=0', 'HEAD']))
  if (rootCommits.length === 0)
    return undefined
  const ancestry = lines(tryGit(['log', '--format=%H %T', head]))
  for (const root of rootCommits) {
    const tree = tryGit(['rev-parse', `${root}^{tree}`])?.trim()
    if (!tree)
      continue
    const hit = ancestry.find(l => l.endsWith(` ${tree}`))
    if (hit)
      return { commit: hit.split(' ')[0]!, how: 'root tree', note: 'the root commit carries this template commit\'s tree (a "Use this template" copy)' }
  }
  for (const root of rootCommits) {
    const when = tryGit(['show', '-s', '--format=%cI', root])?.trim()
    if (!when)
      continue
    const candidate = tryGit(['rev-list', '-1', `--before=${when}`, head])?.trim()
    if (!candidate)
      continue
    const same = paths.filter((p) => {
      const ids = lines(tryGit(['rev-parse', `${root}:${p}`, `${candidate}:${p}`]))
      return ids.length === 2 && ids[0] === ids[1]
    })
    if (same.length > 0)
      return { commit: candidate, how: 'root time', note: `root commit ${when}; ${same.length} of ${paths.length} synced paths identical — approximate, verify with git log ${short(candidate)}..${short(head)}` }
  }
  return undefined
}

interface Commit {
  sha: string
  subject: string
  breaking: string[]
}

/** Template commits after `base` up to `head`, newest first, with the BREAKING CHANGE paragraph when present. */
function commitsSince(base: string, head: string): Commit[] {
  const raw = git(['log', '--format=%H%x00%s%x00%b%x1e', `${base}..${head}`])
  return raw
    .split('\x1E')
    .map(rec => rec.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', subject = '', body = ''] = rec.split('\0')
      const breaking: string[] = []
      const bodyLines = body.replace(/\r/g, '').split('\n')
      const start = bodyLines.findIndex(l => BREAKING_FOOTER_RE.test(l))
      if (start >= 0) {
        for (const l of bodyLines.slice(start)) {
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
 * Three-way compare of package.json scripts: the template now, the template at the
 * baseline (`base`, absent when no baseline is known), and this repo. Only template keys
 * are compared, in template order, so a child's own scripts are never mentioned — except
 * to flag one that references a file this sync deletes.
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

/** The parts of a Claude Code settings file a template ships and a child must carry by hand. */
interface SettingsShape {
  allow: string[]
  deny: string[]
  hook?: string
}

/** The allow and deny rules and the first PreToolUse hook command of a settings.json text; undefined when it is not JSON. */
function settingsOf(json: string | null): SettingsShape | undefined {
  if (json === null)
    return undefined
  try {
    const parsed = JSON.parse(json) as { permissions?: { allow?: unknown, deny?: unknown }, hooks?: { PreToolUse?: { hooks?: { command?: unknown }[] }[] } }
    const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
    const hook = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
    return { allow: list(parsed.permissions?.allow), deny: list(parsed.permissions?.deny), ...(typeof hook === 'string' ? { hook } : {}) }
  }
  catch {
    return undefined
  }
}

interface SettingsFollowUps {
  missing: string[]
  hook?: { template: string, yours?: string }
  skipped?: string
}

/**
 * Two-way compare of .claude/settings.json, which is never synced: template allow and deny
 * rules absent here, and a PreToolUse hook command that differs. A child's own rules are
 * never mentioned, and the file is never edited.
 */
function settingsFollowUps(template: SettingsShape | undefined, local: SettingsShape | undefined, localMissing: boolean): SettingsFollowUps {
  if (localMissing)
    return { missing: [], skipped: 'no .claude/settings.json here' }
  if (!template)
    return { missing: [], skipped: 'the template has no readable .claude/settings.json' }
  if (!local)
    return { missing: [], skipped: '.claude/settings.json here is not valid JSON' }
  const missing = [
    ...template.allow.filter(r => !local.allow.includes(r)).map(r => `permissions.allow ${r}`),
    ...template.deny.filter(r => !local.deny.includes(r)).map(r => `permissions.deny ${r}`),
  ]
  const hook = template.hook !== undefined && template.hook !== local.hook ? { template: template.hook, ...(local.hook !== undefined ? { yours: local.hook } : {}) } : undefined
  return { missing, ...(hook ? { hook } : {}) }
}

// ---------------------------------------------------------------------------------

const toplevel = tryGit(['rev-parse', '--show-toplevel'])
if (toplevel === null)
  fail('Not a git repository — run this from inside your project.')
process.chdir(toplevel.trim())

const { state, warning } = readState()
if (warning)
  console.error(`Warning: ${warning}`)

const args = parseArgs(process.argv.slice(2))
const existingRemote = tryGit(['remote', 'get-url', REMOTE])?.trim()
const url = args.url ?? state?.url ?? existingRemote ?? TEMPLATE_URL
const ref = args.ref ?? state?.ref ?? DEFAULT_REF

// The template must never sync from itself: it would stage a state file and report a
// clean no-op that is easy to commit by mistake.
const origin = tryGit(['remote', 'get-url', 'origin'])
if (origin !== null && hostPath(origin) === hostPath(url))
  fail(`This checkout is the template itself (origin is ${url}) — run the sync in a repository made from it.`)

const exclude = new Set(state?.exclude ?? [])
const paths = [...MECHANICS.filter(p => !exclude.has(p)), ...(state?.include ?? []).filter(p => !MECHANICS.includes(p))]

// Refuse to clobber uncommitted work in the synced paths. Two exemptions: this script
// itself, untracked or modified (a repo that predates it, or holds an older tracked copy,
// bootstraps by dropping a fresh copy in place and running it, and the checkout below
// replaces it with the template's version anyway), and the state file when it is staged
// and otherwise clean, which is what a previous run left behind; a second run before the
// commit must not refuse its own work.
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
  if (file === STATE_FILE && xy[1] === ' ')
    continue
  dirty.push(entry)
}
if (dirty.length > 0)
  fail(`Uncommitted changes in template-managed paths — commit or stash first (a previous sync's staged files count too: commit them, or discard with git restore --staged --worktree <path>):\n\n${dirty.join('\n')}`)

if (existingRemote === undefined)
  git(['remote', 'add', '--no-tags', REMOTE, url])
else
  git(['remote', 'set-url', REMOTE, url])
// Never import the template's release tags into refs/tags: changelogen in this repo
// would version from them. Pinned tags are fetched into TAG_NS instead.
git(['config', `remote.${REMOTE}.tagOpt`, '--no-tags'])

const fetched = fetchRef(ref)
if (fetched === null)
  fail(`Could not fetch ${ref} (as a branch or a tag) from ${url}. Check the URL (git remote -v), the ref, and your network.`)
const { head, kind } = fetched
const label = kind === 'tag' ? `${REMOTE}/${ref} (tag)` : `${REMOTE}/${ref}`

const recorded = state?.commit
const baseline = recorded === undefined ? inferBaseline(head, label, paths) : undefined
const base = baseline?.commit ?? recorded
const baseInHistory = baseline !== undefined || (recorded !== undefined && tryGit(['merge-base', '--is-ancestor', recorded, head]) !== null)
const behind = recorded !== undefined && !baseInHistory && tryGit(['merge-base', '--is-ancestor', head, recorded]) !== null
const since = recorded === undefined ? 'the baseline' : 'last sync'

// Take the template's version of every synced path it still ships, then stage removals
// for tracked files under those paths that the template retired — a file inside a path
// or a whole path. Files outside the synced paths are never touched. A path whose
// checkout fails is reported, not hidden. The template's trees are read first so an
// unrelated repository (nothing to pull) is refused before anything is staged.
const upstreamByPath = new Map(paths.map(path => [path, new Set(zList(tryGit(['ls-tree', '-r', '-z', '--name-only', head, '--', path])))] as const))
if ([...upstreamByPath.values()].every(files => files.size === 0))
  fail(`Nothing to pull — none of the synced paths exist on ${label}. Is ${url} a roots template?`)
const deleted: string[] = []
const skipped: string[] = []
let pulled = 0
for (const [path, upstream] of upstreamByPath) {
  if (upstream.size > 0) {
    const why = gitError(['checkout', head, '--', path])
    if (why === null)
      pulled++
    else
      skipped.push(`${path}  ${why}`)
  }
  for (const file of zList(tryGit(['ls-files', '-z', '--', path]))) {
    if (!upstream.has(file) && tryGit(['rm', '--quiet', '--', file]) !== null)
      deleted.push(file)
  }
}
if (pulled === 0)
  fail(`Could not check out any synced path:\n\n${skipped.join('\n')}`)

const followUps = scriptFollowUps(
  scriptsOf(tryGit(['show', `${head}:package.json`])),
  base !== undefined && baseInHistory ? scriptsOf(tryGit(['show', `${base}:package.json`])) : undefined,
  existsSync('package.json') ? scriptsOf(readFileSync('package.json', 'utf8')) : undefined,
  !existsSync('package.json'),
  deleted,
)

const SETTINGS = '.claude/settings.json'
const settings = settingsFollowUps(
  settingsOf(tryGit(['show', `${head}:${SETTINGS}`])),
  existsSync(SETTINGS) ? settingsOf(readFileSync(SETTINGS, 'utf8')) : undefined,
  !existsSync(SETTINGS),
)

const next: SyncState = { url, commit: head }
if (ref !== DEFAULT_REF)
  next.ref = ref
if (state?.exclude)
  next.exclude = state.exclude
if (state?.include)
  next.include = state.include
if (!state || state.url !== url || state.commit !== head || (state.ref ?? DEFAULT_REF) !== ref || warning) {
  writeState(next)
  git(['add', '--', STATE_FILE])
}

// ---------------------------------------------------------------------------------
// Report. Stable tokens (the `Baseline:` line and its mode, M/A/D lines, `!` on breaking
// commits, the section headers) so the sync-template skill can parse it.

const out: string[] = [`Template: ${url}`]
const fetchedAt = `Fetched ${label} at ${short(head)}`
function listCommits(from: string): void {
  const commits = commitsSince(from, head)
  const count = `${commits.length} commit${commits.length === 1 ? '' : 's'} since ${since} (${short(from)}):`
  if (recorded === undefined)
    out.push(count)
  else
    out.push(`${fetchedAt} — ${count}`)
  for (const c of commits.slice(0, LOG_CAP)) {
    out.push(`  ${isBreaking(c) ? '!' : ' '} ${short(c.sha)} ${c.subject}`)
    for (const line of c.breaking)
      out.push(`      ${line}`)
  }
  if (commits.length > LOG_CAP)
    out.push(`  … and ${commits.length - LOG_CAP} more`)
  out.push(`  Full log: git log ${short(from)}..${short(head)}`)
}
if (recorded === undefined) {
  out.push(`${fetchedAt} — first sync, no previous sync point recorded.`)
  if (baseline === undefined) {
    out.push(`Baseline: none — no shared history and the root commit matches no template commit; recorded ${short(head)} in ${STATE_FILE} (staged); the next run lists template commits since.`)
  }
  else {
    out.push(`Baseline: ${short(baseline.commit)} (${baseline.how}) — ${baseline.note}.`)
    if (baseline.commit === head)
      out.push('No template commits since the baseline.')
    else
      listCommits(baseline.commit)
  }
}
else if (behind) {
  out.push(`${fetchedAt} — recorded sync point ${short(recorded)} is ahead of it; syncing back to an older ref. Skipping the commit list; the staged diff below is complete regardless.`)
}
else if (!baseInHistory) {
  out.push(`${fetchedAt} — recorded sync point ${short(recorded)} is not in its history (template rebased or force-pushed, or the state file points at another fork). Skipping the commit list; the staged diff below is complete regardless.`)
}
else if (recorded === head) {
  out.push(`${fetchedAt} — unchanged since last sync.`)
}
else {
  listCommits(recorded)
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
    if (status === 'R' || status === 'C')
      i++ // rename: status, source, destination; report the destination
    const file = staged[i + 1] ?? ''
    const note = file === SELF ? '   (this script — the new version runs next time)' : ''
    out.push(`  ${status}  ${file}${note}`)
  }
}
if (skipped.length > 0) {
  out.push('Skipped (git checkout failed — fix and re-run):')
  for (const s of skipped)
    out.push(`  ${s}`)
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
    const tag = f.kind === 'missing' ? 'missing here' : baseInHistory ? `changed on the template since ${since}` : 'differs'
    out.push(`  scripts.${f.key}  ${tag}`)
    out.push(`    template: ${f.template}`)
    if (f.yours !== undefined)
      out.push(`    yours:    ${f.yours}`)
    if (f.note)
      out.push(`    note: ${f.note}`)
  }
}
if (followUps.customized.length > 0)
  out.push(`  Customized locally (unchanged on the template since ${since}): ${followUps.customized.map(k => `scripts.${k}`).join(', ')}`)

out.push('')
if (settings.skipped) {
  out.push(`Settings: skipped — ${settings.skipped}.`)
}
else if (settings.missing.length === 0 && !settings.hook) {
  out.push('Settings: none new.')
}
else {
  out.push(`Settings — ${SETTINGS} is yours, sync never edits it. Apply by hand where they apply:`)
  for (const m of settings.missing)
    out.push(`  ${m}  missing here`)
  if (settings.hook) {
    out.push('  hooks.PreToolUse command  differs')
    out.push(`    template: ${settings.hook.template}`)
    if (settings.hook.yours !== undefined)
      out.push(`    yours:    ${settings.hook.yours}`)
  }
}

if (staged.length > 0) {
  out.push('', 'Next:')
  out.push('  git diff --cached                                    # review')
  out.push('  git restore --staged --worktree <path>               # discard one path')
  out.push('  git commit -m "chore: sync mechanics from template"  # keep')
}
console.log(out.join('\n'))
