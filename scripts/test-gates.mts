/**
 * Drift check between the done gate and CI: every `pnpm <script>` a workflow runs must be
 * a gate in scripts/verify.mts, and every gate must be run by some workflow — otherwise
 * "pnpm verify is what CI runs" quietly stops being true. A separate script rather than a
 * verify self-check because CI runs discrete steps and never `pnpm verify` itself.
 * A workflow step that is deliberately not a gate carries a trailing `# not a gate` comment
 * (the exemption lives in the child-owned workflow, so a child can add its own steps without
 * diverging from the synced files); the frozen-lockfile install is a gate like any other.
 * Every `pnpm <script>` on a step line counts, so `pnpm a && pnpm b` records both.
 * Node builtins only.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = join(import.meta.dirname, '..')

// Every pnpm('<script>', …) call in verify.mts, by its first argument — the drift gate's
// inner docs:gen included; extra arguments (the install gate's flags) are not part of the name.
const verifySource = readFileSync(join(root, 'scripts/verify.mts'), 'utf8')
const gates = new Set([...verifySource.matchAll(/\bpnpm\('([^']+)'/g)].map(m => m[1]!))

// Every `pnpm <script>` step in a workflow, with its file:line.
interface Step { where: string, script: string }
const steps: Step[] = []
const workflowsDir = join(root, '.github/workflows')
for (const file of readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    const m = /^\s*(?:- )?(?:run: )?(pnpm .*)$/.exec(line)
    if (!m)
      return
    const [code = '', comment = ''] = m[1]!.split(/\s#/, 2)
    if (/\bnot a gate\b/.test(comment))
      return
    for (const call of code.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g))
      steps.push({ where: `.github/workflows/${file}:${i + 1}`, script: call[1]! })
  })
}

const problems: string[] = []
for (const step of steps) {
  if (!gates.has(step.script))
    problems.push(`${step.where} runs \`pnpm ${step.script}\` but scripts/verify.mts has no such gate`)
}
const run = new Set(steps.map(s => s.script))
for (const gate of gates) {
  if (!run.has(gate))
    problems.push(`verify gate \`${gate}\` is run by no workflow`)
}

if (problems.length > 0) {
  console.error(`\n✖ gates — ${problems.length} drift(s) between scripts/verify.mts and .github/workflows:\n`)
  for (const p of problems)
    console.error(`  ${p}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ${gates.size} verify gates match ${steps.length} workflow steps`)

// The second half holds the gates to what AGENTS.md says they enforce: ESLint must reject each
// probe below, linted from stdin under a path that is never written, and turbo's cache key
// must cover the node version. It runs the installed eslint and turbo under node, so it
// needs the install that verify and CI run first.
const failures: string[] = []

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

if (failures.length > 0) {
  console.error(`\n✖ gates — ${failures.length} rule(s) the gates do not hold:\n`)
  for (const f of failures)
    console.error(`  ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`✔ gates — ESLint rejects ${probes.length} rule probes; turbo hashes ${[...nodeVersionFiles].join(', ') || 'no node-version-file'}`)
