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
 * After staging it prints what a file copy cannot carry, as follow-ups to apply by hand: the
 * template commits since the last sync (breaking ones marked `!` with their BREAKING CHANGE
 * paragraph); the package.json entries and the pnpm-workspace.yaml settings the synced gates
 * rely on that differ from the template's (packageManager, scripts, devDependencies, the
 * commit checks, engines; catalog, allowBuilds, trustPolicyExclude, and the rest); the
 * files the template added outside the synced paths; and the .claude/settings.json allow and
 * deny rules, hook registrations, and output style the template has and this repo lacks. A
 * first sync infers where this repo branched off the template — shared history, the root
 * commit's tree, or the root commit's time — so the list starts there. The sync point
 * (template URL, ref, commit) is recorded in .template-sync.json with this repo's own URL and
 * staged with the rest, so the next run knows where to start, and a repo made from this one
 * knows the file is not its own.
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
  repo?: unknown
  exclude?: unknown
  include?: unknown
}

interface StateFile {
  $comment: string
  url: string
  ref?: string
  commit: string
  repo?: string
  exclude?: string[]
  include?: string[]
}

/**
 * The committed sync point: where the mechanics came from, which ref is tracked, and which
 * template commit they match, with the URL of the repository that wrote it (`repo`). Only
 * `commit` and `repo` are written by the sync alone; a file without `commit` is a
 * configuration written before the first sync.
 */
interface SyncState {
  url?: string
  ref?: string
  commit?: string
  repo?: string
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

// Every path argument is a literal path, never a glob or pathspec magic: `git rm -- x[1].md`
// would otherwise also delete x1.md, and `ls-files -- '*.config.ts'` matches at any depth.
const GIT_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * Every version (blob id) of every file under `paths` in the history of `revs`, by file. Both
 * sides of each change count and a merge is diffed against each parent, so a version that only a
 * merge wrote counts too.
 */
function versionsAt(revs: string[], paths: string[]): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  if (paths.length === 0)
    return versions
  const parts = zList(tryGit(['log', '--format=', '--raw', '-z', '--no-abbrev', '--no-renames', '--full-history', '-m', ...revs, '--', ...paths]))
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i] ?? ''
    if (!meta.startsWith(':'))
      continue
    const file = parts[++i] ?? ''
    const [, , from = '', to = ''] = meta.split(' ')
    let set = versions.get(file)
    if (!set) {
      set = new Set()
      versions.set(file, set)
    }
    for (const blob of [from, to]) {
      if (/^[0-9a-f]+$/.test(blob) && !/^0+$/.test(blob))
        set.add(blob)
    }
  }
  return versions
}

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** JSON.parse that ignores a leading byte-order mark, which some Windows editors write. */
function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text) as unknown
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

/** Why a state-file path entry is refused, or undefined for a literal repo-relative path. */
function badEntry(entry: string): string | undefined {
  if (entry === '')
    return 'it is empty'
  if (entry.startsWith('/') || entry.includes('\\') || /^[a-z]:/i.test(entry))
    return 'it is not a repo-relative path with forward slashes'
  if (entry.startsWith(':'))
    return 'pathspec magic is not supported'
  if (/[*?]/.test(entry))
    return 'entries are literal paths, not globs'
  if (entry.replace(/\/+$/, '').split('/').some(s => s === '' || s === '.' || s === '..'))
    return 'it has an empty, "." or ".." segment'
  return undefined
}

function invalidState(why: string): never {
  fail(`${STATE_FILE} is invalid: ${why}. Fix it and re-run; nothing was fetched or staged.`)
}

/**
 * The state file, validated field by field. A missing file, or one without `commit`, is a
 * first sync; an invalid `commit` alone is a first sync with a warning. Anything else that
 * fails validation stops the run before anything is fetched or staged, because dropping the
 * field would silently switch the template URL or ref, or overwrite an excluded path.
 */
function readState(): { state?: SyncState, warnings: string[] } {
  if (!existsSync(STATE_FILE))
    return { warnings: [] }
  let raw: unknown
  try {
    raw = parseJson(readFileSync(STATE_FILE, 'utf8'))
  }
  catch (err) {
    invalidState(`not valid JSON (${(err as Error).message})`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalidState('not a JSON object')
  const o = raw as RawState
  const state: SyncState = {}
  const warnings: string[] = []
  for (const key of ['url', 'repo'] as const) {
    const v = o[key]
    if (v === undefined)
      continue
    if (typeof v !== 'string' || !URL_RE.test(v))
      invalidState(`"${key}" must be a git URL or path matching ${String(URL_RE)}`)
    state[key] = v
  }
  if (o.ref !== undefined) {
    if (typeof o.ref !== 'string' || !isRef(o.ref))
      invalidState(`"ref" must be a branch or tag name matching ${String(REF_RE)}`)
    state.ref = o.ref
  }
  if (o.commit !== undefined) {
    if (typeof o.commit === 'string' && SHA_RE.test(o.commit))
      state.commit = o.commit
    else
      warnings.push(`${STATE_FILE} has an invalid "commit" (not 40 hex characters) — treating this as a first sync; it will be rewritten.`)
  }
  for (const key of ['exclude', 'include'] as const) {
    const v = o[key]
    if (v === undefined)
      continue
    if (!Array.isArray(v) || !v.every((e): e is string => typeof e === 'string'))
      invalidState(`"${key}" must be an array of path strings`)
    for (const e of v) {
      const why = badEntry(e)
      if (why)
        invalidState(`"${key}" entry ${JSON.stringify(e)} is refused: ${why}`)
    }
    state[key] = v.map(e => e.replace(/\/+$/, ''))
  }
  for (const e of state.exclude ?? []) {
    if (!MECHANICS.includes(e))
      warnings.push(`${STATE_FILE} "exclude" entry ${JSON.stringify(e)} matches no synced path, so nothing is excluded by it; an entry must equal a whole entry of MECHANICS in ${SELF}.`)
  }
  return { state, warnings }
}

function writeState(state: SyncState & { url: string, commit: string }): void {
  // Field order in the file: url, ref, commit, repo, exclude, include.
  const out: StateFile = {
    $comment: 'Written by scripts/sync-template.mts: the template URL, the branch or tag it tracks ("ref", absent means main), the last template commit synced into this repo, and this repo\'s own URL ("repo"), which tells a repo made from this one that the file came with it. Commit it together with the sync. "exclude" (synced paths to skip) and "include" (extra paths to pull) are yours to edit.',
    url: state.url,
    ...(state.ref !== undefined ? { ref: state.ref } : {}),
    commit: state.commit,
    ...(state.repo !== undefined ? { repo: state.repo } : {}),
    ...(state.exclude ? { exclude: state.exclude } : {}),
    ...(state.include ? { include: state.include } : {}),
  }
  writeFileSync(STATE_FILE, `${JSON.stringify(out, null, 2)}\n`)
}

/** The host and path of a git URL (https, ssh, scp-form) or a local path, for comparing remotes. */
function hostPath(url: string): string {
  return url.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()
}

/** This repository's URL to record as `repo`: the origin, an http(s) user and token dropped; undefined without an origin or when it fails URL_RE. */
function ownUrl(origin: string | undefined): string | undefined {
  const url = origin?.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
  return url !== undefined && URL_RE.test(url) ? url : undefined
}

/**
 * Whether the state file is another repository's that came with this one: "Use this template"
 * on a repository that syncs, such as an organization's fork of roots, copies its state file
 * into the new repository's first commit. That is the case when the file records a sync point,
 * only a root commit wrote it, it has no change here, and the writer it names (`repo`) is not
 * this repository's origin, or it names none. A clone or fork of this repository carries the
 * commits that wrote the file, and a history squashed into one commit names its own origin. A
 * shallow clone never counts: its oldest commits have their parents cut off, so the one that
 * wrote the file there can look like a root commit without being one.
 */
function inherited(state: SyncState, origin: string | undefined): boolean {
  if (state.commit === undefined)
    return false
  if (state.repo !== undefined && origin !== undefined && hostPath(state.repo) === hostPath(origin))
    return false
  if (tryGit(['status', '--porcelain', '--', STATE_FILE]) !== '')
    return false
  if (tryGit(['rev-parse', '--is-shallow-repository'])?.trim() === 'true')
    return false
  // Two at most: a second writer settles it, so a long history is not walked to its root.
  const writers = lines(tryGit(['rev-list', '--max-count=2', 'HEAD', '--', STATE_FILE]))
  return writers.length === 1 && tryGit(['rev-parse', '-q', '--verify', `${writers[0]}^`]) === null
}

interface Fetched {
  head: string
  kind: 'branch' | 'tag'
}

/** Fetches `ref` as a branch first, then as a tag (into the private tag namespace); when neither exists, git's reason for the branch attempt. */
function fetchRef(ref: string): Fetched | { error: string } {
  const branchError = gitError(['fetch', '--no-tags', REMOTE, `+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`])
  if (branchError === null) {
    const sha = tryGit(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${ref}^{commit}`])?.trim()
    if (sha)
      return { head: sha, kind: 'branch' }
  }
  if (gitError(['fetch', '--no-tags', REMOTE, `+refs/tags/${ref}:${TAG_NS}/${ref}`]) === null) {
    const sha = tryGit(['rev-parse', '-q', '--verify', `${TAG_NS}/${ref}^{commit}`])?.trim()
    if (sha)
      return { head: sha, kind: 'tag' }
  }
  return { error: branchError ?? `refs/heads/${ref} is not a commit` }
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
  merge: boolean
}

/** Template commits after `base` up to `head`, newest first, merges flagged, with the BREAKING CHANGE paragraph when present. */
function commitsSince(base: string, head: string): Commit[] {
  const raw = git(['log', '--format=%H%x00%P%x00%s%x00%b%x1e', `${base}..${head}`])
  return raw
    .split('\x1E')
    .map(rec => rec.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', parents = '', subject = '', body = ''] = rec.split('\0')
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
      return { sha, subject: subject.replace(/\r$/, ''), breaking, merge: parents.trim().split(' ').length > 1 }
    })
}

function isBreaking(c: Commit): boolean {
  return c.breaking.length > 0 || BREAKING_SUBJECT_RE.test(c.subject)
}

/** One flat block of a config file, key to value; a value that is not a string is its JSON text. */
type Entries = Record<string, string>

// The package.json blocks a synced gate relies on, compared key by key: the scripts the done
// gate and the workflows run, the devDependencies behind them, the commit-time checks and the
// commit message rules, and the node range. `packageManager`, the pnpm the workflows install,
// is compared as a top-level field (block '').
const MANIFEST_BLOCKS = ['scripts', 'devDependencies', 'simple-git-hooks', 'lint-staged', 'commitlint', 'engines'] as const
const MANIFEST_FIELDS = ['packageManager'] as const
const WORKSPACE = 'pnpm-workspace.yaml'

/** The entries of `v` when it is a JSON object, else `{}`. */
function entriesOf(v: unknown): Entries {
  return Object.fromEntries(Object.entries(asObject<Record<string, unknown>>(v) ?? {}).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]))
}

/** MANIFEST_FIELDS (block '') and each of MANIFEST_BLOCKS in a package.json text, `{}` when absent; undefined when the text is absent or not JSON. */
function manifestOf(json: string | null): Record<string, Entries> | undefined {
  if (json === null)
    return undefined
  try {
    const root = asObject<Record<string, unknown>>(parseJson(json)) ?? {}
    const fields = entriesOf(Object.fromEntries(MANIFEST_FIELDS.filter(f => root[f] !== undefined).map(f => [f, root[f]])))
    return { '': fields, ...Object.fromEntries(MANIFEST_BLOCKS.map(block => [block, entriesOf(root[block])])) }
  }
  catch {
    return undefined
  }
}

const YAML_SKIP_RE = /^\s*(?:#.*)?$/
// A top-level key of pnpm-workspace.yaml and its value on the same line, if any.
const YAML_TOP_RE = /^([A-Z_][\w-]*):(?:\s(.*))?$/i
// An entry of a nested map, its indent trimmed: a quoted or plain name, a colon, and the value,
// if any.
const YAML_ENTRY_RE = /^(?:'([^']*)'\s*|"([^"]*)"\s*|([^\s'"#:-][^:#]*)):(?:\s(.*))?$/
// An item of a nested list, its indent trimmed.
const YAML_ITEM_RE = /^-\s(.*)$/
const QUOTED_RE = /^(['"])(.*?)\1/
// The workspace's own package globs, never the template's to report.
const WORKSPACE_OWN = new Set(['packages'])

/** A YAML scalar as written: quotes dropped, else a trailing comment; empty when only a comment follows the colon. */
function yamlScalar(raw: string): string {
  const text = raw.trim()
  if (text.startsWith('#'))
    return ''
  return QUOTED_RE.exec(text)?.[2] ?? text.replace(/\s+#.*$/, '')
}

/**
 * The top-level settings of a pnpm-workspace.yaml text as flat entries, in file order: a scalar
 * under its key (`minimumReleaseAge`), each entry of a map as `<key>.<name>` (`catalog.vite`,
 * `allowBuilds.esbuild`), and each item of a list as `<key>.<item>` with the value `- <item>`
 * (`trustPolicyExclude.vite@5.4.21`). Node has no YAML parser, so it reads the block style pnpm
 * writes, line by line: the entries at the first entry's indent, quotes and comments dropped;
 * a flow-style value (`[...]`, `{...}`) and a deeper level (named `catalogs:`) are skipped, as
 * are the `packages` globs. Undefined when the text is absent.
 */
function workspaceOf(yaml: string | null): Entries | undefined {
  if (yaml === null)
    return undefined
  const entries: Entries = {}
  let block: { key: string, indent?: number } | undefined
  for (const line of yaml.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (YAML_SKIP_RE.test(line))
      continue
    const at = line.search(/\S/)
    if (at === 0) {
      const top = YAML_TOP_RE.exec(line)
      block = undefined
      if (!top || WORKSPACE_OWN.has(top[1]!))
        continue
      const value = top[2] === undefined ? '' : yamlScalar(top[2])
      if (value === '')
        block = { key: top[1]! }
      else if (!/^[[{]/.test(value))
        entries[top[1]!] = value
      continue
    }
    if (!block)
      continue
    block.indent ??= at
    if (at !== block.indent)
      continue
    const item = YAML_ITEM_RE.exec(line.trim())
    if (item) {
      const value = yamlScalar(item[1]!)
      if (value)
        entries[`${block.key}.${value}`] = `- ${value}`
      continue
    }
    const m = YAML_ENTRY_RE.exec(line.trim())
    const raw = m?.[4] === undefined ? '' : yamlScalar(m[4])
    if (m && raw && !/^[[{]/.test(raw))
      entries[`${block.key}.${m[1] ?? m[2] ?? m[3]!.trimEnd()}`] = raw
  }
  return entries
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
 * Three-way compare of one block of entries, into `out`: the template now, the template at the
 * baseline (`base`, absent when no baseline is known), and this repo. Only template keys are
 * compared, in template order, so a child's own entries are never mentioned — except to flag
 * one that references a file this sync deletes. Keys are reported as `<block>.<key>`.
 */
function compareEntries(block: string, template: Entries, base: Entries | undefined, local: Entries, deleted: string[], out: FollowUps): void {
  const refersToDeleted = (value: string): string | undefined => deleted.find(d => value.includes(d))
  const keyOf = (name: string): string => block ? `${block}.${name}` : name
  for (const [name, t] of Object.entries(template)) {
    const key = keyOf(name)
    const l = local[name]
    if (l === t)
      continue
    if (l === undefined) {
      if (base && base[name] !== undefined)
        out.customized.push(`${key} (absent here)`)
      else
        out.items.push({ key, kind: 'missing', template: t })
      continue
    }
    if (base && base[name] === t) {
      out.customized.push(key)
      continue
    }
    const item: FollowUp = { key, kind: 'changed', template: t, yours: l }
    const ref = refersToDeleted(l)
    if (ref)
      item.note = `yours references ${ref}, which this sync deletes`
    out.items.push(item)
  }
  for (const [name, l] of Object.entries(local)) {
    const ref = name in template ? undefined : refersToDeleted(l)
    if (ref)
      out.items.push({ key: keyOf(name), kind: 'changed', template: '(not on the template)', yours: l, note: `yours references ${ref}, which this sync deletes` })
  }
}

/** Three-way compare of every one of MANIFEST_BLOCKS in package.json (compareEntries), or why it is skipped. */
function manifestFollowUps(
  template: Record<string, Entries> | undefined,
  base: Record<string, Entries> | undefined,
  local: Record<string, Entries> | undefined,
  localMissing: boolean,
  deleted: string[],
): FollowUps {
  if (localMissing)
    return { items: [], customized: [], skipped: 'no package.json here' }
  if (!template)
    return { items: [], customized: [], skipped: 'the template has no readable package.json' }
  if (!local)
    return { items: [], customized: [], skipped: 'package.json here is not valid JSON' }
  const out: FollowUps = { items: [], customized: [] }
  for (const block of ['', ...MANIFEST_BLOCKS])
    compareEntries(block, template[block] ?? {}, base?.[block], local[block] ?? {}, deleted, out)
  return out
}

/** Three-way compare of the pnpm-workspace.yaml settings (workspaceOf, compareEntries), or why it is skipped. */
function workspaceFollowUps(template: Entries | undefined, base: Entries | undefined, local: Entries | undefined): FollowUps {
  if (!local)
    return { items: [], customized: [], skipped: `no ${WORKSPACE} here` }
  if (!template)
    return { items: [], customized: [], skipped: `the template has no ${WORKSPACE}` }
  const out: FollowUps = { items: [], customized: [] }
  compareEntries('', template, base, local, [], out)
  return out
}

// A template file under one of these is the repository's own content, never shared configuration:
// the template's records and pages, and its sample code.
const OWN_CONTENT = ['docs/internal', 'docs/public', 'src', 'packages', 'apps']

/**
 * Files the template added from `base` to `head` that this repository lacks, outside the synced
 * paths (`synced`, every MECHANICS and include entry, excluded ones too) and OWN_CONTENT: a
 * config file a synced gate reads, such as the secretlint config its lint:secrets step needs.
 */
function addedFiles(base: string, head: string, synced: string[]): string[] {
  const outside = [...synced, ...OWN_CONTENT]
  return zList(tryGit(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', base, head]))
    .filter(file => !outside.some(p => file === p || file.startsWith(`${p}/`)) && !existsSync(file))
}

/** One hook registration: the event, the matcher (empty when absent, which matches everything), and the command. */
interface Hook {
  event: string
  matcher: string
  command: string
}

/** The parts of a Claude Code settings file a template ships and a child must carry by hand. */
interface SettingsShape {
  allow: string[]
  deny: string[]
  hooks: Hook[]
  outputStyle?: string
}

// What a settings file may hold before validation, declared like RawState above.
interface RawSettings {
  permissions?: { allow?: unknown, deny?: unknown }
  hooks?: unknown
  outputStyle?: unknown
}
interface RawHookEntry {
  matcher?: unknown
  hooks?: unknown
}

/** `v` as a JSON object whose fields are still unchecked, or undefined for anything else. */
function asObject<T extends object>(v: unknown): T | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as T : undefined
}

/** The allow and deny rules, every command hook registration, and the output style of a settings.json text; undefined when it is not JSON. */
function settingsOf(json: string | null): SettingsShape | undefined {
  if (json === null)
    return undefined
  let parsed: unknown
  try {
    parsed = parseJson(json)
  }
  catch {
    return undefined
  }
  const root = asObject<RawSettings>(parsed) ?? {}
  const permissions = asObject<NonNullable<RawSettings['permissions']>>(root.permissions) ?? {}
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  const hooks: Hook[] = []
  for (const [event, entries] of Object.entries(asObject<Record<string, unknown>>(root.hooks) ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const e = asObject<RawHookEntry>(entry)
      const matcher = typeof e?.matcher === 'string' ? e.matcher : ''
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        const command = asObject<{ command?: unknown }>(h)?.command
        if (typeof command === 'string')
          hooks.push({ event, matcher, command })
      }
    }
  }
  const outputStyle = root.outputStyle
  return { allow: list(permissions.allow), deny: list(permissions.deny), hooks, ...(typeof outputStyle === 'string' ? { outputStyle } : {}) }
}

/** A template hook registration this repository lacks, with the registrations here it replaces. */
interface HookFollowUp {
  template: Hook
  yours: Hook[]
}

interface SettingsFollowUps {
  missing: string[]
  hooks: HookFollowUp[]
  skipped?: string
}

/**
 * Compare of .claude/settings.json, which is never synced: template allow and deny rules
 * absent here, the template's output style when this repository sets none, and every
 * template hook registration (event, matcher, command) absent here. `shipped` is every
 * registration any version of the template's file held. A registration here that the
 * template shipped and has since dropped is paired with its replacement; one it never shipped
 * is the repository's own, paired only as an edited matcher of the template's command. A
 * child's own rules and hooks are never mentioned, and the file is never edited.
 */
function settingsFollowUps(template: SettingsShape | undefined, shipped: Hook[], local: SettingsShape | undefined, localMissing: boolean): SettingsFollowUps {
  if (localMissing)
    return { missing: [], hooks: [], skipped: 'no .claude/settings.json here' }
  if (!template)
    return { missing: [], hooks: [], skipped: 'the template has no readable .claude/settings.json' }
  if (!local)
    return { missing: [], hooks: [], skipped: '.claude/settings.json here is not valid JSON' }
  const missing = [
    ...template.allow.filter(r => !local.allow.includes(r)).map(r => `permissions.allow ${r}`),
    ...template.deny.filter(r => !local.deny.includes(r)).map(r => `permissions.deny ${r}`),
    ...(template.outputStyle !== undefined && local.outputStyle === undefined ? [`outputStyle ${template.outputStyle}`] : []),
  ]
  const same = (a: Hook, b: Hook): boolean => a.event === b.event && a.matcher === b.matcher && a.command === b.command
  const fromTemplate = (h: Hook): boolean => template.hooks.some(t => same(t, h)) || shipped.some(s => same(s, h))
  const absent = template.hooks.filter(t => !local.hooks.some(l => same(t, l)))
  // What a registration here was replaced by. One the template shipped at any point and has
  // since dropped: the template's registrations absent here with its command (a changed
  // matcher), else with its matcher (a changed command), else every one for its event. One it
  // never shipped is the repository's own, or its edit of the template's matcher: paired with
  // those running its command only when it is the one registration here that runs it.
  const replacedBy = (l: Hook): Hook[] => {
    const inEvent = absent.filter(t => t.event === l.event)
    const byCommand = inEvent.filter(t => t.command === l.command)
    if (!fromTemplate(l))
      return local.hooks.filter(o => o.event === l.event && o.command === l.command).length === 1 ? byCommand : []
    if (byCommand.length > 0)
      return byCommand
    const byMatcher = inEvent.filter(t => t.matcher === l.matcher)
    return byMatcher.length > 0 ? byMatcher : inEvent
  }
  const replaced = local.hooks.filter(l => !template.hooks.some(t => same(t, l))).map(l => ({ l, by: replacedBy(l) }))
  const hooks = absent.map(t => ({ template: t, yours: replaced.filter(r => r.by.includes(t)).map(r => r.l) }))
  return { missing, hooks }
}

function describeHook(h: Hook): string {
  return `matcher ${h.matcher === '' ? '(none)' : h.matcher}, command ${h.command}`
}

// ---------------------------------------------------------------------------------

const toplevel = tryGit(['rev-parse', '--show-toplevel'])
if (toplevel === null)
  fail('Not a git repository — run this from inside your project.')
process.chdir(toplevel.trim())

const { state: stateFile, warnings } = readState()
for (const w of warnings)
  console.error(`Warning: ${w}`)

const args = parseArgs(process.argv.slice(2))
const origin = tryGit(['remote', 'get-url', 'origin'])?.trim()

// A state file that came with this repository is the sync point of the repository it was made
// from. Its sync point is never this one's, so the run is a first sync. When it names its
// writer, that repository is the template, and the writer's own ref and lists go with it;
// otherwise all the file can say is its url, ref, and lists.
let state = stateFile
if (stateFile && inherited(stateFile, origin)) {
  const came = `${STATE_FILE} came with this repository's first commit, so it holds the sync point of the repository this one was made from`
  if (stateFile.repo === undefined) {
    const { commit: _commit, ...configuration } = stateFile
    state = configuration
    console.error(`Warning: ${came}, not this one's: running a first sync, keeping its url, ref, exclude, and include. If that repository is your template (a fork of roots), pass its URL.`)
  }
  else {
    state = { url: stateFile.repo }
    console.error(`Warning: ${came} (${stateFile.repo}), not this one's: running a first sync${args.url === undefined ? ` from ${stateFile.repo}` : ''}, without its ref, exclude, or include. Pass a URL to sync from another template.`)
  }
}

const existingRemote = tryGit(['remote', 'get-url', REMOTE])?.trim()
const url = args.url ?? state?.url ?? existingRemote ?? TEMPLATE_URL
const ref = args.ref ?? state?.ref ?? DEFAULT_REF

// The template must never sync from itself: it would stage a state file and report a
// clean no-op that is easy to commit by mistake.
if (origin !== undefined && hostPath(origin) === hostPath(url))
  fail(`This checkout is the template itself (origin is ${url}) — run the sync in a repository made from it.`)

const exclude = new Set(state?.exclude ?? [])
const paths = [...MECHANICS.filter(p => !exclude.has(p)), ...(state?.include ?? []).filter(p => !MECHANICS.includes(p))]

// Refuse to clobber uncommitted work in the synced paths. Two exemptions: this script
// itself, untracked or modified (a repo that predates it, or holds an older tracked copy,
// bootstraps by dropping a fresh copy in place and running it, and the checkout below
// replaces it with the template's version anyway), and the state file when it is staged
// and otherwise clean, which is what a previous run left behind; a second run before the
// commit must not refuse its own work. The refusal says commit, never stash: every linked
// worktree shares one stash list, so another session's bare `git stash pop` can take the entry.
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
  fail(`Uncommitted changes in template-managed paths — commit first (a previous sync's staged files count too: commit them, or discard with git restore --staged --worktree <path>):\n\n${dirty.join('\n')}`)

if (existingRemote === undefined)
  git(['remote', 'add', '--no-tags', REMOTE, url])
else
  git(['remote', 'set-url', REMOTE, url])
// Never import the template's release tags into refs/tags: changelogen in this repo
// would version from them. Pinned tags are fetched into TAG_NS instead.
git(['config', `remote.${REMOTE}.tagOpt`, '--no-tags'])

const fetched = fetchRef(ref)
if ('error' in fetched)
  fail(`Could not fetch ${ref} (as a branch or a tag) from ${url}. Check the URL (git remote -v), the ref, and your network.\n  git: ${fetched.error}`)
const { head, kind } = fetched
const label = kind === 'tag' ? `${REMOTE}/${ref} (tag)` : `${REMOTE}/${ref}`

const recorded = state?.commit
// A fresh clone holds only the template history the fetch above brought, so a recorded commit
// off it (a sync back to an older ref, a switch to another ref) is fetched by its hash. It is
// lost only when the template no longer has it (a force-push), or the URL is another fork.
const hasCommit = (sha: string): boolean => tryGit(['cat-file', '-e', `${sha}^{commit}`]) !== null
const recordedLost = recorded !== undefined && !hasCommit(recorded) && (tryGit(['fetch', '--no-tags', REMOTE, recorded]) === null || !hasCommit(recorded))
const baseline = recorded === undefined ? inferBaseline(head, label, paths) : undefined
const base = baseline?.commit ?? recorded
const baseInHistory = baseline !== undefined || (recorded !== undefined && tryGit(['merge-base', '--is-ancestor', recorded, head]) !== null)
const behind = recorded !== undefined && !baseInHistory && tryGit(['merge-base', '--is-ancestor', head, recorded]) !== null
const since = recorded === undefined ? 'the baseline' : 'last sync'
// The template history that says what it shipped: the head's, and the sync point's when git has
// it and it is off that history (a sync back to an older ref, or a switch to another one).
const historyRevs = base !== undefined && base !== head && !recordedLost ? [head, base] : [head]

// Take the template's version of every synced path it still ships, then stage removals
// for tracked files under those paths that the template retired — a file inside a path
// or a whole path. Files outside the synced paths are never touched. A path whose
// checkout fails is reported, not hidden. The template's trees are read first so an
// unrelated repository (nothing to pull) is refused before anything is staged.
const upstreamByPath = new Map(paths.map(path => [path, new Set(zList(tryGit(['ls-tree', '-r', '-z', '--name-only', head, '--', path])))] as const))
if ([...upstreamByPath.values()].every(files => files.size === 0))
  fail(`Nothing to pull — none of the synced paths exist on ${label}. Is ${url} a roots template?`)

// A tracked file under a synced path that the template head lacks is retired only when it is
// the template's: in the tree at the sync point when that point is exact (the recorded commit,
// shared history, or a root tree; the root-time baseline is approximate, a bootstrap has none,
// and a lost recorded commit is gone), or byte-identical to a version the template shipped at
// that path, however it got here (an older script that recorded no sync point, a sync while
// the path was excluded). Anything else stays. It is listed as kept when it may still be the
// template's: at a path the template once shipped (a copy edited here, or the repository's own
// file reusing the path), or, with the recorded commit lost, anywhere, since the template may
// have shipped it only in the history it lost. Any other file, such as the repository's own
// skill or rule under a synced directory, is never mentioned.
const exactBase = base !== undefined && baseline?.how !== 'root time' && !recordedLost ? base : undefined
const atBase = new Map<string, Set<string>>()
function inBaseTree(path: string, file: string): boolean {
  if (exactBase === undefined)
    return false
  let files = atBase.get(path)
  if (!files) {
    files = new Set(zList(tryGit(['ls-tree', '-r', '-z', '--name-only', exactBase, '--', path])))
    atBase.set(path, files)
  }
  return files.has(file)
}

const deleted: string[] = []
const kept: string[] = []
const skipped: string[] = []
// Tracked files the template head lacks, with the synced path each is under and its blob id.
const unplaced = new Map<string, { path: string, blob: string }>()
let pulled = 0
for (const [path, upstream] of upstreamByPath) {
  if (upstream.size > 0) {
    const why = gitError(['checkout', head, '--', path])
    if (why === null)
      pulled++
    else
      skipped.push(`${path}  ${why}`)
  }
  // `<mode> <blob> <stage>\t<file>`
  for (const entry of zList(tryGit(['ls-files', '-s', '-z', '--', path]))) {
    const file = entry.slice(entry.indexOf('\t') + 1)
    if (!upstream.has(file) && !unplaced.has(file))
      unplaced.set(file, { path, blob: entry.split(' ')[1] ?? '' })
  }
}
const shippedVersions = versionsAt(historyRevs, [...new Set([...unplaced.values()].map(u => u.path))])
for (const [file, { path, blob }] of unplaced) {
  const versions = shippedVersions.get(file)
  if (inBaseTree(path, file) || versions?.has(blob) === true) {
    if (tryGit(['rm', '--quiet', '--', file]) !== null)
      deleted.push(file)
  }
  else if (recordedLost || versions !== undefined) {
    kept.push(file)
  }
}
if (pulled === 0)
  fail(`Could not check out any synced path:\n\n${skipped.join('\n')}`)

// The package.json blocks and the workspace settings are compared three-way when the sync point
// is on the template's history, else two-way; the added files need that sync point.
const threeWay = base !== undefined && baseInHistory
const followUps = manifestFollowUps(
  manifestOf(tryGit(['show', `${head}:package.json`])),
  threeWay ? manifestOf(tryGit(['show', `${base}:package.json`])) : undefined,
  existsSync('package.json') ? manifestOf(readFileSync('package.json', 'utf8')) : undefined,
  !existsSync('package.json'),
  deleted,
)
const workspace = workspaceFollowUps(
  workspaceOf(tryGit(['show', `${head}:${WORKSPACE}`])),
  threeWay ? workspaceOf(tryGit(['show', `${base}:${WORKSPACE}`])) : undefined,
  existsSync(WORKSPACE) ? workspaceOf(readFileSync(WORKSPACE, 'utf8')) : undefined,
)
const added = threeWay ? addedFiles(base, head, [...MECHANICS, ...(state?.include ?? [])]) : undefined

// Every hook registration the template shipped, from every version of its settings file in
// its history and the sync point's: a registration here that lags the sync point is still the
// template's, and one in no version is the repository's own.
const SETTINGS = '.claude/settings.json'
const settingsVersions = versionsAt(historyRevs, [SETTINGS]).get(SETTINGS) ?? new Set<string>()
const settings = settingsFollowUps(
  settingsOf(tryGit(['show', `${head}:${SETTINGS}`])),
  [...settingsVersions].flatMap(blob => settingsOf(tryGit(['cat-file', 'blob', blob]))?.hooks ?? []),
  existsSync(SETTINGS) ? settingsOf(readFileSync(SETTINGS, 'utf8')) : undefined,
  !existsSync(SETTINGS),
)

// `repo` is written once, from this repository's origin, and kept after that: a contributor
// whose origin is a fork of this repository must not rename it.
const next: SyncState & { url: string, commit: string } = { url, commit: head }
if (ref !== DEFAULT_REF)
  next.ref = ref
const repo = state?.repo ?? ownUrl(origin)
if (repo !== undefined)
  next.repo = repo
if (state?.exclude)
  next.exclude = state.exclude
if (state?.include)
  next.include = state.include
if (!state || state.url !== url || state.commit !== head || (state.ref ?? DEFAULT_REF) !== ref || state.repo !== next.repo) {
  writeState(next)
  git(['add', '--', STATE_FILE])
}

// ---------------------------------------------------------------------------------
// Report. Stable tokens (the `Baseline:` line and its mode, M/A/D lines, `!` on breaking
// commits, the section headers) so the sync-template skill can parse it.

const out: string[] = [`Template: ${url}`]
const fetchedAt = `Fetched ${label} at ${short(head)}`
function listCommits(from: string): void {
  // A merge commit is noise unless it is breaking: a PR-title merge can carry the `!` and the
  // footer while the commits it merges carry neither.
  const all = commitsSince(from, head)
  const commits = all.filter(c => !c.merge || isBreaking(c))
  const merges = all.length - commits.length
  const left = merges > 0 ? `; ${merges} merge${merges === 1 ? '' : 's'} left out` : ''
  const count = `${commits.length} commit${commits.length === 1 ? '' : 's'} since ${since} (${short(from)}${left}):`
  if (recorded === undefined)
    out.push(count)
  else
    out.push(`${fetchedAt} — ${count}`)
  // The cap hides only non-breaking commits: a breaking one names a hand-edit to make.
  let shown = 0
  let hidden = 0
  for (const c of commits) {
    const breaking = isBreaking(c)
    if (!breaking && shown >= LOG_CAP) {
      hidden++
      continue
    }
    if (!breaking)
      shown++
    out.push(`  ${breaking ? '!' : ' '} ${short(c.sha)} ${c.subject}`)
    for (const line of c.breaking)
      out.push(`      ${line}`)
  }
  if (hidden > 0)
    out.push(`  … and ${hidden} more, none breaking`)
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
  const diff = recordedLost ? 'git cannot fetch it either, so a file the template retired since then cannot be told from yours; any such file is listed under Kept' : 'the staged diff below is complete regardless'
  out.push(`${fetchedAt} — recorded sync point ${short(recorded)} is not in its history (template rebased or force-pushed, or the state file points at another fork). Skipping the commit list; ${diff}.`)
}
else if (recorded === head) {
  out.push(`${fetchedAt} — unchanged since last sync.`)
}
else {
  listCommits(recorded)
}

// Rename detection off: a rename would pair a deletion with an unrelated addition and show
// only the destination, hiding which file is removed.
const staged = zList(tryGit(['diff', '--cached', '--no-renames', '--name-status', '-z', '--', ...paths, STATE_FILE]))
out.push('')
if (staged.length === 0) {
  out.push('Already up to date — nothing staged.')
}
else {
  out.push('Staged (review with git diff --cached):')
  for (let i = 0; i < staged.length; i += 2) {
    const status = (staged[i] ?? '').slice(0, 1)
    const file = staged[i + 1] ?? ''
    const note = file === SELF ? '   (this script — the new version runs next time)' : ''
    out.push(`  ${status}  ${file}${note}`)
  }
}
// The first `repo` comes from whoever runs the sync first, and their origin may be a fork of
// this repository: said out loud, so a wrong one is corrected before it is committed.
if (state?.repo === undefined && next.repo !== undefined)
  out.push(`Recorded this repository as ${next.repo} ("repo" in ${STATE_FILE}): a repository made from this one with "Use this template" syncs from it. If that is a personal fork or a mirror, set "repo" to the canonical URL before you commit.`)
if (skipped.length > 0) {
  out.push('Skipped (git checkout failed — fix and re-run):')
  for (const s of skipped)
    out.push(`  ${s}`)
}
if (kept.length > 0) {
  out.push('Kept (under a synced path and not on the template; each is yours or one the template retired — git rm the template\'s):')
  for (const k of kept)
    out.push(`  ${k}`)
}

function listFollowUps(title: string, file: string, f: FollowUps): void {
  out.push('')
  if (f.skipped) {
    out.push(`${title}: skipped — ${f.skipped}.`)
  }
  else if (f.items.length === 0) {
    out.push(`${title}: none new.`)
  }
  else {
    out.push(`${title} — ${file} is yours, sync never edits it. Apply by hand where they apply:`)
    for (const item of f.items) {
      const tag = item.kind === 'missing' ? 'missing here' : baseInHistory ? `changed on the template since ${since}` : 'differs'
      out.push(`  ${item.key}  ${tag}`)
      out.push(`    template: ${item.template}`)
      if (item.yours !== undefined)
        out.push(`    yours:    ${item.yours}`)
      if (item.note)
        out.push(`    note: ${item.note}`)
    }
  }
  if (f.customized.length > 0)
    out.push(`  Customized locally (unchanged on the template since ${since}): ${f.customized.join(', ')}`)
}
listFollowUps('Follow-ups', 'package.json', followUps)
listFollowUps('Workspace', WORKSPACE, workspace)

out.push('')
if (added === undefined) {
  out.push('Files: skipped — no sync point on the template\'s history to tell a file it added from one this repository removed.')
}
else if (added.length === 0) {
  out.push('Files: none new.')
}
else {
  out.push(`Files — the template added these since ${since} outside the synced paths, and sync never copies them. Take each that applies:`)
  for (const file of added) {
    out.push(`  ${file}  missing here`)
    out.push(`    git restore --source=${short(head)} -- ${file}`)
  }
}

out.push('')
if (settings.skipped) {
  out.push(`Settings: skipped — ${settings.skipped}.`)
}
else if (settings.missing.length === 0 && settings.hooks.length === 0) {
  out.push('Settings: none new.')
}
else {
  out.push(`Settings — ${SETTINGS} is yours, sync never edits it. Apply by hand where they apply:`)
  for (const m of settings.missing)
    out.push(`  ${m}  missing here`)
  for (const h of settings.hooks) {
    out.push(`  hooks.${h.template.event}  ${h.yours.length > 0 ? 'differs' : 'missing here'}`)
    out.push(`    template: ${describeHook(h.template)}`)
    for (const y of h.yours)
      out.push(`    yours:    ${describeHook(y)}`)
  }
}

if (staged.length > 0) {
  out.push('', 'Next:')
  out.push('  git diff --cached                                    # review')
  out.push('  git restore --staged --worktree <path>               # discard one path')
  out.push('  git commit -m "chore: sync mechanics from template"  # keep')
}
console.log(out.join('\n'))
