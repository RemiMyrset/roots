# Agent guards

This page is the threat model for the pre-tool guards under `.claude/hooks/`:
what they catch, what they deliberately do not, and the server-side boundaries
behind them. It is template-owned and synced. The vulnerability reporting policy
stays in this repository's `SECURITY.md`.

## Coverage

The `.claude/hooks/` guards (`deny-non-pnpm`, `deny-build-scripts`,
`deny-secret-reads`, `deny-push-protected`, `deny-hook-bypass`) are best-effort
footgun-preventers for a cooperative agent. They stop the common, accidental
ways an agent would run a banned package manager, enable a dependency build
script, read a secret file, push to a protected branch, or skip the git hooks.

What they cover reliably is the direct and common wrapped forms: bare and
path-prefixed commands, standard wrappers (`sudo`, `env`, `nice`, `timeout`,
`flock`, `xargs`, …) with their ordinary flags, `pnpm exec` / `dlx` / `x`
unwrapping, `;` / `&&` / `|` / `$()` separators, and glued redirects. A
regression suite (`pnpm test:hooks`) pins every covered case so a fix for one
form never silently reopens another.

## Registration

`dispatch.mts` is the one pre-tool hook, registered three times: as a Claude
Code PreToolUse hook (`.claude/settings.json`), a Codex PreToolUse hook
(`.codex/hooks.json`), and a Gemini CLI BeforeTool hook
(`.gemini/settings.json`). All three deliver the command as
`tool_input.command` and treat exit 2 with a reason on stderr as a block, so
the guards are shared verbatim; the fixture suite pipes each tool's payload
shape through the dispatcher.

The dispatcher runs every `deny-*.mts` in the directory, and any non-zero exit
denies the call. It also denies when the hook input is not a payload with a
string `tool_input.command` (malformed JSON, a missing or null field) and when
stdin never closes within five seconds. Node builtins only, so the guards work
before `pnpm install` and in any repo they are synced into.

Folder trust, the per-hook trust prompts, and the command each registration
runs are in [agent-surfaces](./agent-surfaces.md). `session-start.mts`, beside
the guards, is not a guard: it prints the writing rules at session start and
never blocks; the same page describes it.

## Limits

The guards are **not a security boundary**. A process trying to evade them can
run a nested interpreter (`sh -c '…'`), pipe through a decoder
(`base64 -d | sh`), write a script and execute it, or reach the same effect
through any of the unbounded ways a shell can spell a command. Deciding intent
from command text alone is undecidable, so the guards do not try.

Out of scope by design, for every guard: a nested interpreter (`sh -c`,
`bash -c`, `python -c`), ANSI-C escapes (`$'\x6e…'`), and unlisted wrapper words
(the `WRAP` allowlist in `_lexer.mts` cannot be exhaustive: proxychains,
firejail, setarch, …).

Known over-block for every guard (safe direction, never a bypass): backticks are
read as command substitution, so a heredoc or commit message quoting
`` `npm install` `` in backticks is denied. Write such text with a file tool or
from a terminal.

**For real isolation, run the agent under OS-level sandboxing** (a container,
seccomp/AppArmor, a restricted `PATH`, or a VM). The guards are
defense-in-depth on top of that, never a replacement for it.

## Secret-file protection

Two layers keep secrets out of the agent. The `.claude/settings.json`
`permissions.deny` Read-tool list enumerates common `.env*` / `.envrc` /
`.netrc` / `_netrc` / `.npmrc` / `secrets/` / `*.pem` / `*.key` / `*.p12` /
`*.pfx` / `*.jks` names. The Bash-path guard `deny-secret-reads` covers the
common shell-read forms of the same set (`.env` and `.envrc` matched
case-insensitively; `.environment` is not matched): direct readers, `<`
redirects (including `$(<file)` and `<>`), `pnpm exec` wrappers, and
`find -exec`.

The guard is the broader of the two; the Read list stays a curated subset so
`.env.example` remains openable. `.env.example` is the one carve-out; other
placeholder spellings (`.env.sample`, `.env.dist`) fail closed because a
filename cannot prove it holds no secret. Both layers are best-effort per the
threat model above.

`.npmrc` is denied: a filename cannot prove it holds no `_authToken`, and
`pnpm config list` shows the effective config with tokens masked. `.gitignore`
covers the same set except
`.npmrc`, which a project may legitimately commit with `${VAR}` references
(secretlint catches a literal token).

Beyond the shared out-of-scope list, this guard cannot catch a recursive walker
with no secret literal (`grep -r .`), a filename routed via xargs or a stdin
pipe, or a glob that expands to a secret without the `.env` prefix (`.e*`). The
backstop is `.gitignore`, the Read-tool deny list, and human review.

Known over-block (safe direction, never a bypass): a reader whose
secret-looking token is a search term or output prefix (`look .env`,
`split in .env_`) is denied although it reads no secret. Rephrase or run it in
a terminal.

## Secrets in commits

The deny rules above stop the agent from reading secret files; `secretlint`
stops a secret already in the working tree from reaching git.
`pnpm lint:secrets` scans every tracked file with the recommended preset (cloud
credentials, private keys, tokens; `.gitignore` is honoured), the pre-commit
hook runs it on every staged file ([Hook bypass](#hook-bypass) lists the
hooks), and `pnpm verify` and CI run it after ESLint. A finding is fixed by
removing the secret and rotating it, never by
loosening `.secretlintrc.json`; a deliberate false positive in a test fixture
gets an inline `secretlint-disable` comment with a reason.

## Push protection

`deny-push-protected` keeps agents off protected branches. A branch is
protected when it matches a pattern in `PROTECTED_BRANCHES` (comma-separated
globs, `*` matches any run of characters, full match); unset means `main`. The
guard reads the variable from the environment (Claude Code exports the `env`
block of `.claude/settings.json`) or, when unset, from that file itself, so
Codex and Gemini honour the same list with nothing to configure per tool.

A `git push` is denied when any target is protected (the remote side of each
refspec, the current branch when no refspec is given, or `HEAD`) and when a
target cannot be resolved (detached HEAD, not a checkout). Also denied on any
branch: bare `--force` / `-f` / a `+refspec`, `--all` / `--branches` /
`--mirror`, and any wildcard refspec (`refs/heads/*`), which the guard cannot
evaluate against the remote. `--force-with-lease`, `--delete`, and tag pushes
pass on unprotected targets.

`pnpm release` and `changelogen --push` are denied outright: their push happens
inside changelogen where a `git push` rule cannot see it.

Out of scope, beyond the shared list: `cd elsewhere && git push` resolves the
current branch in the project directory and ignores the `cd` target, and the
remote's own default-branch name is never consulted. Configure the list.

The server-side gate is a GitHub branch ruleset, created during first run with
the command below; this guard complements it and never replaces it.
`.claude/settings.json` is never synced, so a child sets its own
`PROTECTED_BRANCHES` in its `env` block when `main` is not the protected
branch, and drops any old blanket `Bash(git push:*)` deny so the guard can
allow feature-branch pushes.

The push-flow entries on the Claude Code allowlist let an agent push a branch
and open a PR without a prompt: `Bash(git push:*)`, `Bash(gh pr create:*)`,
`Bash(gh pr view:*)`, `Bash(gh pr list:*)`, `Bash(gh pr checks:*)`,
`Bash(gh pr diff:*)`, `Bash(gh run list:*)`, `Bash(gh run view:*)`,
`Bash(gh run watch:*)`, `Bash(gh issue view:*)`, `Bash(gh issue list:*)`. That
convenience rests on this guard (the guard runs before an allowed command), and
the out-of-scope list under [Limits](#limits) (nested interpreters first) is
why the server-side ruleset is the boundary that matters. `gh pr merge` stays off the
list: merging into a protected branch is a human decision and always asks.

Create the ruleset once `ci` and `docs` have reported on `main` at least once;
a required check that has never reported blocks every PR. The check names are
the matrix job names. The ruleset is free on public repositories and needs
GitHub Pro on private ones.

```sh
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [
        { "context": "ci (ubuntu-latest)" }, { "context": "ci (windows-latest)" },
        { "context": "docs (ubuntu-latest)" }, { "context": "docs (windows-latest)" }
      ] } }
  ]
}
JSON
```

## Hook bypass

The git hooks are installed by `scripts/prepare.mts` at `pnpm install` through
simple-git-hooks: pre-commit runs lint-staged (ESLint on staged TypeScript,
secretlint on every staged file) and then `pnpm docs:portability`; commit-msg
runs commitlint. `deny-hook-bypass` keeps them in force. It denies
`--no-verify` (and its unique abbreviations) on `git commit`, `git push`, and
`git merge`; `-n` on `git commit` (its `--no-verify` alias; `git push -n` is
dry-run and passes); a `core.hooksPath` override through `git -c` or
`--config-env`; and the `SKIP_SIMPLE_GIT_HOOKS`, `HUSKY=0`, and
`HUSKY_SKIP_HOOKS` environment prefixes, whether inline, via `env`, or as an
`export` statement.

Quoted mentions (`-m "no --no-verify here"`) pass. A quote the heuristic cannot
balance (closed mid-token, or never) makes the whole command fail closed; every
token is scanned.

Out of scope, beyond the shared list: a `git config core.hooksPath` run as an
earlier command, editing `.git/hooks` directly, and uninstalling
`simple-git-hooks`, all multi-step evasions the threat model already excludes.
The backstop is the same CI that the hooks pre-run locally.
