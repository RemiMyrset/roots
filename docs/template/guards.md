# Agent guards

The threat model for the pre-tool guards under `.claude/hooks/`: what they catch,
what they deliberately do not, and the server-side boundaries behind them.
Template-owned and synced; the vulnerability reporting policy stays in this
repository's `SECURITY.md`.

## What the guards are and are not

The `.claude/hooks/` guards (`deny-non-pnpm`, `deny-build-scripts`,
`deny-secret-reads`, `deny-push-protected`, `deny-hook-bypass`) are **best-effort
footgun-preventers for a cooperative agent, not a sandbox.** They stop the common,
accidental ways an agent would run a banned package manager, enable a dependency
build script, read a secret file, push to a protected branch, or skip the git
hooks — mistakes worth catching before they happen. `dispatch.mts` is the one hook
registered, three times over: as a Claude Code PreToolUse hook
(`.claude/settings.json`), a Codex PreToolUse hook (`.codex/hooks.json`), and a
Gemini CLI BeforeTool hook (`.gemini/settings.json`). All three deliver the
command as `tool_input.command` and treat exit 2 with a reason on stderr as a
block, so the guards are shared verbatim; the fixture suite pipes each tool's
payload shape through the dispatcher. It runs every `deny-*.mts` in the
directory, and any non-zero exit denies the call; it also denies when the hook
input is not a payload with a string `tool_input.command` (malformed JSON, a
missing or null field) and when stdin never closes within five seconds. Node
builtins only, so they
work before `pnpm install` and in any repo they are synced into. Codex and Gemini
load project-level hook config only after the user trusts the folder (Codex also
asks to trust each hook via `/hooks`); their registrations run
`pnpm -w --silent run guards`, which works from any subdirectory on Linux,
macOS, and Windows. Neither reads the `env` block of `.claude/settings.json`, so
the push guard reads `PROTECTED_BRANCHES` from that file itself when the
variable is unset — one list for all three tools.

They are **not** a security boundary. A process actively trying to evade them
can run a nested interpreter (`sh -c '…'`), pipe through a decoder
(`base64 -d | sh`), write a script and execute it, or reach the same effect
through any of the unbounded ways a shell can spell a command. Deciding intent
from command text alone is undecidable, so the guards do not try. Out of scope
by design, for every guard: a nested interpreter (`sh -c`, `bash -c`,
`python -c`), ANSI-C escapes (`$'\x6e…'`), and unlisted wrapper words (the
`WRAP` allowlist in `_lexer.mts` cannot be exhaustive — proxychains, firejail,
setarch, …). Known over-block for every guard (safe direction, never a bypass):
backticks are read as command substitution, so a heredoc or commit message
quoting `` `npm install` `` in backticks is denied — write such text with a file
tool or from a terminal. **For real isolation, run the agent under OS-level
sandboxing** (a container, seccomp/AppArmor, a restricted `PATH`, or a VM); the
guards are defense-in-depth on top of that, never a replacement for it.

What they cover reliably is the direct and common wrapped forms: bare and
path-prefixed commands, standard wrappers (`sudo`, `env`, `nice`, `timeout`,
`flock`, `xargs`, …) with their ordinary flags, `pnpm exec` / `dlx` unwrapping,
`;` / `&&` / `|` / `$()` separators, and glued redirects. A regression suite
(`pnpm test:hooks`) pins every covered case so a fix for one form never silently
reopens another.

## Secret-file protection

Two layers keep secrets out of the agent. The `.claude/settings.json`
`permissions.deny` Read-tool list enumerates common `.env*` / `.envrc` /
`.netrc` / `.npmrc` / `secrets/` / `*.pem` / `*.key` / `*.p12` / `*.pfx` /
`*.jks` names, and the Bash-path guard `deny-secret-reads` covers the common
shell-read forms of the same set (`.env` and `.envrc` matched
case-insensitively; `.environment` is not matched) — direct readers, `<`
redirects (including `$(<file)` and `<>`), `pnpm exec` wrappers, and
`find -exec`. `.npmrc` is denied although a project copy is usually harmless: a
filename cannot prove it holds no `_authToken`, and `pnpm config list` shows
the effective config with tokens masked. `.gitignore` covers the same set
except `.npmrc`, which a project may legitimately commit with `${VAR}`
references (secretlint catches a literal token). `.env.example` is the one
carve-out; other placeholder spellings (`.env.sample`, `.env.dist`) fail closed
because a filename cannot prove it holds no secret. The guard is the broader of
the two (the Read list stays a curated subset so `.env.example` remains
openable); both are best-effort per the threat model above.

Beyond the shared out-of-scope list, this guard cannot catch a recursive walker
with no secret literal (`grep -r .`), a filename routed via xargs or a stdin
pipe, or a glob that expands to a secret without the `.env` prefix (`.e*`). The
backstop is `.gitignore`, the Read-tool deny list, and human review. Known
over-block (safe direction, never a bypass): a reader whose secret-looking token
is a search term or output prefix (`look .env`, `split in .env_`) is denied
although it reads no secret — rephrase or run it in a terminal.

## Secrets in commits

The deny rules above stop the agent from reading secret files; `secretlint`
stops a secret that is already in the working tree from reaching git.
`pnpm lint:secrets` scans every tracked file with the recommended preset (cloud
credentials, private keys, tokens; `.gitignore` is honoured), lint-staged runs
it on every staged file at commit time, and `pnpm verify` and CI run it after
ESLint. A finding is fixed by removing the secret and rotating it, never by
loosening `.secretlintrc.json`; a deliberate false positive in a test fixture
gets an inline `secretlint-disable` comment with a reason.

## Push protection

`deny-push-protected` keeps agents off protected branches. A branch is protected
when it matches a pattern in `PROTECTED_BRANCHES` (comma-separated globs, `*`
matches any run of characters, full match) from the `env` block of
`.claude/settings.json`; unset means `main`. A `git push` is denied when any
target is protected — the remote side of each refspec, the current branch when
no refspec is given, or `HEAD` — and when a target cannot be resolved (detached
HEAD, not a checkout). Also denied on any branch: bare `--force` / `-f` / a
`+refspec`, `--all` / `--branches` / `--mirror`, and any wildcard refspec
(`refs/heads/*`): the guard cannot evaluate a glob against the remote, so it
does not try. `--force-with-lease`,
`--delete`, and tag pushes pass on unprotected targets. `pnpm release` and
`changelogen --push` are denied outright: their push happens inside changelogen
where a `git push` rule cannot see it.

Out of scope, beyond the shared list: `cd elsewhere && git push` resolves the
current branch in the project directory, not the `cd` target, and the remote's
own default-branch name is never consulted — configure the list. The
server-side gate is a GitHub branch ruleset, created during first run once the
`ci` and `docs` checks have reported on `main` (the command is below); this
guard complements it and never replaces it. `.claude/settings.json` is not synced
into child repos, so a child sets its own `PROTECTED_BRANCHES` (and must drop
any old blanket `Bash(git push:*)` deny for branch pushes to work).

`git push` and the read-only `gh` commands (`pr create/view/list/checks/diff`,
`run list/view/watch`, `issue view/list`) are on the Claude Code allowlist, so a
feature-branch push and a PR creation run without a prompt. That convenience
rests on this guard — hooks run before allowed commands — and the guard's
out-of-scope list above (nested interpreters first) is why the server-side
ruleset is the boundary that matters. `gh pr merge` is deliberately not
allow-listed: merging into a protected branch always asks.

The ruleset, once `ci` and `docs` have reported on `main` at least once (a
required check that has never reported blocks every PR). The check names are the
matrix job names; free on public repositories, GitHub Pro on private ones:

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

`deny-hook-bypass` keeps the commit-time checks (commitlint, lint-staged,
`docs:portability`) in force. Denied: `--no-verify` (and its unique
abbreviations) on `git commit`, `git push`, and `git merge`; `-n` on
`git commit` (its `--no-verify` alias — `git push -n` is dry-run and passes); a
`core.hooksPath` override through `git -c` or `--config-env`; and the
`SKIP_SIMPLE_GIT_HOOKS`, `HUSKY=0`, and `HUSKY_SKIP_HOOKS` environment prefixes,
whether inline, via `env`, or as an `export` statement. Quoted mentions
(`-m "no --no-verify here"`) pass; a quote the heuristic cannot balance (closed
mid-token, or never) makes the whole command fail closed — every token is
scanned.

Out of scope, beyond the shared list: a `git config core.hooksPath` run as an
earlier command, editing `.git/hooks` directly, and uninstalling
`simple-git-hooks` — multi-step evasions the threat model already excludes. The
backstop is the same CI that the hooks pre-run locally.
