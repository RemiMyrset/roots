/**
 * Session-start hook — prints the writing rules (.claude/output-styles/writing.md, frontmatter
 * stripped) as SessionStart context for Codex and Gemini CLI, registered in .codex/hooks.json
 * and .gemini/settings.json as `pnpm -w --silent run session`. Claude Code applies the same
 * file as its output style (`outputStyle` in .claude/settings.json) and does not register this
 * hook: it would inject the text twice and override a /config choice. The payload is never
 * read; nothing in it changes the output. Stdin is drained so the tool's write never meets a
 * closed pipe, with a 5s backstop for a harness that never closes it. Always exits 0 — a
 * session hook must never block a session — through process.exitCode rather than
 * process.exit() (see dispatch.mts for the Windows pipe abort). A missing style file prints
 * one stderr line and no context. Node builtins only, so it runs before `pnpm install`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const STYLE = join(import.meta.dirname, '..', 'output-styles', 'writing.md')

process.stdin.resume()
setTimeout(() => process.stdin.destroy(), 5000).unref()

/** The style body: CRLF normalized, YAML frontmatter removed, or null when the file is unreadable. */
function styleBody(): string | null {
  try {
    return readFileSync(STYLE, 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  }
  catch {
    return null
  }
}

const body = styleBody()
if (body === null)
  process.stderr.write(`writing rules: ${STYLE} not found; no context injected.\n`)
else
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } })}\n`)
process.exitCode = 0
