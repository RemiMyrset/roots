# Agent surfaces

How Claude Code, Codex, and Gemini CLI each read the one rulebook, the guards,
the skills, and the writing rules. It is template-owned and synced.

## Surfaces

| | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Rulebook `AGENTS.md` | `CLAUDE.md`, one line: `@AGENTS.md` | native; files merged from the root down to the launch directory, 32 KiB cap | `context.fileName` in `.gemini/settings.json` |
| Guards `.claude/hooks/dispatch.mts` | PreToolUse hook in `.claude/settings.json` | PreToolUse hook in `.codex/hooks.json` | BeforeTool hook in `.gemini/settings.json` |
| Skills `.claude/skills/` | read in place | `.agents/skills/`, the mirror | `.agents/skills/`, the mirror |
| Writing rules `.claude/output-styles/writing.md` | `outputStyle` in `.claude/settings.json` | SessionStart hook in `.codex/hooks.json` | SessionStart hook in `.gemini/settings.json` |
| Path-scoped rules `.claude/rules/` | loaded when a matching path is touched | none; `AGENTS.md` carries the same pointers | none; `AGENTS.md` carries the same pointers |
| Prompt-free commands | `permissions.allow` in `.claude/settings.json` | none shipped | none shipped |

The guards' threat model is [guards](./guards.md). `AGENTS.md`, `CLAUDE.md`,
and `.claude/settings.json` are the child's own and never synced; every other
file in the table is.

Gemini's `context.fileName` lists `GEMINI.md` beside `AGENTS.md`, so each
developer's own `~/.gemini/GEMINI.md` still loads; a `GEMINI.md` committed to
the project would load too.

`.claude/settings.json` sets `attribution` to empty strings, which drops
Claude Code's co-author trailer from commits and its line from pull request
bodies. Delete the block, or write your own text in it, to have them back.

## Trust and registration

Each tool gates project-level config differently, and until its gate is
passed the guards and the writing rules are off in that tool:

- Claude Code asks once whether to trust the folder; hooks and settings load
  with it.
- Codex loads `.codex/` only after the folder is trusted, then asks once more
  to review and trust each hook definition via `/hooks`. Trust is recorded
  against the definition's hash, so a changed hook, including one a template
  sync brings, is skipped until it is trusted again. Hooks are on by default;
  no feature flag is needed.
- Gemini asks once whether to trust the folder; folder trust is on by
  default. Untrusted, it ignores `.gemini/settings.json` and `.agents/skills/`,
  so the rulebook, the guards, the writing rules, and the skills are all off.
  Trusted, it prints a warning naming each new hook, or one whose name or
  command changed, and then runs it without asking.

Start Claude Code and Gemini CLI at the repository root. Both read project
settings only from the directory they start in, so a session started in
`packages/<name>` runs with no guards, deny rules, or writing rules, and
Gemini also loses `AGENTS.md` and the skills. Claude Code still reads the root
`CLAUDE.md` from a subdirectory, so the rulebook looks active while the guards
are off; Codex reads `.codex/` from the project root down and is unaffected.

The Codex and Gemini registrations run `pnpm -w --silent run guards`, a
workspace-root script, so the command resolves from any subdirectory on Linux,
macOS, and Windows with no shell-specific syntax. `--silent` keeps pnpm's own
lines off stdout, which Gemini parses as JSON. Claude Code calls the
dispatcher directly with node through `${CLAUDE_PROJECT_DIR}`, braced because
Claude Code 2.1.198 and later rewrite only that spelling for PowerShell, which
reads a bare `$CLAUDE_PROJECT_DIR` as empty and would leave the hook failing
open.

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

Neither SessionStart entry carries a `matcher`, so each fires on every source
its tool has. Codex filters by source, so an entry that skipped `clear` or
`compact` would drop the rules after `/clear` or an automatic compaction.
Gemini matches lifecycle hooks by exact source name, so a regex such as
`startup|resume` never fires there. `pnpm test:hooks` checks both
registrations structurally.

Gemini's SessionStart sources are only startup, resume, and `/clear`, and it
ignores a PreCompress hook's output, so no hook can put the rules back after
chat compression. In a long Gemini session compression can summarize them
away; `/clear` loads them again.

## Nested rulebooks

Codex merges the `AGENTS.md` files from the project root down to the
directory it starts in. A nested file below that reaches the model only if the
model reads it; some of Codex's built-in model prompts tell it to when it
edits a file in that directory, and others do not.

Gemini loads a nested file when a tool first touches its directory. Claude
Code walks nested `CLAUDE.md` only, so a scoped rulebook needs the
`CLAUDE.md` pairing described in the Monorepo map of the root `AGENTS.md`.

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

The template gives Gemini no prompt-free list, so an interactive session asks
before every shell command outside its own built-in read-only set
(`git status` passes). Gemini's `tools.allowed` setting is deprecated, and any
`run_shell_command(...)` entry in it denies every command it does not list,
even in YOLO mode, so `pnpm test:hooks` fails if the key comes back. The
replacement, a policy file under `.gemini/policies/`, is ignored at the
workspace tier as of Gemini 0.60; a developer who wants fewer prompts adds
allow rules under `~/.gemini/policies/`.

A headless Gemini run (`gemini -p`) cannot ask, so it denies every shell
command, `git status` included, unless it is started with
`--approval-mode=yolo` or finds allow rules under `~/.gemini/policies/`. The
guards run before the approval check, so YOLO mode keeps them.

The template ships no Codex rules file either. In a trusted folder Codex's
default sandbox runs commands that write only ordinary workspace files without
a prompt. It asks before anything that needs the network (`git push`, `gh`,
`pnpm install`) or writes `.git/`, `.agents/`, or `.codex/`, which it keeps
read-only (`git commit`, `git switch`, `pnpm docs:gen`).

Codex does load a committed `.codex/rules/*.rules` once `.codex/` is trusted,
but rules are experimental and an `allow` rule runs the command outside the
sandbox, a wider grant than a Claude Code allow rule, so that choice stays in
each developer's `~/.codex/rules/`.
