# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues or pull requests.

Use GitHub's **Report a vulnerability** button under this repository's **Security**
tab (Security Advisories → private vulnerability reporting). If that is
unavailable, contact a maintainer listed on the repository's About page or in the
commit history.

Include: what you found, steps to reproduce, affected version or commit, and the
impact you expect. We aim to acknowledge a report within a few business days and
will coordinate a fix and disclosure timeline with you.

## PreToolUse guards — what they are (and are not)

The `.claude/hooks/` PreToolUse guards (`deny-non-pnpm`, `deny-build-scripts`,
`deny-secret-reads`, `deny-push-protected`) are **best-effort footgun-preventers for a
cooperative agent, not a sandbox.** They stop the common, accidental ways an agent would run
a banned package manager, enable a dependency build script, read a secret file, or push to a
protected branch — mistakes worth catching before they happen. `dispatch.mts` is the one hook
registered, three times over: as a Claude Code PreToolUse hook (`.claude/settings.json`), a
Codex PreToolUse hook (`.codex/hooks.json`), and a Gemini CLI BeforeTool hook
(`.gemini/settings.json`). All three deliver the command as `tool_input.command` and treat
exit 2 with a reason on stderr as a block, so the guards are shared verbatim; the fixture
suite pipes each tool's payload shape through the dispatcher. It runs every `deny-*.mts` in
the directory, and any non-zero exit denies the call. Node builtins only, so they work before
`pnpm install` and in any repo they are synced into. Codex and Gemini load project-level hook
config only after the user trusts the folder (Codex also asks to trust each hook via
`/hooks`), and neither reads the `env` block of `.claude/settings.json`: to protect branches
other than `main` under those tools, prefix the registered command with
`PROTECTED_BRANCHES=...`.

They are **not** a security boundary. A process actively trying to evade them can run a
nested interpreter (`sh -c '…'`), pipe through a decoder (`base64 -d | sh`), write a script
and execute it, or reach the same effect through any of the unbounded ways a shell can spell
a command. Deciding intent from command text alone is undecidable, so the guards do not try.
Out of scope by design, for every guard: a nested interpreter (`sh -c`, `bash -c`,
`python -c`), ANSI-C escapes (`$'\x6e…'`), and unlisted wrapper words (the `WRAP` allowlist
in `_lexer.mts` cannot be exhaustive — proxychains, firejail, setarch, …). Known over-block
for every guard (safe direction, never a bypass): backticks are read as command substitution,
so a heredoc or commit message quoting `` `npm install` `` in backticks is denied — write
such text with a file tool or from a terminal. **For real isolation, run the agent under
OS-level sandboxing** (a container, seccomp/AppArmor, a restricted `PATH`, or a VM); the
guards are defense-in-depth on top of that, never a replacement for it.

What they cover reliably is the direct and common wrapped forms: bare and path-prefixed
commands, standard wrappers (`sudo`, `env`, `nice`, `timeout`, `flock`, `xargs`, …) with
their ordinary flags, `pnpm exec` / `dlx` unwrapping, `;` / `&&` / `|` / `$()` separators, and
glued redirects. A regression suite (`pnpm test:hooks`) pins every covered case so a fix for
one form never silently reopens another.

## Secret-file protection

Two layers keep secrets out of the agent. The `.claude/settings.json` `permissions.deny`
Read-tool list enumerates common `.env*` / `secrets/` / `*.pem` / `*.key` names, and the
Bash-path guard `deny-secret-reads` covers the common shell-read forms of an `.env` file
(and `.envrc`, matched case-insensitively; `.environment` is not matched), anything under
`secrets/`, and any `*.pem` / `*.key` — direct readers, `<` redirects (including `$(<file)`
and `<>`), `pnpm exec` wrappers, and `find -exec`. `.env.example` is the one carve-out; other
placeholder spellings (`.env.sample`, `.env.dist`) fail closed because a filename cannot
prove it holds no secret. The guard is the broader of the two (the Read list stays a curated
subset so `.env.example` remains openable); both are best-effort per the threat model above.

Beyond the shared out-of-scope list, this guard cannot catch a recursive walker with no
secret literal (`grep -r .`), a filename routed via xargs or a stdin pipe, or a glob that
expands to a secret without the `.env` prefix (`.e*`). The backstop is `.gitignore`, the
Read-tool deny list, and human review. Known over-block (safe direction, never a bypass): a
reader whose secret-looking token is a search term or output prefix (`look .env`,
`split in .env_`) is denied although it reads no secret — rephrase or run it in a terminal.

## Push protection

`deny-push-protected` keeps agents off protected branches. A branch is protected when it
matches a pattern in `PROTECTED_BRANCHES` (comma-separated globs, `*` matches any run of
characters, full match) from the `env` block of `.claude/settings.json`; unset means `main`.
A `git push` is denied when any target is protected — the remote side of each refspec, the
current branch when no refspec is given, or `HEAD` — and when a target cannot be resolved
(detached HEAD, not a checkout). Also denied on any branch: bare `--force` / `-f` / a
`+refspec`, and `--all` / `--branches` / `--mirror`. `--force-with-lease`, `--delete`, and
tag pushes pass on unprotected targets. `pnpm release` and `changelogen --push` are denied
outright: their push happens inside changelogen where a `git push` rule cannot see it.

Out of scope, beyond the shared list: `cd elsewhere && git push` resolves the current branch
in the project directory, not the `cd` target, and the remote's own default-branch name is
never consulted — configure the list. The server-side gate is a GitHub branch ruleset (on
init's checklist); this guard complements it and never replaces it. `.claude/settings.json`
is not synced into child repos, so a child sets its own `PROTECTED_BRANCHES` (and must drop
any old blanket `Bash(git push:*)` deny for branch pushes to work).

## Supported versions

This project tracks a single active line of development on the default branch.
Security fixes land there first; older tags are patched only when explicitly
noted in a release.
