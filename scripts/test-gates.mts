/**
 * Drift check between the done gate and CI: every `pnpm <script>` a workflow runs must be
 * a gate in scripts/verify.mts, and every gate must be run by some workflow — otherwise
 * "pnpm verify is what CI runs" quietly stops being true. A separate script rather than a
 * verify self-check because CI runs discrete steps and never `pnpm verify` itself.
 * A workflow step that is deliberately not a gate carries a trailing `# not a gate` comment
 * (the exemption lives in the child-owned workflow, so a child can add its own steps without
 * diverging from the synced files); the frozen-lockfile install is a gate like any other.
 * Every `pnpm <script>` on a step line counts, so `pnpm a && pnpm b` records both.
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

/** The 1-based lines of the `actions/checkout` steps that do not set `fetch-depth: 0`. */
function shallowCheckouts(lines: string[]): number[] {
  const found: number[] = []
  lines.forEach((line, i) => {
    if (!/\buses:\s*actions\/checkout@/.test(line))
      return
    // The step starts at the nearest `- ` item at or above the uses line and ends before the
    // next line indented no deeper than that dash.
    let dash = i
    while (dash >= 0 && !/^\s*- /.test(lines[dash]!))
      dash--
    if (dash < 0)
      return
    const indent = lines[dash]!.search(/\S/)
    let end = dash + 1
    while (end < lines.length && (lines[end]!.trim() === '' || lines[end]!.search(/\S/) > indent))
      end++
    if (!lines.slice(dash, end).some(l => /^\s*(?:- )?fetch-depth:\s*["']?0["']?\s*(?:#.*)?$/.test(l)))
      found.push(i + 1)
  })
  return found
}

const problems: string[] = []

// Every `pnpm <script>` step in a workflow, with its file:line.
interface Step { where: string, script: string }
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
    const m = /^\s*(?:- )?(?:run: )?(pnpm .*)$/.exec(line)
    if (!m)
      return
    const [code = '', comment = ''] = m[1]!.split(/\s#/, 2)
    if (/\bpnpm (?:run )?docs:[\w-]+:build\b/.test(code))
      buildsSite = true
    if (/\bnot a gate\b/.test(comment))
      return
    for (const call of code.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)) {
      steps.push({ where: `${where}:${i + 1}`, script: call[1]! })
      own.push(call[1]!)
      gateSteps++
    }
  })
  if (gateSteps > 0 && !runsOn(lines, 'pull_request'))
    problems.push(`${where} runs verify gates but not on pull_request, so a break in it first shows on main`)
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
  if (!gates.has(step.script))
    problems.push(`${step.where} runs \`pnpm ${step.script}\` but scripts/verify.mts has no such gate; if the step is deliberately not a gate, end that line with \`# not a gate\``)
}
const run = new Set(steps.map(s => s.script))
for (const gate of gates) {
  if (!run.has(gate))
    problems.push(`verify gate \`${gate}\` is run by no workflow`)
}

if (problems.length > 0) {
  console.error(`\n✖ gates — ${problems.length} problem(s) between scripts/verify.mts and .github/workflows:\n`)
  for (const p of problems)
    console.error(`  ${p}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ${gates.size} verify gates match ${steps.length} workflow steps`)

// The second half holds the gates to what AGENTS.md says they enforce: ESLint must reject each
// probe below, linted from stdin under a path that is never written; turbo's cache key must
// cover the node version; the pre-commit hook must run ESLint on every file type a repo rule
// covers; every package tsconfig must take in every TypeScript file of its package; and the
// install hook must set up the git hooks in a checkout and leave a linked worktree alone. It
// runs the installed eslint, turbo, typescript, and simple-git-hooks, so it needs the install
// that verify and CI run first. The probes that need files write them to a temp directory only.
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

// CI restores turbo's cache from earlier runs, and turbo hashes no runtime of its own: unless
// the file a workflow installs node from is a global dependency, a node bump replays the test
// and typecheck results the old node produced.
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
const probes: Probe[] = [
  { what: 'relative imports ending in .js or .mjs', file: 'scripts/gate-probe.mts', source: specifierProbe, expect: { 'no-restricted-imports': [2], 'no-restricted-syntax': [5] } },
  { what: 'a JavaScript source file', file: 'scripts/gate-probe.mjs', source: 'export const e = 1\n', expect: { 'no-restricted-syntax': [1] } },
  { what: 'a whole package under trustPolicyExclude', file: 'pnpm-workspace.yaml', source: 'trustPolicyExclude:\n  - vite@5.4.21\n  - vite\n', expect: { 'no-restricted-syntax': [3] } },
]
interface LintMessage { ruleId: string | null, line: number }
for (const probe of probes) {
  const lint = runTool('eslint/bin/eslint.js', ['--stdin', '--stdin-filename', probe.file, '--format', 'json'], probe.source)
  const messages = parseJson<{ messages: LintMessage[] }[]>(lint.stdout)?.[0]?.messages
  if (!messages) {
    failures.push(`eslint printed no result for ${probe.file}: ${lint.stderr.trim().split('\n')[0] ?? ''}`)
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
// file, and the TypeScript rules on .cts. lint-staged matches a pattern without a `/` against
// the basename. Skipped when the repository keeps no lint-staged config in package.json.
const LINT_STAGED_PROBES = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'src/index.ts', 'src/view.tsx', 'scripts/task.mts', 'scripts/task.cts', 'scripts/task.mjs', 'scripts/task.js']
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

// The install hook, run the way `pnpm install` runs it (the installed binaries on PATH): in a
// checkout it installs the git hooks; in a linked worktree, whose .git is a file, it leaves them
// to the main checkout instead of letting simple-git-hooks fail on `.git/hooks`.
{
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_') && k !== 'SKIP_INSTALL_SIMPLE_GIT_HOOKS')),
    [pathKey]: [join(root, 'node_modules', '.bin'), process.env[pathKey] ?? ''].join(delimiter),
    GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  const inRepo = (cwd: string, command: string, ...args: string[]): { status: number | null, out: string } => {
    const r = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` }
  }
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

if (failures.length > 0) {
  console.error(`\n✖ gates — ${failures.length} rule(s) the gates do not hold:\n`)
  for (const f of failures)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ESLint rejects ${probes.length} rule probes; turbo hashes ${[...nodeVersionFiles].join(', ') || 'no node-version-file'}; lint-staged lints ${lintStagedChecked} probe files; ${typechecked.length} package tsconfig(s) take in every probe file; prepare installs the git hooks and skips a linked worktree`)
