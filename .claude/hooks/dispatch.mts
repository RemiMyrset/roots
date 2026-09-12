/**
 * Pre-tool dispatcher — the one hook registered in .claude/settings.json, .codex/hooks.json,
 * and .gemini/settings.json. Reads the tool-call JSON once, refuses anything that is not a
 * payload with a string tool_input.command (fail closed), and runs every `deny-*.mts` guard in
 * this directory against it in this one process: each guard exports a `verdict(cmd, ctx)` that
 * returns the deny reason or null, and the first reason denies the call (exit 2). Guards are
 * discovered by filename, so adding one needs no registration edit; a guard that exports no
 * verdict or throws denies too. One process rather than one per guard: node's startup plus
 * type stripping cost about 0.15 s per spawn, and six spawns made every shell call wait a
 * second. Node builtins only (node 24 runs .mts natively), so the guards work before
 * `pnpm install` and in any repo they are synced into. A harness that opens stdin and never
 * closes it would hang the tool call, so the dispatcher denies after 5s — far above any real
 * payload, under the 10s timeout the Gemini registration sets (Gemini's own default is 60s).
 *
 * Exit codes are set through process.exitCode and the loop is left to drain rather than
 * forced with process.exit(): on Windows, stdio pipes are asynchronous, and exiting from
 * inside the stdin 'end' handler right after a stderr write aborts the process
 * (STATUS_STACK_BUFFER_OVERRUN) instead of returning 2.
 */
import type { GuardContext, Verdict } from './_lexer.mts'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { commandOf } from './_lexer.mts'

const TIMEOUT_MS = 5000

setTimeout(() => {
  process.stderr.write('guards: no complete hook input within 5s; denying by default (fail closed).\n')
  process.exitCode = 2
  // Releasing stdin lets the loop drain; the second timer is the backstop if it does not.
  process.stdin.destroy()
  setTimeout(() => process.exit(2), 1000).unref()
}, TIMEOUT_MS).unref()

async function dispatch(cmd: string): Promise<void> {
  const dir = import.meta.dirname
  const ctx: GuardContext = { cwd: process.cwd(), env: process.env, settingsFile: join(dir, '..', 'settings.json') }
  let guards: string[]
  try {
    guards = readdirSync(dir).filter(f => /^deny-.*\.mts$/.test(f)).sort()
  }
  catch (e) {
    process.stderr.write(`guards: cannot list ${dir} (${e instanceof Error ? e.message : String(e)}); denying by default (fail closed).\n`)
    process.exitCode = 2
    return
  }
  for (const guard of guards) {
    let why: string | null
    try {
      const mod = await import(pathToFileURL(join(dir, guard)).href) as { verdict?: unknown }
      if (typeof mod.verdict !== 'function')
        throw new TypeError(`${guard} exports no verdict()`)
      why = (mod.verdict as Verdict)(cmd, ctx)
    }
    catch (e) {
      process.stderr.write(`guards: ${guard} failed (${e instanceof Error ? e.message : String(e)}); denying by default (fail closed).\n`)
      process.exitCode = 2
      return
    }
    if (why !== null) {
      process.stderr.write(`Blocked: ${why}\n`)
      process.exitCode = 2
      return
    }
  }
  process.exitCode = 0
}

let input = ''
process.stdin.on('data', (d) => { input += d }).on('end', () => {
  const cmd = commandOf(input)
  if (cmd === null) {
    process.stderr.write('guards: hook input is not a pre-tool payload with tool_input.command; denying by default (fail closed).\n')
    process.exitCode = 2
    return
  }
  void dispatch(cmd)
})
