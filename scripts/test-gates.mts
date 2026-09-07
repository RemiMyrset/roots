/**
 * Drift check between the done gate and CI: every `pnpm <script>` a workflow runs must be
 * a gate in scripts/verify.mts, and every gate must be run by some workflow — otherwise
 * "pnpm verify is what CI runs" quietly stops being true. A separate script rather than a
 * verify self-check because CI runs discrete steps and never `pnpm verify` itself.
 * `pnpm install` is exempt; a workflow step that is deliberately not a gate carries a
 * trailing `# not a gate` comment (the exemption lives in the child-owned workflow, so a
 * child can add its own steps without diverging from the synced files). Node builtins only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const root = join(import.meta.dirname, '..')
const NOT_A_GATE: ReadonlySet<string> = new Set(['install'])

// Every pnpm('<script>') call in verify.mts — the drift gate's inner docs:gen included.
const verifySource = readFileSync(join(root, 'scripts/verify.mts'), 'utf8')
const gates = new Set([...verifySource.matchAll(/\bpnpm\('([^']+)'\)/g)].map(m => m[1]!))

// Every `pnpm <script>` step in a workflow, with its file:line.
interface Step { where: string, script: string }
const steps: Step[] = []
const workflowsDir = join(root, '.github/workflows')
for (const file of readdirSync(workflowsDir).filter(f => f.endsWith('.yml')).sort()) {
  const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    const m = /^\s*(?:- )?(?:run: )?pnpm (?:run )?([a-z][\w:-]*)(\s.*)?$/.exec(line)
    if (!m)
      return
    const script = m[1]!
    if (NOT_A_GATE.has(script) || /#\s*not a gate\b/.test(m[2] ?? ''))
      return
    steps.push({ where: `.github/workflows/${file}:${i + 1}`, script })
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
