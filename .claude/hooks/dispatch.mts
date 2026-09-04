/**
 * PreToolUse dispatcher — the only hook registered in .claude/settings.json. Reads the
 * tool-call JSON once and runs every `deny-*.mts` guard in this directory with it; any guard
 * exiting non-zero denies the call (exit 2, fail closed). Guards are discovered by filename,
 * so adding one needs no settings.json edit. Node builtins only (node 24 runs .mts natively),
 * so the guards work before `pnpm install` and in any repo they are synced into.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

let input = ''
process.stdin.on('data', (d) => { input += d }).on('end', () => {
  const dir = import.meta.dirname
  const guards = readdirSync(dir).filter(f => /^deny-.*\.mts$/.test(f)).sort()
  for (const guard of guards) {
    const r = spawnSync(process.execPath, [join(dir, guard)], { input, stdio: ['pipe', 'inherit', 'inherit'] })
    if (r.status !== 0)
      process.exit(2)
  }
  process.exit(0)
})
