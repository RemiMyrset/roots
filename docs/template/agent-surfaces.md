# Agent surfaces

How Claude Code, Codex, and Gemini CLI each read the one rulebook, the guards,
the skills, and the writing rules. It is template-owned and synced.

## Surfaces

| | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Rulebook `AGENTS.md` | `CLAUDE.md`, one line: `@AGENTS.md` | native; nested files merged root-down, 32 KiB cap | `context.fileName` in `.gemini/settings.json` |
| Guards `.claude/hooks/dispatch.mts` | PreToolUse hook in `.claude/settings.json` | PreToolUse hook in `.codex/hooks.json` | BeforeTool hook in `.gemini/settings.json` |
| Skills `.claude/skills/` | read in place | `.agents/skills/`, the mirror | `.agents/skills/`, the mirror |
| Writing rules `.claude/output-styles/writing.md` | `outputStyle` in `.claude/settings.json` | SessionStart hook in `.codex/hooks.json` | SessionStart hook in `.gemini/settings.json` |
| Path-scoped rules `.claude/rules/` | loaded when a matching path is touched | none; `AGENTS.md` carries the same pointers | none; `AGENTS.md` carries the same pointers |
| Prompt-free commands | `permissions.allow` in `.claude/settings.json` | user-level execution policy only | `tools.allowed` in `.gemini/settings.json` |

The guards' threat model is [guards](./guards.md). `.claude/settings.json` is
never synced; every other file in the table is.

## Trust and registration

Each tool gates project-level config differently, and until its gate is
passed the guards and the writing rules are off in that tool:

- Claude Code asks once whether to trust the folder; hooks and settings load
  with it.
- Codex loads `.codex/` only after the folder is trusted, then asks once more
  to review and trust each hook definition via `/hooks`. Hooks are on by
  default; no feature flag is needed.
- Gemini's folder trust is off by default, so project settings load without
  a prompt. It fingerprints each hook and asks to confirm it on first use and
  again after any change to `.gemini/settings.json`, a sync included.

Both registrations run `pnpm -w --silent run guards`, a workspace-root script
that resolves from any subdirectory on Linux, macOS, and Windows with no
shell-specific syntax. `--silent` keeps pnpm's own lines off stdout, which
Gemini parses as JSON. Claude Code calls the dispatcher directly with node.

## Skills mirror

`.agents/skills/` is a generated, committed copy of `.claude/skills/`.
`pnpm docs:gen` rewrites it; `pnpm docs:check` and the drift gate refuse a
stale or hand-edited copy. It is a copy, never a symlink: a symlink needs
privileges on Windows and silently becomes a text file without them. Skill
bodies name their arguments in prose ("if the request names the topic, use
it") rather than Claude Code's `$ARGUMENTS` placeholder, which Codex and
Gemini would read as literal text; Claude Code appends the invocation
arguments to the skill either way.

## Writing rules

One file loads at every session start in all three tools. Claude Code carries
it as its output style, part of the system prompt and re-reminded during the
session. Codex and Gemini run `pnpm -w --silent run session` at SessionStart,
and the session hook `session-start.mts` prints the file, frontmatter
stripped, as `additionalContext`.

The session hook ignores its payload, always exits 0, and prints nothing when
the file is missing, so it can never block a session. Claude Code does not
register it: that would inject the text twice and override a `/config` choice.
`/config` overrides the style per machine in the gitignored
`settings.local.json`, and restores it.

Neither surface reaches Claude Code subagents. Codex truncates injected
context past `additionalContextLimit`, 2,500 tokens by default (about 10,000
characters), so `pnpm test:hooks` keeps the file under 8,000 characters.
Gemini's SessionStart entry carries no `matcher` on purpose: Gemini matches
lifecycle hooks by exact source name, so a regex such as `startup|resume`
never fires there, while Codex reads the same field as a source list.
`pnpm test:hooks` checks both registrations structurally.

## Nested rulebooks

Codex merges a nested `AGENTS.md` on its own, and Gemini loads it when a tool
first touches its directory. Claude Code walks nested `CLAUDE.md` only, so a
scoped rulebook needs the `CLAUDE.md` pairing described in the Monorepo map of
the root `AGENTS.md`.

## Permission prompts

The Claude Code permission allowlist in `.claude/settings.json` lets the
commands in the skills run without a prompt. It is deliberately narrower than
the read-only shape of a command suggests: `find` is absent (it deletes with
`-delete` and executes with `-exec`), and `git branch` and `git stash` are
listed only in their listing, push, and pop forms, so a branch deletion or a
stash drop prompts. Scripts with a colon in the name are listed one by one
(`Bash(pnpm test:hooks)`): a trailing `:*` is a space-wildcard, so
`Bash(pnpm test:*)` matches `pnpm test --watch` and never `pnpm test:hooks`.
`pnpm --filter <pkg> <script>` prompts once per repository by design; a
`--filter` rule wide enough to match would also approve `pnpm --filter x exec`.

Gemini's counterpart is `tools.allowed` in `.gemini/settings.json`, shipped
and synced with the same set in Gemini's prefix form
(`run_shell_command(pnpm test)` covers every `pnpm test:*` script); extend it
in the child. Codex's execution policy lives in the user's
`~/.codex/config.toml` and cannot be committed, so Codex prompts on the
commands the other two run silently.
