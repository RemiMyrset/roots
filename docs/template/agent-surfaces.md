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

A child may register hooks of its own in all three files. `pnpm test:hooks`
holds to the template's rules only the entries that run the dispatcher, the
`guards` script, or the `session` script, and fails when a file has none. It
holds a child's own hook to one rule: a Claude Code PreToolUse command must
brace `${CLAUDE_PROJECT_DIR}`, since PowerShell resolves the bare
`$CLAUDE_PROJECT_DIR` to nothing. It runs the dispatcher from a copy of
`.claude/hooks/` holding only the template's guards, so a `deny-*.mts` of the
child's own never fails it.

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

The Codex and Gemini registrations run the workspace-root script `guards`
through pnpm, so the command resolves from any subdirectory. Codex's
`command`, which it runs off Windows, is:

```text
sh -c 'pnpm -w --silent --config.verify-deps-before-run=false run guards || exit 2'
```

Gemini's `command` ends in an exit tail instead, and Codex's `commandWindows`
in a variant of it with no parenthesis (below):

```text
pnpm -w --silent --config.verify-deps-before-run=false run guards ; exit $((2*!!($true-$?)))
pnpm -w --silent --config.verify-deps-before-run=false run guards ; exit 2-2*$?
```

`--silent` keeps pnpm's own lines off stdout, which Gemini parses as JSON.
`--config.verify-deps-before-run=false` stops pnpm 11 from running
`pnpm install` first whenever the workspace state is missing or stale, as after
a fresh clone or a lockfile change. That install runs lifecycle scripts, can
outlast Gemini's 10-second hook timeout, and exits 1 when it fails; Gemini lets
the call through after either, and Codex after the exit 1.

Claude Code calls the dispatcher directly with node through
`${CLAUDE_PROJECT_DIR}`, braced because Claude Code 2.1.198 and later rewrite
only that spelling for PowerShell, which reads a bare `$CLAUDE_PROJECT_DIR` as
empty and would leave the hook failing open.

Claude Code and Codex block only on exit 2, and Gemini on any exit but 0 and 1,
so every guard command maps any other failure to 2. The script ends in
`|| exit 2`, which pnpm's shell emulator runs on every OS, for a dispatcher
that cannot start. Each registered command maps the failures around the script
too: pnpm's exit 1 when it fails before the script, and a shell's 127 when pnpm
is missing.

Codex's `command` hands sh a command that does that with `|| exit 2` and no
exit tail, so any shell that can run `sh -c '…'` runs it the same way: sh,
bash, zsh, and login shells such as fish, which cannot parse the tail, and
nushell, which has no `||`. The tail, `exit $((2*!!($true-$?)))`, reads as
arithmetic in bash and as a subexpression in PowerShell: 0 after a clean run,
2 after anything else.

PowerShell needs that tail even for an ordinary deny: it exits 1 whenever its
last command failed, whatever the code. `|| exit 2` cannot replace it there,
because PowerShell 7 runs an `exit` after `||` as a program name and Windows
PowerShell 5.1 has no `||`.

Codex's `commandWindows` ends in `exit 2-2*$?` instead, the same arithmetic
with no parenthesis. Under cmd.exe, pnpm's `pnpm.cmd` launcher expands its
arguments inside a parenthesized block, so a `)` in them ends the block early,
cmd exits 255, and every call passes.

Codex 0.154 runs a hook in the session's shell: sh, bash, or zsh with `-c` on
Linux and macOS, and PowerShell with `-NoProfile -Command` on Windows, where it
reads `commandWindows` in place of `command`. Gemini 0.60 runs `bash -c` on
Linux and macOS, and PowerShell on Windows with
`; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` appended, which the tail's
own `exit` never reaches. Both facts come from the tools' source; neither
tool has been run against these registrations on Windows.

Codex also has fallbacks, neither of which has been run. With no single local
environment it runs a hook through `%COMSPEC% /C` on Windows and `$SHELL -lc`
elsewhere, and on a Windows machine with no PowerShell it uses cmd.exe.

cmd.exe runs neither `;` nor the tail, and PowerShell as the login shell takes
no `-lc`: PowerShell 7.5 exits 64 without running the command.
[guards](./guards.md#registration) lists what fails open as a result.

The space before `;` keeps a deny working under cmd.exe. pnpm receives `;` and
the tail as extra words and passes them to the script after `|| exit 2`, where
they change nothing; written `guards;`, the word names no script, pnpm exits 1,
and every call passes.

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
session. Codex and Gemini run
`pnpm -w --silent --config.verify-deps-before-run=false run session` at
SessionStart, with the guards' no-install flag and no exit tail, and the
session hook `session-start.mts` prints the file, frontmatter stripped, as
`additionalContext`.

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

The Claude Code permission allowlist in `.claude/settings.json` lets the gate,
docs, sync, push, pull request, and CI commands run without a prompt, along
with common reads such as `git log` and `cat`. Claude Code also runs its own
built-in read-only set without a prompt, such as the read-only forms of `git`
(`git tag -l`) and `find` without `-exec` or `-delete`. Every other command
prompts, such as one that changes dependencies (`pnpm add`, `pnpm update`),
calls `gh api` or changes repository settings (`gh repo edit`), creates a
branch (`git switch -c`), or reads outside both sets (`pnpm outdated`), so some
steps of the pr, update-deps, new-package, first-run, and sync-template skills
ask.

The list is narrower than the read-only shape of a command suggests. `find` is
absent because `-delete` deletes and `-exec` runs a program, `rg` because
`--pre` runs a program, and `git switch` because `-f` and `--discard-changes`
drop uncommitted work and `-C` resets a branch; a `Bash(git switch -c:*)` rule
would still match `git switch -c x --discard-changes main`, which resets the
working tree to `main`. `git branch` is listed only in its listing forms, so
`git branch -d` prompts.

`git stash` is listed only as `git stash list`. Every linked worktree shares
one stash list, so a bare `git stash pop` in one worktree applies and drops the
newest entry, which may be another session's. Commit work in progress instead.

To recover a stashed entry, find its hash in
`git stash list --format="%h %gd %gs"` and run `git stash apply <hash>`:
another worktree's stash shifts `stash@{n}`, never the hash. The entry stays in
the list until `git stash drop stash@{n}` removes it, and `drop` refuses a
hash, so take `n` from a listing run just before.

The prefix rules the skills need still grant side effects no guard checks:
`git log`, `git diff`, and `git show` accept `--output=<file>`, which overwrites
the file; and `git fetch` accepts `--upload-pack`, which runs a program, and a
`+` refspec such as `+main:feat/x`, which resets a local branch.

Scripts with a colon in the name get one rule each (`Bash(pnpm test:hooks)`):
a trailing `:*` is a space-wildcard, so `Bash(pnpm test:*)` matches
`pnpm test --watch` and never `pnpm test:hooks`. `pnpm --filter <pkg> <script>`
prompts once per repository by design; a `--filter` rule wide enough to match
would also approve `pnpm --filter x exec`.

The settings file is the child's own, yet the synced `pnpm test:hooks` checks
it: beside the guards' hook registration and the home-directory deny rules, it
requires allow rules for `pnpm verify` and `pnpm docs:list`, the two commands
the docs send agents to most. Every other allow rule is the repository's choice.

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
