/**
 * Pre-tool dispatcher — the one hook registered in .claude/settings.json, .codex/hooks.json,
 * and .gemini/settings.json. Reads the tool-call JSON once, refuses anything that is not a
 * payload with a string tool_input.command (fail closed), and runs every `deny-*.mts` guard in
 * this directory with it; any guard exiting non-zero denies the call (exit 2). Guards are
 * discovered by filename, so adding one needs no registration edit. Node builtins only (node
 * 24 runs .mts natively), so the guards work before `pnpm install` and in any repo they are
 * synced into. A harness that opens stdin and never closes it would hang the tool call, so
 * the dispatcher denies after 5s — far above any real payload, under Gemini's 10s hook timeout.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { commandOf } from './_lexer.mts'

setTimeout(() => {
  process.stderr.write('guards: no complete hook input within 5s; denying by default (fail closed).\n')
  process.exit(2)
}, 5000).unref()

let input = ''
process.stdin.on('data', (d) => { input += d }).on('end', () => {
  if (commandOf(input) === null) {
    process.stderr.write('guards: hook input is not a pre-tool payload with tool_input.command; denying by default (fail closed).\n')
    process.exit(2)
  }
  const dir = import.meta.dirname
  const guards = readdirSync(dir).filter(f => /^deny-.*\.mts$/.test(f)).sort()
  for (const guard of guards) {
    const r = spawnSync(process.execPath, [join(dir, guard)], { input, stdio: ['pipe', 'inherit', 'inherit'] })
    if (r.status !== 0)
      process.exit(2)
  }
  process.exit(0)
})
