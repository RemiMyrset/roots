/**
 * Drift check between the done gate, CI, and the rulebook: every `pnpm <script>` a workflow
 * runs must be a gate in scripts/verify.mts, and every gate must be run by some workflow —
 * otherwise "pnpm verify is what CI runs" quietly stops being true. A separate script rather
 * than a verify self-check because CI runs discrete steps and never `pnpm verify` itself.
 * The AGENTS.md Commands list, the one place the rulebook restates the done gate, names every
 * gate but the install as `pnpm <script>` above its "Other commands" part; an AGENTS.md without
 * a `## Commands` heading is not checked.
 * A workflow step that is deliberately not a gate carries a trailing `# not a gate` comment
 * (the exemption lives in the child-owned workflow, so a child can add its own steps without
 * diverging from the synced files); the frozen-lockfile install is a gate like any other.
 * A step line is one whose code starts with `pnpm`, after any `NAME=value` assignments and one
 * `cd <dir> &&`, so the quoted text of an `echo` stays out. Every call on it counts, so
 * `pnpm a && pnpm b` records both. A call that runs no root script the way verify does, one
 * after a `cd` earlier on its line or with a flag before its script (`pnpm --filter web e2e`,
 * `pnpm -r test`), is never read as a gate, so it needs the comment. A `working-directory:` key
 * and a `cd` on an earlier line are not seen.
 * Four workflow rules ride along. A workflow that runs a gate also runs on `pull_request`, so
 * a break in it (a bumped action, an edited step) shows before merge, not first on main; and a
 * gate run on `push` is run there by at least one workflow that keeps every push run, one
 * with no concurrency group or a group of its own commit (`github.sha` or `github.run_id` in
 * it). GitHub keeps one run pending per group and cancels the pending one before it, whatever
 * `cancel-in-progress` says, so in a shared group a commit merged right behind another gets no
 * verdict; a deploy workflow such as pages.yml may share one, since ci.yml runs its gates. Every
 * action is pinned by its full commit SHA with its exact version in a trailing comment
 * (`@<sha> # v1.2.3`), the form the update-deps skill refreshes and GitHub's required SHA
 * pinning accepts. And while the shared VitePress config sets `lastUpdated`, a workflow that
 * builds a docs site checks out full history (`fetch-depth: 0`): a shallow clone stamps every
 * page, and the sitemap, with the checkout commit's date. The docs workflow's spec-discipline
 * nudge counts an edit under docs/template/ as a spec or decision edit.
 * Node builtins only in this first half.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, matchesGlob, relative, resolve } from 'node:path'
import process from 'node:process'

// A git hook or `git rebase --exec` exports GIT_DIR and its kin, which would aim every git this
// suite starts, the probes' tools included, at the repository running it: drop them first.
for (const key of Object.keys(process.env).filter(k => /^GIT_/i.test(k)))
  delete process.env[key]

const root = join(import.meta.dirname, '..')

// Every pnpm('<script>', …) call in verify.mts, by its first argument — the drift gate's
// inner docs:gen included; extra arguments (the install gate's flags) are not part of the name.
const verifySource = readFileSync(join(root, 'scripts/verify.mts'), 'utf8')
const gates = new Set([...verifySource.matchAll(/\bpnpm\('([^']+)'/g)].map(m => m[1]!))

const sharedConfig = join(root, 'docs/.shared/config.ts')
const lastUpdated = existsSync(sharedConfig) && /\blastUpdated:\s*true\b/.test(readFileSync(sharedConfig, 'utf8'))

/**
 * The concurrency groups a workflow sets, at the workflow or the job level, each with its
 * 1-based line: the inline form `concurrency: <group>` and the `group:` key of a block.
 */
function concurrencyGroups(lines: string[]): { line: number, group: string }[] {
  const found: { line: number, group: string }[] = []
  const value = (text: string): string => text.replace(/\s+#.*$/, '').trim()
  lines.forEach((line, i) => {
    const m = /^(\s*)concurrency:(.*)$/.exec(line)
    if (!m)
      return
    if (value(m[2]!)) {
      found.push({ line: i + 1, group: value(m[2]!) })
      return
    }
    for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > m[1]!.length); j++) {
      const group = /^\s*group:(.*)$/.exec(lines[j]!)
      if (group) {
        found.push({ line: j + 1, group: value(group[1]!) })
        break
      }
    }
  })
  return found
}

/** Whether the workflow's top-level `on:` triggers include `event` (map key, list, or inline). */
function runsOn(lines: string[], event: 'pull_request' | 'push'): boolean {
  const start = lines.findIndex(line => /^["']?on["']?:/.test(line))
  if (start < 0)
    return false
  const block = [lines[start]!.replace(/^["']?on["']?:/, '')]
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line))
      break
    block.push(line)
  }
  // The event as a key, a list item, or the whole value, never inside a path or a longer name:
  // pull_request_target runs the base branch's copy of the workflow.
  const word = new RegExp(`(?:^|[\\s[,])${event}(?=\\s*(?:[:,\\]]|$))`)
  return block.some(line => word.test(line.replace(/(?:^|\s)#.*$/, '')))
}

// A remote action pinned the one accepted way: owner/repo[/path]@<40-hex commit> # v1.2.3.
const USES_RE = /^\s*(?:- )?uses:\s*(\S+)(\s.*)?$/
const PINNED_RE = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/
const VERSION_COMMENT_RE = /^\s+#\s*v?\d+\.\d+\.\d\S*/

/**
 * The lines of the step that holds line `i`: from the nearest `- ` item at or above it to
 * before the next line indented no deeper than that dash. Undefined above the first item.
 */
function stepAt(lines: string[], i: number): string[] | undefined {
  let dash = i
  while (dash >= 0 && !/^\s*- /.test(lines[dash]!))
    dash--
  if (dash < 0)
    return undefined
  const indent = lines[dash]!.search(/\S/)
  let end = dash + 1
  while (end < lines.length && (lines[end]!.trim() === '' || lines[end]!.search(/\S/) > indent))
    end++
  return lines.slice(dash, end)
}

/** The 1-based lines of the `actions/checkout` steps that do not set `fetch-depth: 0`. */
function shallowCheckouts(lines: string[]): number[] {
  const found: number[] = []
  lines.forEach((line, i) => {
    if (!/\buses:\s*actions\/checkout@/.test(line))
      return
    const step = stepAt(lines, i)
    if (step && !step.some(l => /^\s*(?:- )?fetch-depth:\s*["']?0["']?\s*(?:#.*)?$/.test(l)))
      found.push(i + 1)
  })
  return found
}

// A step line: `pnpm` first in its code, after any list dash, `run: `, `NAME=value`
// assignments, and one `cd <dir> &&`. The anchor keeps the quoted text of an echo line out.
const STEP_RE = /^\s*(?:- )?(?:run:\s+)?((?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+)*(?:cd\s+(\S+)\s*&&\s*)?pnpm\s.*)$/

/**
 * A pnpm call on a step line: the root script it runs, or, for a call that runs none the way
 * verify does (one after a `cd` earlier on its line, with a flag before its script, or whose
 * script is no plain name, such as an expression), `scoped` holds the call as written, which is
 * never read as a gate.
 */
interface Call { script: string, scoped?: string }

/**
 * Reads one workflow line: undefined when it is no step line; else its code (before any
 * trailing comment), whether it carries `# not a gate`, and the pnpm calls in that code.
 */
function readStep(line: string): { code: string, exempt: boolean, calls: Call[] } | undefined {
  const m = STEP_RE.exec(line)
  if (!m)
    return undefined
  const [code = '', comment = ''] = m[1]!.split(/\s#/, 2)
  const calls: Call[] = []
  for (const call of code.matchAll(/\bpnpm\s+(?:run\s+)?([^\s;&|]+)([^;&|]*)/g)) {
    const script = call[1]!
    // The line's leading cd, or the last `cd` earlier on the line: either moves the call out of the root.
    const dir = m[2] ?? [...code.slice(0, call.index).matchAll(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/g)].at(-1)?.[1]
    if (dir === undefined && /^[a-z][\w:-]*$/.test(script))
      calls.push({ script })
    else
      calls.push({ script, scoped: `${dir === undefined ? '' : `cd ${dir} && `}pnpm ${script}${call[2]!.trimEnd()}` })
  }
  return { code, exempt: /\bnot a gate\b/.test(comment), calls }
}

// The step reader, run first on lines of its own, so a form of call it misses fails here
// rather than letting a workflow step escape the gate-or-comment rule.
const STEP_PROBES: { line: string, want: string[] }[] = [
  { line: '      - run: pnpm install --frozen-lockfile', want: ['install'] },
  { line: '          pnpm docs:gen && pnpm run docs:check', want: ['docs:gen', 'docs:check'] },
  { line: '      - run: CI=1 NODE_OPTIONS="--max-old-space-size=4096" pnpm e2e', want: ['e2e'] },
  { line: '      - run: cd apps/web && pnpm test', want: ['cd apps/web && pnpm test'] },
  { line: '      - run: pnpm install && cd apps/web && pnpm test', want: ['install', 'cd apps/web && pnpm test'] },
  { line: '      - run: pnpm --filter web e2e', want: ['pnpm --filter web e2e'] },
  { line: '      - run: pnpm -r test && pnpm lint', want: ['pnpm -r test', 'lint'] },
  { line: '      - run: echo "then run pnpm test"', want: [] },
]

const problems: string[] = []

for (const probe of STEP_PROBES) {
  const read = (readStep(probe.line)?.calls ?? []).map(c => c.scoped ?? c.script)
  if (read.join('\n') !== probe.want.join('\n'))
    problems.push(`the step reader read [${read.join(', ')}] from \`${probe.line.trim()}\`, want [${probe.want.join(', ')}]`)
}
if (readStep('      - run: pnpm --filter web e2e # not a gate')?.exempt !== true)
  problems.push('the step reader missed the `# not a gate` comment on a filtered call')

// Every pnpm call on a workflow step line, with its file:line.
interface Step extends Call { where: string }
const steps: Step[] = []
// Each gate a workflow runs on push, with the workflows that run it there and whether each
// keeps every push run; `where` names the shared group when it does not.
const onPush = new Map<string, { where: string, kept: boolean }[]>()
const workflowsDir = join(root, '.github/workflows')
for (const file of readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const where = `.github/workflows/${file}`
  const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n')
  let gateSteps = 0
  let buildsSite = false
  const own: string[] = []
  lines.forEach((line, i) => {
    const step = readStep(line)
    if (!step)
      return
    if (/\bpnpm (?:run )?docs:[\w-]+:build\b/.test(step.code))
      buildsSite = true
    if (step.exempt)
      return
    for (const call of step.calls) {
      steps.push({ where: `${where}:${i + 1}`, ...call })
      if (call.scoped === undefined)
        own.push(call.script)
      gateSteps++
    }
  })
  if (gateSteps > 0 && !runsOn(lines, 'pull_request'))
    problems.push(`${where} runs verify gates but not on pull_request, so a break in it first shows on main; run it on pull_request too, or end each line that is not a gate with \`# not a gate\``)
  if (gateSteps > 0 && runsOn(lines, 'push')) {
    const shared = concurrencyGroups(lines).find(g => !/\bgithub\.(?:sha|run_id)\b/.test(g.group))
    for (const script of new Set(own)) {
      const runs = onPush.get(script) ?? []
      runs.push({ where: shared ? `${where}:${shared.line}` : where, kept: !shared })
      onPush.set(script, runs)
    }
  }
  lines.forEach((line, i) => {
    const m = USES_RE.exec(line)
    const action = m?.[1]?.replace(/^["']|["']$/g, '')
    if (!action || action.startsWith('./') || action.startsWith('docker://'))
      return
    const rest = m![2] ?? ''
    if (!PINNED_RE.test(action) || !VERSION_COMMENT_RE.test(rest))
      problems.push(`${where}:${i + 1} uses ${action}${rest.trimEnd()}; pin an action by its full commit SHA with its exact version in a trailing comment: \`uses: owner/repo@<40-hex sha> # v1.2.3\``)
  })
  if (buildsSite && lastUpdated) {
    for (const at of shallowCheckouts(lines))
      problems.push(`${where}:${at} builds a docs site from a shallow checkout; lastUpdated needs \`fetch-depth: 0\``)
  }
}

// Gates whose every push run can be dropped, grouped by the workflows that run them.
const dropped = new Map<string, string[]>()
for (const [script, runs] of onPush) {
  if (!runs.some(r => r.kept)) {
    const where = runs.map(r => r.where).join(', ')
    dropped.set(where, [...dropped.get(where) ?? [], `\`pnpm ${script}\``])
  }
}
for (const [where, scripts] of dropped)
  problems.push(`${scripts.join(', ')} run on push only in a concurrency group shared across pushes (${where}): GitHub keeps one run pending per group and cancels the pending one before it, so a commit merged right behind another gets no verdict; give push runs a group of their own commit in one of those workflows: \`group: <name>-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}\``)

// The docs workflow's advisory spec-discipline nudge warns on a pull request that changes files
// outside docs/ with no spec or decision edit. The roots template keeps its contracts and its
// rationale under docs/template/, so an edit there counts, or every template pull request that
// does it right is warned. The step's own grep patterns run over sample change lists; a
// repository that dropped the step skips this, and one whose patterns this check cannot read
// fails, so a rewrite of the step cannot turn the check off unseen.
{
  const docsWorkflow = join(workflowsDir, 'docs.yml')
  const text = existsSync(docsWorkflow) ? readFileSync(docsWorkflow, 'utf8') : ''
  // A line's patterns, or none when any grep on it is in a form this check cannot read.
  const patterns = (name: string): RegExp[] => {
    const line = new RegExp(`^\\s*${name}=.*$`, 'm').exec(text)?.[0] ?? ''
    const read = [...line.matchAll(/grep (?:-v )?-E '([^']+)'/g)].map(m => new RegExp(m[1]!))
    return read.length === line.match(/\bgrep\b/g)?.length ? read : []
  }
  const outside = patterns('nondocs')
  const synced = patterns('docsync')
  if (text.includes('Spec-discipline nudge') && (outside.length === 0 || synced.length === 0))
    problems.push('.github/workflows/docs.yml: the spec-discipline nudge step is present but its nondocs= and docsync= lines hold no `grep -E` / `grep -v -E` pattern this check can read; keep that form or update scripts/test-gates.mts')
  if (outside.length > 0 && synced.length > 0) {
    const warns = (changed: string[]): boolean =>
      changed.some(f => outside.every(re => !re.test(f))) && !changed.some(f => synced.some(re => re.test(f)))
    const cases: [string[], boolean][] = [
      [['packages/a/src/a.ts'], true],
      [['packages/a/src/a.ts', 'docs/public/index.md'], true],
      [['packages/a/src/a.ts', 'docs/internal/specs/cli/a.md'], false],
      [['packages/a/src/a.ts', 'docs/internal/decisions/20260101-a.md'], false],
      [['scripts/sync-template.mts', 'docs/template/sync-template.md'], false],
      [['docs/template/conventions.md', 'README.md'], false],
    ]
    for (const [changed, want] of cases) {
      if (warns(changed) !== want)
        problems.push(`.github/workflows/docs.yml: the spec-discipline nudge ${want ? 'stays silent' : 'warns'} on a pull request that changes ${changed.join(' and ')}; it warns only when files outside docs/ change with no edit under docs/internal/specs, docs/internal/decisions, or docs/template`)
    }
  }
}

for (const step of steps) {
  if (step.scoped !== undefined)
    problems.push(`${step.where} runs \`${step.scoped}\`, which runs no root script the way scripts/verify.mts does, so it is never a gate; end that line with \`# not a gate\`, or run the gate as \`pnpm <script>\` from the root`)
  else if (!gates.has(step.script))
    problems.push(`${step.where} runs \`pnpm ${step.script}\` but scripts/verify.mts has no such gate; if the step is deliberately not a gate, end that line with \`# not a gate\``)
}
const run = new Set(steps.filter(s => s.scoped === undefined).map(s => s.script))
for (const gate of gates) {
  if (!run.has(gate))
    problems.push(`verify gate \`${gate}\` is run by no workflow`)
}

/**
 * The verify gates, the install aside, that an AGENTS.md text's Commands list leaves out:
 * those named as `pnpm <script>` nowhere between the `## Commands` heading and the "Other
 * commands" part or the next heading. Undefined when the text has no `## Commands` heading.
 */
function unlistedGates(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^##\s+Commands\s*$/.test(l))
  if (start < 0)
    return undefined
  const listed = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line) || /^Other commands\b/.test(line))
      break
    for (const m of line.matchAll(/\bpnpm\s+(?:run\s+)?([a-z][\w:-]*)/g))
      listed.add(m[1]!)
  }
  return [...gates].filter(g => g !== 'install' && !listed.has(g))
}

// The reader, run first on a list of its own that names one gate only under "Other commands".
{
  const [probeGate = ''] = [...gates].filter(g => g !== 'install').slice(-1)
  const probe = ['# Rules', '', '## Commands', '', ...[...gates].filter(g => g !== probeGate).map(g => `- \`pnpm ${g}\``), '', 'Other commands:', '', `- \`pnpm ${probeGate}\``, '', '## Next', ''].join('\n')
  const read = unlistedGates(probe)
  if (read?.join() !== probeGate || unlistedGates('# Rules\n\n- `pnpm test`\n') !== undefined)
    problems.push(`the Commands list reader read [${read?.join(', ') ?? 'no list'}] as missing from a probe list, want [${probeGate}]`)
}
const agentsFile = join(root, 'AGENTS.md')
const unlisted = existsSync(agentsFile) ? unlistedGates(readFileSync(agentsFile, 'utf8')) : undefined
for (const gate of unlisted ?? [])
  problems.push(`AGENTS.md: the Commands list names no \`pnpm ${gate}\`, a verify gate, so the rulebook's definition of done leaves it out; add its line above "Other commands"`)

if (problems.length > 0) {
  console.error(`\n✖ gates — ${problems.length} problem(s) between scripts/verify.mts, .github/workflows, and AGENTS.md:\n`)
  for (const p of problems)
    console.error(`  ${p}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ${gates.size} verify gates match ${steps.length} workflow steps${unlisted ? ' and the AGENTS.md Commands list' : ''}`)

// The second half holds the gates to what AGENTS.md says they enforce: ESLint must reject each
// probe below, linted from stdin under a path that is never written; turbo's hash must cover
// the node-version file (the major) and CI's turbo cache key the exact node, and a turbo run an
// agent starts must leave AGENTS.md alone; the pre-commit hook must run ESLint on every file
// type `pnpm lint` checks; every package tsconfig must take in every TypeScript file of its
// package; the install hook must set up the git hooks in a
// checkout and leave a linked worktree alone; verify's docs drift gate must skip only
// outside a git checkout, failing on any other git error; the secret scan must fail on a
// force-added `.env` and pass an untracked one, and the pre-commit scan must fail on it once it
// is staged; .gitignore must ignore every env-file name the secret-read guard denies; the
// release flow must keep the release skill's word: changelogen sends no commit author's email
// out unless `changelog.excludeAuthors` lists names, and the release script refuses a dirty
// tree; a devcontainer's `mounts` must share no volume with another repository's container;
// and a test suite must drop the inherited GIT_ variables before it starts a process. It runs
// the installed eslint, turbo, typescript, simple-git-hooks, secretlint, lint-staged, and
// changelogen, so it needs the install that verify and CI run first. The probes that need
// files write them to a temp directory only.
const failures: string[] = []
const tmp = mkdtempSync(join(tmpdir(), 'gates-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

/** Runs a CLI that ships as a node script under node_modules, from the root, with CI set as `pnpm lint` does. */
function runTool(script: string, args: string[], input?: string): { stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', script), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Parses a tool's JSON output; undefined when it printed something else, such as a crash. */
function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  }
  catch {
    return undefined
  }
}

// CI restores turbo's cache from earlier runs, and turbo hashes no runtime of its own. So the
// file a workflow installs node from is a global dependency, and a bump of it (the major, in
// .node-version) misses the cache; and a workflow that caches .turbo keys that cache, restore
// keys included, on the exact node setup-node reports. Otherwise a runner image that moves to a
// newer node 24 replays the test and typecheck results the old node produced.
const nodeVersionFiles = new Set<string>()
for (const file of readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f))) {
  for (const m of readFileSync(join(workflowsDir, file), 'utf8').matchAll(/^\s*node-version-file:\s*["']?([^\s"'#]+)/gm))
    nodeVersionFiles.add(m[1]!)
}
const dry = runTool('turbo/bin/turbo', ['run', 'test', '--dry=json'])
const plan = parseJson<{ globalCacheInputs?: { files?: Record<string, string> } }>(dry.stdout)
const hashed = plan?.globalCacheInputs?.files
if (!hashed) {
  failures.push(`\`turbo run test --dry=json\` printed no plan: ${dry.stderr.trim().split('\n')[0] ?? ''}`)
}
else {
  for (const file of nodeVersionFiles) {
    if (!(file in hashed))
      failures.push(`turbo.json globalDependencies lacks ${file}, which the workflows install node from, so a node bump replays cached results`)
  }
}

// From 2.11.5, turbo writes a managed block into the root AGENTS.md before any run it sees an
// AI agent start, unless the root turbo config sets `agentGuidance: false`: a second H1 that
// fails the lint gate. The probe makes such a run in a temp copy of the root manifests, with
// AI_AGENT set, and holds a stub rulebook to its bytes. An older turbo writes nothing.
{
  const dir = join(tmp, 'agent-guidance')
  mkdirSync(dir)
  const config = ['turbo.json', 'turbo.jsonc'].find(file => existsSync(join(root, file))) ?? 'turbo.json'
  for (const file of ['package.json', 'pnpm-workspace.yaml', config]) {
    if (existsSync(join(root, file)))
      writeFileSync(join(dir, file), readFileSync(join(root, file)))
  }
  const stub = '# Rulebook\n'
  writeFileSync(join(dir, 'AGENTS.md'), stub)
  const run = spawnSync(process.execPath, [join(root, 'node_modules/turbo/bin/turbo'), 'run', 'test', '--dry=json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', AI_AGENT: 'roots-test-gates' },
  })
  if (parseJson<object>(run.stdout ?? '') === undefined)
    failures.push(`the agent-guidance probe's \`turbo run test --dry=json\` printed no plan: ${(run.stderr ?? '').trim().split('\n')[0] ?? ''}`)
  else if (readFileSync(join(dir, 'AGENTS.md'), 'utf8') !== stub)
    failures.push(`turbo writes its own block into AGENTS.md on a run an agent starts, a second H1 that fails \`pnpm lint\`; set "agentGuidance": false in ${config} and delete any block between the turborepo-agent-rules markers`)
}

/**
 * The 1-based lines of the steps that cache turbo (`actions/cache` over a `.turbo` path) under
 * a key or a restore key that leaves out the exact node, the `steps.<id>.outputs.node-version`
 * of a setup-node step in the same workflow.
 */
function nodeBlindTurboCaches(lines: string[]): number[] {
  const nodeIds = new Set<string>()
  lines.forEach((line, i) => {
    if (!/\buses:\s*actions\/setup-node@/.test(line))
      return
    for (const l of stepAt(lines, i) ?? []) {
      const id = /^\s*(?:- )?id:\s*["']?([\w-]+)/.exec(l)?.[1]
      if (id)
        nodeIds.add(id)
    }
  })
  const exact = (key: string): boolean => [...key.matchAll(/\bsteps\.([\w-]+)\.outputs\.node-version\b/g)].some(k => nodeIds.has(k[1]!))
  const found: number[] = []
  lines.forEach((line, i) => {
    const step = /\buses:\s*actions\/cache(?:\/restore)?@/.test(line) ? stepAt(lines, i) ?? [] : []
    if (!step.some(l => /\.turbo\b/.test(l.replace(/\s#.*$/, ''))))
      return
    // Each key: the inline value of `key:` or `restore-keys:`, or each line of a block value.
    const keys: string[] = []
    step.forEach((l, j) => {
      const m = /^(\s*)(?:key|restore-keys):(.*)$/.exec(l)
      if (!m)
        return
      const inline = m[2]!.replace(/\s#.*$/, '').trim()
      if (inline && !/^[|>][+-]?$/.test(inline)) {
        keys.push(inline)
        return
      }
      for (const next of step.slice(j + 1)) {
        if (next.trim() !== '' && next.search(/\S/) <= m[1]!.length)
          break
        if (next.trim() !== '')
          keys.push(next.trim())
      }
    })
    if (keys.length === 0 || !keys.every(exact))
      found.push(i + 1)
  })
  return found
}

// The reader, run first on a workflow of its own: a key on the runner and commit alone, a key
// on the exact node with a restore key that is not, and one on the exact node throughout.
{
  const cacheProbe = (key: string, restore: string): string[] => ['    steps:', '      - uses: actions/setup-node@0 # v1.0.0', '        id: node', '      - uses: actions/cache@0 # v1.0.0', '        with:', '          path: .turbo/cache', `          key: ${key}`, '          restore-keys: |', `            ${restore}`]
  const onOs = `turbo-\${{ runner.os }}-`
  const onNode = `${onOs}node-\${{ steps.node.outputs.node-version }}-`
  const sha = `\${{ github.sha }}`
  const read = [
    nodeBlindTurboCaches(cacheProbe(`${onOs}${sha}`, onOs)),
    nodeBlindTurboCaches(cacheProbe(`${onNode}${sha}`, onOs)),
    nodeBlindTurboCaches(cacheProbe(`${onNode}${sha}`, onNode)),
  ]
  if (read.map(r => r.join()).join('|') !== '4|4|')
    failures.push(`the turbo cache key reader flagged lines [${read.map(r => r.join()).join('|')}] of its probes, want [4|4|]`)
}
for (const file of readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f)).sort()) {
  for (const at of nodeBlindTurboCaches(readFileSync(join(workflowsDir, file), 'utf8').split('\n')))
    failures.push(`.github/workflows/${file}:${at} caches turbo under a key that leaves out the exact node, so a newer node on the runner replays cached results; give setup-node \`id: node\` and put \`\${{ steps.node.outputs.node-version }}\` in the key and in each restore key`)
}

// Each probe lists the lines where a rule must fire and fires nowhere else, so a rule that is
// gone or over-broad fails alike. Findings of other rules on a probe are ignored.
interface Probe { what: string, file: string, source: string, expect: Record<string, number[]> }
const specifierProbe = [
  `import { a } from './a.ts'`,
  `import { b } from '../b.js'`,
  '',
  `export const c = [a, b, await import('./c.ts')]`,
  `export const d = await import('./d.mjs')`,
  '',
].join('\n')
// A `/** */` block on every export: a value, an interface, and a default export without one,
// beside one that has it. A local export list would hide its symbols from the rule, so the list
// itself is refused; a re-export stays legal. A tool config's default export is exempt, a named
// export in it is not, and a guard source under .claude/hooks is linted like any other.
const docBlockProbe = [
  '/** A documented value. */',
  'export const documented = 1',
  '',
  'export const value = 1',
  'export interface Shape { a: number }',
  'export default { value }',
  '',
].join('\n')
const exportListProbe = [
  'const local = 1',
  'export { local }',
  `export { base } from './base.ts'`,
  `export type { Shape } from './shape.ts'`,
  '',
].join('\n')
const probes: Probe[] = [
  { what: 'relative imports ending in .js or .mjs', file: 'scripts/gate-probe.mts', source: specifierProbe, expect: { 'no-restricted-imports': [2], 'no-restricted-syntax': [5] } },
  { what: 'a JavaScript source file', file: 'scripts/gate-probe.mjs', source: 'export const e = 1\n', expect: { 'no-restricted-syntax': [1] } },
  { what: 'a whole package under trustPolicyExclude', file: 'pnpm-workspace.yaml', source: 'trustPolicyExclude:\n  - vite@5.4.21\n  - vite\n', expect: { 'no-restricted-syntax': [3] } },
  { what: 'exports without a /** */ block', file: 'scripts/gate-probe.mts', source: docBlockProbe, expect: { 'jsdoc/require-jsdoc': [4, 5, 6] } },
  { what: 'a local export list', file: 'scripts/gate-probe.mts', source: exportListProbe, expect: { 'no-restricted-syntax': [2] } },
  { what: 'a tool config without a /** */ block', file: 'packages/gate-probe/vitest.config.ts', source: 'export const shared = 1\nexport default { shared }\n', expect: { 'jsdoc/require-jsdoc': [1] } },
  { what: 'a guard source without a /** */ block', file: '.claude/hooks/gate-probe.mts', source: 'export const verdict = 1\n', expect: { 'jsdoc/require-jsdoc': [1] } },
]
interface LintMessage { ruleId: string | null, line: number, message: string }
for (const probe of probes) {
  const lint = runTool('eslint/bin/eslint.js', ['--stdin', '--stdin-filename', probe.file, '--format', 'json'], probe.source)
  const messages = parseJson<{ messages: LintMessage[] }[]>(lint.stdout)?.[0]?.messages
  if (!messages) {
    failures.push(`eslint printed no result for ${probe.file}: ${lint.stderr.trim().split('\n')[0] ?? ''}`)
    continue
  }
  if (messages.some(m => m.ruleId === null && /\bignored\b/.test(m.message))) {
    failures.push(`eslint.config.ts ignores ${probe.file}, so no rule reaches ${probe.what}; take it out of the ignores`)
    continue
  }
  for (const [rule, lines] of Object.entries(probe.expect)) {
    const fired = messages.filter(m => m.ruleId === rule).map(m => m.line)
    if (fired.join() !== lines.join())
      failures.push(`eslint.config.ts: ${rule} on ${probe.what} (${probe.file}) fired on line(s) [${fired.join(', ')}], want [${lines.join(', ')}]`)
  }
}

// The pre-commit hook lints what CI lints, or a rule fails only in CI: the pnpm catalog and key
// order rules on package.json and pnpm-workspace.yaml, the TypeScript-only rule on a .js/.mjs
// file, the TypeScript rules on .cts, the markdown rules and fenced code on a page, and the
// TOML rules. lint-staged matches a pattern without a `/` against the basename. Skipped when
// the repository keeps no lint-staged config in package.json.
const LINT_STAGED_PROBES = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'src/index.ts', 'src/view.tsx', 'scripts/task.mts', 'scripts/task.cts', 'scripts/task.mjs', 'scripts/task.js', 'docs/page.md', 'mise.toml']
const lintStaged = (parseJson<{ 'lint-staged'?: unknown }>(readFileSync(join(root, 'package.json'), 'utf8')) ?? {})['lint-staged']
let lintStagedChecked = 0
if (typeof lintStaged === 'object' && lintStaged !== null) {
  const eslintGlobs = Object.entries(lintStaged)
    .filter(([, command]) => [command].flat().some(c => typeof c === 'string' && /\beslint\b/.test(c)))
    .map(([glob]) => glob)
  for (const file of LINT_STAGED_PROBES) {
    lintStagedChecked++
    if (!eslintGlobs.some(glob => matchesGlob(glob.includes('/') ? file : basename(file), glob)))
      failures.push(`package.json lint-staged runs ESLint on no pattern matching ${file}, so the rules on it fail only in CI; add its extension to an ESLint pattern`)
  }
}

// A package's TypeScript files are typechecked only by its own tsconfig (the root one covers
// none), so one that lists directories, such as `"include": ["src", "test"]`, leaves a bin/
// script or a root config unchecked. Each package that turbo typechecks is parsed by
// TypeScript itself, its directory listing swapped for a temp tree of paths a package grows.
// In build mode (`tsc -b`, the way Vite's scaffolds run a solution config of `"files": []`
// plus `references`) every project the config references is checked too, transitively, so its
// files count; `tsc -p` checks the named project alone. A solution-style package of the
// probe's own is read first, both ways, so the probe is known to read that layout.
const TSCONFIG_PROBES = ['src/index.ts', 'src/legacy.cts', 'test/index.test.ts', 'bin/cli.ts', 'scripts/seed.mts', 'drizzle.config.ts', 'vitest.config.ts']
const probeTree = join(tmp, 'tsconfig-probes')
for (const file of TSCONFIG_PROBES) {
  mkdirSync(dirname(join(probeTree, file)), { recursive: true })
  writeFileSync(join(probeTree, file), '')
}
const typecheckPlan = parseJson<{ tasks?: { task?: string, directory?: string, command?: string }[] }>(runTool('turbo/bin/turbo', ['run', 'typecheck', '--dry=json']).stdout)
const typechecked = (typecheckPlan?.tasks ?? []).filter(t => t.task === 'typecheck' && t.directory && t.command && t.command !== '<NONEXISTENT>')
{
  const ts = (await import('typescript')).default
  const slash = (p: string): string => p.replaceAll('\\', '/')
  const configPath = (base: string, project: string): string => {
    const at = resolve(base, project)
    return at.endsWith('.json') ? at : join(at, 'tsconfig.json')
  }
  // The configs a typecheck command run in `dir` reads, the probe files they take in, and why
  // any could not be read.
  const coverage = (dir: string, command: string): { configs: string[], covered: Set<string>, errors: string[] } => {
    const build = /(?:^|\s)(?:-b|--build)(?=\s|$)/.exec(command)
    const projects: string[] = []
    if (build) {
      for (const word of command.slice(build.index + build[0].length).trim().split(/\s+/)) {
        if (/^(?:&&|\|\||;|\|)$/.test(word))
          break
        if (word && !word.startsWith('-'))
          projects.push(word)
      }
    }
    else {
      projects.push(/(?:^|\s)(?:-p|--project)\s+(\S+)/.exec(command)?.[1] ?? 'tsconfig.json')
    }
    const configs: string[] = []
    const covered = new Set<string>()
    const errors: string[] = []
    const read = (config: string): void => {
      if (configs.includes(config))
        return
      configs.push(config)
      const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        getCurrentDirectory: () => dir,
        readDirectory: (at, extensions, excludes, includes, depth) => ts.sys.readDirectory(probeTree, extensions, excludes, includes, depth).map(f => join(at, relative(probeTree, f))),
        onUnRecoverableConfigFileDiagnostic: d => errors.push(`${slash(relative(root, config))}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`),
      })
      if (!parsed) {
        errors.push(`${slash(relative(root, config))}: not readable`)
        return
      }
      for (const file of parsed.fileNames)
        covered.add(slash(relative(dir, file)))
      if (build) {
        for (const reference of parsed.projectReferences ?? [])
          read(ts.resolveProjectReferencePath(reference))
      }
    }
    for (const project of projects.length > 0 ? projects : ['tsconfig.json'])
      read(configPath(dir, project))
    return { configs, covered, errors }
  }

  const solution = join(tmp, 'tsconfig-solution')
  mkdirSync(solution)
  const writeConfig = (name: string, config: unknown): void => writeFileSync(join(solution, name), `${JSON.stringify(config)}\n`)
  writeConfig('tsconfig.json', { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] })
  writeConfig('tsconfig.app.json', { compilerOptions: { composite: true }, include: ['src'] })
  writeConfig('tsconfig.node.json', { compilerOptions: { composite: true }, exclude: ['src', 'node_modules', 'dist'] })
  const built = coverage(solution, 'tsc -b')
  const project = coverage(solution, 'tsc --noEmit')
  if (built.errors.length > 0 || TSCONFIG_PROBES.some(p => !built.covered.has(p)) || project.covered.size > 0)
    failures.push(`the tsconfig probe misreads a solution-style package: under tsc -b it took in [${[...built.covered].join(', ')}] (${built.errors.join('; ')}), want every probe file; under tsc --noEmit [${[...project.covered].join(', ')}], want none`)

  for (const task of typechecked) {
    const dir = join(root, task.directory!)
    const { configs, covered, errors } = coverage(dir, task.command!)
    const where = configs.map(c => slash(relative(root, c))).join(', ')
    if (errors.length > 0) {
      failures.push(`${where} could not be read: ${errors.join('; ')}`)
      continue
    }
    const missed = TSCONFIG_PROBES.filter(p => !covered.has(p))
    if (missed.length === 0)
      continue
    if (configs.length > 1)
      failures.push(`${where} leave ${missed.join(', ')} out of the typecheck; make one of the projects \`${task.command}\` builds take in each, excluding only what must not be checked, such as \`"exclude": ["src", "node_modules", "dist"]\` in the one for tooling files`)
    else
      failures.push(`${where} leaves ${missed.join(', ')} out of the typecheck; take in every file and exclude only what must not be checked: \`"exclude": ["node_modules", "dist"]\` in place of \`include\``)
  }
}

// Every scripts/test-*.mts suite that starts a child process drops the inherited GIT_ variables
// before its first one, as the top of this file does. A git hook or `git rebase --exec` exports
// GIT_DIR and its kin, and under them a `git init` a suite ran in a temp folder re-initialised
// the repository running it, setting core.bare=true there. The drop is read as a line naming
// process.env and GIT_ followed by a line that deletes a process.env key; the reader runs first
// on samples of its own.
const DROP_GIT_ENV = ['for (const key of Object.keys(process.env).filter(k => /^GIT_/i.test(k)))', '  delete process.env[key]']
/** Whether a suite's source starts a child process before it drops the inherited GIT_ variables, or never drops them. */
function spawnsBeforeDrop(source: string): boolean {
  const spawn = /(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/.exec(source)
  const drop = /process\.env\)[^\n]*\bGIT_[^\n]*\n[^\n]*\bdelete process\.env\[/.exec(source)
  return spawn !== null && (drop === null || drop.index > spawn.index)
}
const dropCases: [string, boolean][] = [
  [`${DROP_GIT_ENV.join('\n')}\nspawnSync('git', ['init'])\n`, false],
  [`spawnSync('git', ['init'])\n${DROP_GIT_ENV.join('\n')}\n`, true],
  [`execFileSync('git', ['init'])\n`, true],
  [`const word = /a/.exec('a')\n`, false],
]
for (const [source, want] of dropCases) {
  if (spawnsBeforeDrop(source) !== want)
    failures.push(`the GIT_ drop reader read ${JSON.stringify(source)} as ${want ? 'safe' : 'unsafe'}, want ${want ? 'unsafe' : 'safe'}`)
}
const suites = readdirSync(join(root, 'scripts')).filter(f => /^test-.*\.mts$/.test(f)).sort()
for (const suite of suites.filter(f => spawnsBeforeDrop(readFileSync(join(root, 'scripts', f), 'utf8'))))
  failures.push(`scripts/${suite} starts a child process before it drops the inherited GIT_ variables, so under a git hook or \`git rebase --exec\` a git it runs, a \`git init\` in a temp folder included, rewrites the repository running the suite; put these two lines right below its imports: \`${DROP_GIT_ENV[0]}\` and \`${DROP_GIT_ENV[1]!.trim()}\``)

// The git probes below run git and node in throwaway repositories under tmp, with a git config
// of their own (no signing, no user hooks) and `bin` first on PATH; the GIT_ variables a
// surrounding git hook sets are gone since the top of the file.
// FORCE_NODE_FETCH would route changelogen past the release probe's fetch stub.
const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n')
/** The environment of a git probe: the caller's minus SKIP_INSTALL_SIMPLE_GIT_HOOKS and FORCE_NODE_FETCH, with `bin` first on PATH. */
function probeEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['SKIP_INSTALL_SIMPLE_GIT_HOOKS', 'FORCE_NODE_FETCH'].includes(k))),
    [pathKey]: [bin, process.env[pathKey] ?? ''].join(delimiter),
    GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  }
}
/** The environment of a probe that runs the installed binaries, as under `pnpm install`. */
const gitEnv = probeEnv(join(root, 'node_modules', '.bin'))
/** Runs `command` in `cwd` under gitEnv; its exit status and everything it printed. */
function inRepo(cwd: string, command: string, ...args: string[]): { status: number | null, out: string } {
  return runIn(gitEnv, cwd, command, ...args)
}
/** Runs a command in `cwd` under `env`; its exit status and everything it printed. */
function runIn(env: NodeJS.ProcessEnv, cwd: string, command: string, ...args: string[]): { status: number | null, out: string } {
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` }
}

// The install hook, run the way `pnpm install` runs it (the installed binaries on PATH): in a
// checkout it installs the git hooks; in a linked worktree, whose .git is a file, it leaves them
// to the main checkout instead of letting simple-git-hooks fail on `.git/hooks`.
{
  const repo = join(tmp, 'hooks-repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ 'simple-git-hooks': { 'pre-commit': 'true' } })}\n`)
  const setup = [inRepo(repo, 'git', 'init', '-q'), inRepo(repo, 'git', 'add', '-A'), inRepo(repo, 'git', 'commit', '-q', '-m', 'init'), inRepo(repo, 'git', 'worktree', 'add', '-q', join(tmp, 'hooks-worktree'))]
  const broken = setup.find(r => r.status !== 0)
  if (broken) {
    failures.push(`could not set up the git repository for the install hook probe: ${broken.out.trim()}`)
  }
  else {
    const prepare = join(root, 'scripts', 'prepare.mts')
    const main = inRepo(repo, process.execPath, prepare)
    if (main.status !== 0 || !existsSync(join(repo, '.git', 'hooks', 'pre-commit')))
      failures.push(`scripts/prepare.mts installed no pre-commit hook in a checkout (exit ${main.status}): ${main.out.trim()}`)
    const worktree = inRepo(join(tmp, 'hooks-worktree'), process.execPath, prepare)
    if (worktree.status !== 0 || /\[ERROR\]|Error/.test(worktree.out))
      failures.push(`scripts/prepare.mts failed in a linked worktree (exit ${worktree.status}): ${worktree.out.trim()}`)
  }
}

// verify's docs drift gate, run as `verify --only docs:gen` with a pnpm on PATH that does
// nothing: in a checkout it passes; outside one it skips with a note; and in a checkout git
// refuses, as it refuses one another user owns (GIT_TEST_ASSUME_DIFFERENT_OWNER), it fails,
// since a skip there would pass stale generated docs.
{
  const bin = join(tmp, 'noop-pnpm')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'pnpm.cmd'), '@exit /b 0\r\n')
  const env = probeEnv(bin, { GIT_CEILING_DIRECTORIES: tmp })
  const verify = join(root, 'scripts', 'verify.mts')
  const outside = join(tmp, 'verify-outside')
  const checkout = join(tmp, 'verify-checkout')
  mkdirSync(outside)
  mkdirSync(checkout)
  const init = runIn(env, checkout, 'git', 'init', '-q')
  if (init.status !== 0) {
    failures.push(`could not set up the git repository for the verify probe: ${init.out.trim()}`)
  }
  else {
    const clean = runIn(env, checkout, process.execPath, verify, '--only', 'docs:gen')
    if (clean.status !== 0 || clean.out.includes('skipped'))
      failures.push(`scripts/verify.mts --only docs:gen did not pass in a clean checkout (exit ${clean.status}): ${clean.out.trim()}`)
    const away = runIn(env, outside, process.execPath, verify, '--only', 'docs:gen')
    if (away.status !== 0 || !away.out.includes('drift check skipped: not a git checkout'))
      failures.push(`scripts/verify.mts --only docs:gen did not skip the drift check outside a git checkout (exit ${away.status}): ${away.out.trim()}`)
    const refused = runIn(probeEnv(bin, { GIT_CEILING_DIRECTORIES: tmp, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }), checkout, process.execPath, verify, '--only', 'docs:gen')
    if (refused.status === 0 || !refused.out.includes('dubious ownership'))
      failures.push(`scripts/verify.mts --only docs:gen did not fail on a checkout git calls of dubious ownership (exit ${refused.status}), so a git error passes stale generated docs: ${refused.out.trim()}`)
  }
}

// The secret scan, run in a repository whose .gitignore lists `.env`: secretlint applies the
// .gitignore cascade to every path it is given, so `pnpm lint:secrets` runs
// scripts/lint-secrets.mts, which must pass a `.env` holding a token while it is untracked (a
// developer's real one) and fail it once `git add -f` tracks it. The probe writes its own
// secretlint config, so a repository's own rule choices do not decide it.
{
  const scripts = parseJson<{ scripts?: Record<string, unknown> }>(readFileSync(join(root, 'package.json'), 'utf8'))?.scripts ?? {}
  const command = scripts['lint:secrets']
  if (typeof command !== 'string' || !/\bscripts\/lint-secrets\.mts\b/.test(command))
    failures.push(`package.json runs \`${String(command)}\` as lint:secrets, which skips a file git tracks although .gitignore matches it; set it to \`node scripts/lint-secrets.mts\``)
  const env = probeEnv(join(root, 'node_modules', '.bin'))
  const repo = join(tmp, 'secrets-repo')
  mkdirSync(repo)
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  writeFileSync(join(repo, '.secretlintrc.json'), `${JSON.stringify({ rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }] })}\n`)
  // A GitHub token the recommended preset flags, assembled here so this file holds none.
  writeFileSync(join(repo, '.env'), `GITHUB_TOKEN=${['ghp', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('_')}\n`)
  const lintSecrets = join(root, 'scripts', 'lint-secrets.mts')
  const scan = (): { status: number | null, out: string } => runIn(env, repo, process.execPath, lintSecrets)
  const init = runIn(env, repo, 'git', 'init', '-q')
  if (!existsSync(lintSecrets)) {
    failures.push('scripts/lint-secrets.mts is missing, so nothing scans a file git tracks although .gitignore matches it; run `pnpm sync:template`')
  }
  else if (init.status !== 0) {
    failures.push(`could not set up the git repository for the secret scan probe: ${init.out.trim()}`)
  }
  else {
    const untracked = scan()
    if (untracked.status !== 0)
      failures.push(`scripts/lint-secrets.mts failed on an untracked .env that .gitignore matches (exit ${untracked.status}), so it fails for anyone who keeps a real one: ${untracked.out.trim()}`)
    const add = runIn(env, repo, 'git', 'add', '-f', '.env')
    const forced = scan()
    if (add.status !== 0 || forced.status === 0 || !forced.out.includes('GITHUB_TOKEN'))
      failures.push(`scripts/lint-secrets.mts did not flag a force-added .env holding a GitHub token (exit ${forced.status}), so a tracked secret .gitignore matches reaches CI unscanned: ${add.out.trim()}${forced.out.trim()}`)
    // The pre-commit scan: the installed lint-staged, run with this repository's lint-staged
    // config on the same .env, now staged, must fail it too, since secretlint skips a path
    // .gitignore matches unless told not to.
    if (add.status === 0 && typeof lintStaged === 'object' && lintStaged !== null) {
      const manifest = join(root, 'node_modules', 'lint-staged', 'package.json')
      const bin = existsSync(manifest) ? parseJson<{ bin?: string | { 'lint-staged'?: string } }>(readFileSync(manifest, 'utf8'))?.bin : undefined
      const cli = typeof bin === 'string' ? bin : bin?.['lint-staged']
      if (cli === undefined) {
        failures.push('package.json keeps a lint-staged config, but node_modules/lint-staged names no bin to run; run `pnpm install`')
      }
      else {
        writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ 'lint-staged': lintStaged })}\n`)
        const commit = runIn(env, repo, process.execPath, join(root, 'node_modules', 'lint-staged', cli))
        if (commit.status === 0 || !commit.out.includes('GITHUB_TOKEN'))
          failures.push(`package.json lint-staged did not flag a staged .env that .gitignore matches, holding a GitHub token (exit ${commit.status}), so \`git add -f .env\` commits it; scan every staged file with \`"*": "secretlint --no-glob --no-gitignore"\`${commit.status === 0 ? '' : `: ${commit.out.trim()}`}`)
      }
    }
  }
}

// .gitignore ignores each env-file name the secret-read guard denies, so `git add -A` stages
// none, and neither name the guard lets an agent read: the `.env.example` carve-out and
// `.environment`, which `.env*` would catch. The guard is asked first, so the lists stay its
// own; git reads the root .gitignore alone, in a repository of its own. GIT_CONFIG_GLOBAL alone
// would still let git read $XDG_CONFIG_HOME/git/ignore (or ~/.config/git/ignore), the default
// core.excludesFile, so the call points core.excludesFile at a file that does not exist: a
// developer's global `.env*` cannot fail the check, nor a global `.env~` hide a missing line.
const SECRET_ENV_NAMES = ['.env', '.env.local', '.env.production', '.env-prod', '.env_x', '.env~', '.envrc', '.envrc.local', '.envrc-x', '.envrc_x', '.envrc~']
const READABLE_ENV_NAMES = ['.env.example', '.environment']
{
  const { verdict } = await import('../.claude/hooks/deny-secret-reads.mts')
  const ctx = { cwd: root, env: process.env, settingsFile: join(root, '.claude', 'settings.json') }
  const outOfStep = [
    ...SECRET_ENV_NAMES.filter(name => verdict(`cat ${name}`, ctx) === null),
    ...READABLE_ENV_NAMES.filter(name => verdict(`cat ${name}`, ctx) !== null),
  ]
  if (outOfStep.length > 0)
    failures.push(`the env-file name lists disagree with .claude/hooks/deny-secret-reads.mts on ${outOfStep.join(', ')}; move each to the list that matches the guard's verdict`)
  const env = probeEnv(join(root, 'node_modules', '.bin'))
  const repo = join(tmp, 'gitignore-repo')
  mkdirSync(repo)
  const gitignore = join(root, '.gitignore')
  writeFileSync(join(repo, '.gitignore'), existsSync(gitignore) ? readFileSync(gitignore) : '')
  const init = runIn(env, repo, 'git', 'init', '-q')
  const check = runIn(env, repo, 'git', '-c', `core.excludesFile=${join(tmp, 'no-global-excludes')}`, 'check-ignore', '--no-index', ...SECRET_ENV_NAMES, ...READABLE_ENV_NAMES)
  // check-ignore exits 0 when it prints an ignored name, 1 when there is none.
  if (init.status !== 0 || (check.status !== 0 && check.status !== 1)) {
    failures.push(`could not read .gitignore with git check-ignore: ${init.out.trim()}${check.out.trim()}`)
  }
  else {
    const ignored = new Set(check.out.split(/\r?\n/))
    const missed = SECRET_ENV_NAMES.filter(name => !ignored.has(name))
    if (missed.length > 0)
      failures.push(`.gitignore leaves ${missed.join(', ')} unignored, which the secret-read guard treats as secrets, so \`git add -A\` stages one; list \`.env\`, \`.env.*\`, \`.env-*\`, \`.env_*\`, \`.env~*\`, \`.envrc\`, \`.envrc.*\`, \`.envrc-*\`, \`.envrc_*\`, and \`.envrc~*\`, then \`!.env.example\``)
    const over = READABLE_ENV_NAMES.filter(name => ignored.has(name))
    if (over.length > 0)
      failures.push(`.gitignore ignores ${over.join(', ')}, which the secret-read guard lets an agent read; ignore the env-file names by their separator rather than \`.env*\`, and end the list with \`!.env.example\``)
  }
}

// The release flow, run through the installed changelogen in a throwaway repository whose
// package.json carries this one's `changelog` config, with fetch swapped for a stub that fails
// and says so. Every changelogen run, the release skill's preview included, sends each commit
// author's email to ungh.cc and prints the raw address when the lookup fails, unless
// `changelog.excludeAuthors` matches the author; a list of names without "" keeps the lookup on
// purpose for everyone it leaves out; any other value, such as none, [], null, or "", leaves it
// on for everyone and fails. `--release` commits the whole index, so the release script, run
// without its push or publish flags and with `--no-github`, must refuse a staged change and still
// release a clean tree. Skipped when package.json declares no changelogen.
let releaseChecked = 'changelogen is not declared'

/**
 * The probe's verdict on `changelog.excludeAuthors` once the preview has or has not sent a commit
 * author's email: `set` when the value leaves the lookup on for everyone, `stale` when it holds ""
 * and the lookup ran anyway, `pass` otherwise.
 */
function authorVerdict(excluded: unknown, sent: boolean): 'pass' | 'set' | 'stale' {
  if (!sent)
    return 'pass'
  if (Array.isArray(excluded) && excluded.includes(''))
    return 'stale'
  return Array.isArray(excluded) && excluded.some(v => typeof v === 'string' && v !== '') ? 'pass' : 'set'
}
// changelogen skips the exclusion for a falsy value, and its config loader turns null into the
// default [], so only a list holding a name counts as a choice to keep the lookup.
const verdictCases: [unknown, boolean, ReturnType<typeof authorVerdict>][] = [
  [undefined, true, 'set'],
  [[], true, 'set'],
  [null, true, 'set'],
  ['', true, 'set'],
  [false, true, 'set'],
  [[null], true, 'set'],
  [[''], true, 'stale'],
  [['', 'bot'], true, 'stale'],
  [['bot'], true, 'pass'],
  [undefined, false, 'pass'],
]
for (const [excluded, sent, want] of verdictCases) {
  const got = authorVerdict(excluded, sent)
  if (got !== want)
    failures.push(`scripts/test-gates.mts: the release probe takes \`changelog.excludeAuthors\` ${JSON.stringify(excluded) ?? 'absent'}, with an email ${sent ? 'sent' : 'not sent'}, as ${got}, not ${want}; only a list holding a name and no "" may keep the lookup on`)
}
{
  interface Manifest {
    scripts?: { release?: string }
    dependencies?: { changelogen?: string }
    devDependencies?: { changelogen?: string }
    changelog?: { excludeAuthors?: unknown }
  }
  const manifest = parseJson<Manifest>(readFileSync(join(root, 'package.json'), 'utf8')) ?? {}
  const cliManifest = join(root, 'node_modules', 'changelogen', 'package.json')
  const bin = existsSync(cliManifest) ? parseJson<{ bin?: string | { changelogen?: string } }>(readFileSync(cliManifest, 'utf8'))?.bin : undefined
  const cli = typeof bin === 'string' ? bin : bin?.changelogen
  const declared = manifest.devDependencies?.changelogen ?? manifest.dependencies?.changelogen
  if (declared !== undefined && !cli)
    failures.push('package.json declares changelogen, but node_modules/changelogen names no bin to run; run `pnpm install`')
  if (declared !== undefined && cli) {
    const repo = join(tmp, 'release-repo')
    const EMAIL = 'probe@example.invalid'
    const stub = 'globalThis.fetch = async url => { process.stderr.write("[fetch] " + url + "\\n"); throw new TypeError("fetch failed") }'
    const changelogen = (...args: string[]): { status: number | null, out: string } =>
      inRepo(repo, process.execPath, '--import', `data:text/javascript,${encodeURIComponent(stub)}`, join(root, 'node_modules', 'changelogen', cli), ...args)
    const commit = (subject: string): { status: number | null, out: string } =>
      inRepo(repo, 'git', '-c', 'user.name=Probe Author', '-c', `user.email=${EMAIL}`, 'commit', '-q', '-m', subject)
    mkdirSync(repo)
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'release-probe', version: '0.0.0', private: true, changelog: manifest.changelog })}\n`)
    const broken = [inRepo(repo, 'git', 'init', '-q'), inRepo(repo, 'git', 'add', '-A'), commit('feat: probe the release flow')].find(r => r.status !== 0)
    const preview = broken ?? changelogen()
    const sent = preview.out.includes('[fetch] ') || preview.out.includes(EMAIL)
    const verdict = authorVerdict(manifest.changelog?.excludeAuthors, sent)
    if (preview.status !== 0 || !preview.out.includes('the release flow'))
      failures.push(`the changelogen preview printed no changelog in a probe repository (exit ${preview.status}): ${preview.out.trim()}`)
    else if (verdict === 'stale')
      failures.push(`package.json \`changelog.excludeAuthors\` holds "", yet the installed changelogen still sent or printed a commit author's email; find what stops its author lookup now, then update package.json, the release skill, and this probe`)
    else if (verdict === 'set')
      failures.push(`changelogen sent a commit author's email to ungh.cc (and printed it when no option hid it); every run does, the release skill's preview included. Set \`"changelog": { "excludeAuthors": [""] }\` in package.json: the empty string matches every author, while \`noAuthors\` and \`hideAuthorEmail\` leave the lookup on, and a value that is not a list of names excludes no one`)
    releaseChecked = sent ? 'changelogen looks up only the authors changelog.excludeAuthors leaves in' : 'changelogen sends no author email'

    const words = (manifest.scripts?.release ?? '').split(/&&|\|\||[;|]/).map(part => part.trim().split(/\s+/))
    const isChangelogen = (word: string): boolean => basename(word).replace(/@[^@]*$/, '') === 'changelogen'
    const command = words.find(part => part.some(isChangelogen)) ?? []
    // `--no-github` last: a script without it, in a repository whose `changelog.repo` names
    // GitHub, would have the probe call the release API and open a browser on its failure.
    const args = [...command.slice(command.findIndex(isChangelogen) + 1).filter(arg => !/^--(?:push|publish)/.test(arg)), '--no-github']
    if (preview.status === 0 && args.includes('--release')) {
      const script = `\`${manifest.scripts?.release}\``
      const head = (): string => inRepo(repo, 'git', 'rev-parse', 'HEAD').out.trim()
      const tags = (): string => inRepo(repo, 'git', 'tag', '-l').out.trim()
      const before = head()
      writeFileSync(join(repo, 'staged.txt'), 'staged before the release\n')
      inRepo(repo, 'git', 'add', 'staged.txt')
      const dirty = changelogen(...args)
      if (dirty.status === 0 || head() !== before || tags() !== '') {
        failures.push(`package.json scripts.release (${script}) put a change staged before it ran into the release commit, which it pushes to the default branch past review; add \`--clean\`, which refuses a working tree with any change`)
      }
      else {
        const staged = commit('fix: commit the staged file')
        const clean = staged.status === 0 ? changelogen(...args) : staged
        if (clean.status !== 0 || tags() === '')
          failures.push(`package.json scripts.release (${script}), run without its push, released nothing from a clean tree (exit ${clean.status}): ${clean.out.trim()}`)
      }
      releaseChecked += ', and the release script refuses a dirty tree'
    }
  }
}

// Docker shares a named volume with every container on the host that names it, so a volume a
// devcontainer config mounts under a fixed name, such as the pnpm home and the pnpm binary it
// holds, is writable from every other repository whose config names it too. `${devcontainerId}`
// is derived from the checkout's path, so a name that carries it is one container's alone and
// survives a rebuild. A mount string follows `docker run --mount`, which lowercases its keys and
// its type, takes `src` for `source` with the later of the two winning, and defaults the type to
// volume; a volume with no source is anonymous and already per-container. The object form has
// `source` only. Every place the Dev Container spec looks for a config is read, and a repository
// with none passes. Only `mounts` is read: a volume passed through `runArgs` or a compose file
// goes unchecked.
let devcontainerChecked = 'no devcontainer config'
{
  const ID = `\${devcontainerId}`
  // The source of each named volume in a config's `mounts`, string and object forms alike.
  const namedVolumes = (mounts: unknown): string[] => (Array.isArray(mounts) ? mounts as unknown[] : []).flatMap((mount) => {
    const fields: { type?: unknown, source?: unknown } = typeof mount === 'string'
      ? Object.fromEntries(mount.split(',').map((pair) => {
          const key = pair.split('=')[0]!.trim().toLowerCase()
          return [key === 'src' ? 'source' : key, pair.slice(pair.indexOf('=') + 1).trim()]
        }))
      : typeof mount === 'object' && mount !== null ? mount : {}
    const { source } = fields
    return String(fields.type ?? 'volume').toLowerCase() === 'volume' && typeof source === 'string' && source !== '' ? [source] : []
  })
  const sample = namedVolumes(['source=shared,target=/a,type=volume', 'src=bare,dst=/b', { source: 'object', target: '/c', type: 'volume' }, `source=own-${ID},target=/d,type=volume`, 'type=bind,source=/home,target=/e', 'type=volume,target=/f', 'Source=upper,target=/g', 'type=Volume,source=caps,target=/h', 'Type=BIND,source=/tmp,target=/i', `source=early-${ID},src=late,target=/j`, `src=early,source=late-${ID},target=/k`])
  const want = ['shared', 'bare', 'object', `own-${ID}`, 'upper', 'caps', 'late', `late-${ID}`]
  if (sample.join(' ') !== want.join(' '))
    failures.push(`the devcontainer probe misreads mounts: it found the named volumes [${sample.join(', ')}], want [${want.join(', ')}]`)

  const dir = join(root, '.devcontainer')
  const configs = [
    join(root, '.devcontainer.json'),
    join(dir, 'devcontainer.json'),
    ...(existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(dir, e.name, 'devcontainer.json')) : []),
  ].filter(file => existsSync(file))
  if (configs.length > 0) {
    const ts = (await import('typescript')).default
    let volumes = 0
    for (const file of configs) {
      const where = relative(root, file).replaceAll('\\', '/')
      const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8')) as { config?: { mounts?: unknown }, error?: unknown }
      if (error || typeof config !== 'object' || config === null) {
        failures.push(`${where} could not be read as JSON with comments`)
        continue
      }
      for (const source of namedVolumes(config.mounts)) {
        volumes++
        if (!source.includes(ID))
          failures.push(`${where} mounts the volume "${source}", which every container that names it shares, so an agent in one repository can plant code another repository's container runs; put ${ID} in the name, as in pnpm-home-${ID}, which is this container's alone and survives a rebuild`)
      }
    }
    devcontainerChecked = `${volumes} devcontainer volume(s) are this container's alone`
  }
}

if (failures.length > 0) {
  console.error(`\n✖ gates — ${failures.length} rule(s) the gates do not hold:\n`)
  for (const f of failures)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ESLint rejects ${probes.length} rule probes; turbo hashes ${[...nodeVersionFiles].join(', ') || 'no node-version-file'}, and no workflow's turbo cache key leaves out the exact node; turbo leaves AGENTS.md alone on an agent's run; lint-staged lints ${lintStagedChecked} probe files; ${typechecked.length} package tsconfig(s) take in every probe file; prepare installs the git hooks and skips a linked worktree; verify's drift gate skips only outside a git checkout; lint:secrets and the pre-commit scan fail a force-added .env, and lint:secrets passes an untracked one; .gitignore ignores the ${SECRET_ENV_NAMES.length} env-file names the guard denies; ${releaseChecked}; ${devcontainerChecked}; ${suites.length} test suite(s) drop the inherited GIT_ variables before they start a process`)
