/**
 * Drift check between the done gate and CI: every `pnpm <script>` a workflow runs must be
 * a gate in scripts/verify.mts, and every gate must be run by some workflow — otherwise
 * "pnpm verify is what CI runs" quietly stops being true. A separate script rather than a
 * verify self-check because CI runs discrete steps and never `pnpm verify` itself.
 * A workflow step that is deliberately not a gate carries a trailing `# not a gate` comment
 * (the exemption lives in the child-owned workflow, so a child can add its own steps without
 * diverging from the synced files); the frozen-lockfile install is a gate like any other.
 * Every `pnpm <script>` on a step line counts, so `pnpm a && pnpm b` records both.
 * Two workflow rules ride along. A workflow that runs a gate also runs on `pull_request`, so
 * a break in it (a bumped action, an edited step) shows before merge, not first on main. And
 * while the shared VitePress config sets `lastUpdated`, a workflow that builds a docs site
 * checks out full history (`fetch-depth: 0`): a shallow clone stamps every page, and the
 * sitemap, with the checkout commit's date.
 * Node builtins only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = join(import.meta.dirname, '..')

// Every pnpm('<script>', …) call in verify.mts, by its first argument — the drift gate's
// inner docs:gen included; extra arguments (the install gate's flags) are not part of the name.
const verifySource = readFileSync(join(root, 'scripts/verify.mts'), 'utf8')
const gates = new Set([...verifySource.matchAll(/\bpnpm\('([^']+)'/g)].map(m => m[1]!))

const sharedConfig = join(root, 'docs/.shared/config.ts')
const lastUpdated = existsSync(sharedConfig) && /\blastUpdated:\s*true\b/.test(readFileSync(sharedConfig, 'utf8'))

/** Whether the workflow's top-level `on:` triggers include `pull_request` (map key, list, or inline). */
function runsOnPullRequest(lines: string[]): boolean {
  const start = lines.findIndex(line => /^["']?on["']?:/.test(line))
  if (start < 0)
    return false
  const block = [lines[start]!.replace(/^["']?on["']?:/, '')]
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line))
      break
    block.push(line)
  }
  // \b stops before `_target`: pull_request_target runs the base branch's copy of the workflow.
  return block.some(line => /\bpull_request\b/.test(line.replace(/(?:^|\s)#.*$/, '')))
}

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
const workflowsDir = join(root, '.github/workflows')
for (const file of readdirSync(workflowsDir).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const where = `.github/workflows/${file}`
  const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n')
  let gateSteps = 0
  let buildsSite = false
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
      gateSteps++
    }
  })
  if (gateSteps > 0 && !runsOnPullRequest(lines))
    problems.push(`${where} runs verify gates but not on pull_request, so a break in it first shows on main`)
  if (buildsSite && lastUpdated) {
    for (const at of shallowCheckouts(lines))
      problems.push(`${where}:${at} builds a docs site from a shallow checkout; lastUpdated needs \`fetch-depth: 0\``)
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
