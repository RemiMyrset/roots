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
path-prefixed commands in any case, with or without a Windows launcher suffix
(`npm.cmd`, `bash.exe`) or a version (`corepack yarn@1`), yarn's `yarnpkg`
alias, standard wrappers (`sudo`, `env`, `nice`, `timeout`, `flock`, `xargs`,
`mise x` / `mise exec`, …) with the short flags their GNU and BSD help lists,
`pnpm exec` / `dlx` / `x` unwrapping, pnpm's own `pn`, `pnx`, and `pnpx`,
`npx` and its flags (`npx -y pnpm approve-builds` runs pnpm), `;` / `&&` /
`|` / `$()` separators, glued redirects, and quoted paths with either separator
(`'C:\repo\.env'`). A regression suite (`pnpm test:hooks`) pins every covered
case so a fix for one form never silently reopens another.

A `command -v` presence probe (`command -v npm`) runs nothing and passes. Only
the shell's own `command` word counts: in `env -u command -v npm i` it is the
variable env unsets, so npm runs and is denied, and a path such as
`/usr/bin/command` is a program on disk, so the command after it is judged.

The shared lexer splits a command where bash does, and the push guard never
reads a redirection (`2>&1`, `> log`) as an argument. A word ends only at a
space, a tab, or a newline outside quotes and `${…}`, so a quoted or escaped
blank (`FOO="a b" npm i`, `a\ b`) and an expansion (`${x:-a b}`) stay inside
their word, and so does an operator in an expansion (`${x:-a;b}`). A process
substitution in an unquoted expansion still runs (`${x:-<(npm i)}`), and an
expansion still ends where bash ends the `$((…))`, `$[…]`, or backtick
substitution around it, since bash finds that end first
(`echo $((${x) a); npm i` runs npm): a backtick substitution ends at its first
unescaped backtick, whatever quote or substitution is open inside it.

Bash 3.2 (macOS `/bin/bash`) finds the end of a `$(…)`, `<(…)`, or `>(…)` the
same way, by counting parentheses, and the end of an assignment's subscript
(`a[…]=`) by counting brackets, past any `${` open inside, and it ends a
`${…}` at its `}` whatever `$(`, `<(`, or `$[` is open inside it. The guards
also judge a command that holds a `${` as bash 3.2 reads it, so
`echo $(${x) a; npm i`, which runs npm only there, is denied.

A `${` before a blank, a newline, or a `|` is a substitution instead:
`${ …; }` and `${| …; }` run their body as commands, as bash 5.3 and mksh do,
up to a `}` that bash reads as a reserved word: where a command starts, right
after a word that ends a compound command (a group's `}`, `fi`, `done`,
`esac`, `]]`: `${ if a; then b; fi }`), or glued to a group's `}` inside the
substitution (`${ { cmd; }}`). Bash before 5.3 (macOS `/bin/bash`, Git for
Windows, Ubuntu 24.04) reads `${ x }` as an expansion that ends at its `}`,
fails when it runs, and then runs the next line, so the guards judge each
reading and deny what any of them runs.

A word made only of unquoted substitutions and parameter expansions
(`$(true) npm i`, `$x npm i`) may expand to nothing, so the word after it is
judged as the command, and so is a name with one glued before it
(`$(true)npm i`, `${x}npm i`). For the same reason the secret guard reads one
glued into a file name as a glob that may match nothing (`.env$x` can name
`.env`), and the push guard judges a target without it too (`main${x}`).

A redirection operator standing alone before the command takes the next word
as its target (`> log npm i`), unless that word is a package manager.

An unquoted expansion with a default standing as the command runs that default
(`${x:-npm i}`, `${NPM:-npm} i`), and a pattern substitution runs its
replacement (`${x/a/npm i}`, `${x/a/npm} i`), so each is judged as the command.
What `eval` runs, at any depth of nesting, the string `env -S` splits into a
command, and the string a tool hands a shell are lexed again as commands of
their own: pnpm's shell mode (`pnpm exec -c '…'`, `pnpm -r -c exec '…'`,
`pnx -c '…'`), `flock FILE -c '…'`, `mise x -c '…'`, and `runuser -c '…'`.
`coproc` starts a command like the other reserved words.

Any other space-like byte (a no-break space, a form feed, a CR) stays inside
its word in bash, a heredoc delimiter included. The guards also read the whole
input with it as a blank and a CR as a line end, as PowerShell reads them, so
a CR also ends a `#` comment (`echo a #x<CR>npm i`), and deny what either
reading runs.

A line continuation (a backslash before a newline) joins its lines as bash
joins them, unquoted and inside double quotes, but never inside single quotes
or `$'…'`. That holds inside an operator (a `;;` split across two lines), on
the terminator line of a heredoc with an unquoted delimiter, and inside a
double-quoted delimiter (`<<"EO\<newline>F"` is `EOF`); a quoted delimiter
runs on across lines, as bash reads it. A backslash before a CR escapes only
the CR, so a CRLF line still ends its command.

Bash rejects an operator or a `(` inside an array (`x=((1))`, `x=(a;b)`) and,
unlike any other syntax error, drops only the rest of that line and runs the
next one. The guards also read the input with each such line dropped, so a
quote, a heredoc, or a line continuation on it cannot hide the next line
(`x=((1))\<newline>npm i` runs npm).

A `$()` or backtick substitution runs wherever bash runs it, inside double
quotes and in a heredoc with an unquoted delimiter (`<<EOF`) too, while
single-quoted text, a `#` comment, and a heredoc body are data, so a quote
inside them cannot hide a later line. A `#` opens a comment only where bash
reads one: at a line start, after a space, a tab, a `;`, `&`, or `|`, or a
subshell's closing `)` (`(cd x)#it's`), and never after another space-like
byte or inside `${…}` or a word's own parentheses (`@(#|a)`, `^(#|$)`,
`<(…)#x`, `x=(…)#y`). Inside `[[ … ]]` the guards read a `#` as text: bash
reads one at a word start as a comment, so the conditional never closes, bash
rejects the line, and nothing from it on runs. A function body and a case arm
start a command, as a new line does (`f() { …; }`, `case $1 in a) …;; esac`).
Inside backticks, the closing backtick ends a heredoc whose body has not
started, as bash ends it, so the line after it is a command (`` `cat <<E` ``).

A heredoc body a shell reads is lexed as commands: one whose pipeline reaches a
shell (`bash <<'EOF'`, `cat <<'EOF' | sh`), also on the line after the body
when a line ends in `|`, one in a group piped to a shell
(`{ cat <<'EOF' … } | bash`), one fed to `sudo -s`, `sudo -i`, `su`,
`busybox sh`, or a less common shell (`rbash`, `yash`, `tcsh`), and one in a
substitution a shell runs as its script, reads as a here-string, or runs under
`-c` or `eval` (`bash <(cat <<'EOF' …)`). A substitution passed to a script as
an argument (`bash x.sh "$(cat <<'EOF' …)"`) stays data.

## Registration

`dispatch.mts` is the one pre-tool hook, registered three times: as a Claude
Code PreToolUse hook for the Bash, PowerShell, and Monitor tools
(`.claude/settings.json`), a Codex PreToolUse hook (`.codex/hooks.json`), and a
Gemini CLI BeforeTool hook (`.gemini/settings.json`). Monitor is on the list
because it runs a shell command under the Bash allow rules. All three deliver
the command as `tool_input.command` and treat exit 2 with a reason on stderr as
a block, so the guards are shared verbatim; the fixture suite pipes each tool's
payload shape through the dispatcher and runs each registration's command the
way its tool does.

The dispatcher imports every `deny-*.mts` in the directory and runs its
`verdict(cmd, ctx)` in the same process; the first reason returned denies the
call, and a guard that throws or exports no verdict denies too. It also denies
when the hook input is not a payload with a string `tool_input.command`
(malformed JSON, a missing or null field) and when stdin never closes within
five seconds. A dispatcher that cannot start (node missing or too old to run
`.mts`, a file that fails to load) denies as well, and so does a pnpm that
fails or is missing under Codex or Gemini, whose registrations run through it:
each registration maps any failure to exit 2
([agent-surfaces](./agent-surfaces.md#trust-and-registration) shows how). A
pnpm whose version differs from the `packageManager` pin and that cannot fetch
the pinned one exits 1, which each registration maps to a deny, but only after
pnpm's fetch retries, about 70 seconds per call offline. Codex then denies the
call with pnpm's error as the reason; Gemini has run it by then (below).

Three cases still fail open. Under Codex, a fallback to cmd.exe on Windows lets
the call through when pnpm fails or is missing, and a fallback to `$SHELL -lc`
lets every call through when the login shell is PowerShell, which takes no
`-lc`. Gemini runs the call when a hook outlasts its 10-second timeout; the
registrations stop pnpm from installing first, but the offline fetch of a
pinned pnpm above still outlasts it.

The one shape without a command that passes is a Monitor call that opens a
WebSocket (`tool_input.ws`), which runs no shell and has its own approval
prompt. One process, not one per guard, keeps a shell call's overhead near
node's own startup. Node builtins only, so the guards work before
`pnpm install` and in any repo they are synced into.

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
`bash -c`, `python -c`, `npx -c`), ANSI-C escapes (`$'\x6e…'`), and unlisted
wrapper words (the `WRAP` allowlist in `_lexer.mts` cannot be exhaustive:
proxychains, firejail, setarch, …). `mise x` and `mise exec` are listed with
their value flags; `mise run` executes a task defined in a mise config, so it
is a nested interpreter for this purpose. Claude Code on Windows registers the
guards for its PowerShell tool as well as Bash; the lexer is bash-shaped, so
PowerShell spellings are covered only where they coincide (`npm install`,
`cat .env`, `git push origin main`).

Also out of scope: long or clustered wrapper flags (`sudo --user root`,
`env --chdir /x`, `sudo -iu root`), a long or multi-letter npm config flag that
npx reads with a separate value (`npx --registry URL …`, `npx -reg URL …`), an
implicit push target git resolves in
another checkout or under another name (`git -C`, `--git-dir`, Gemini's
`dir_path`, `push.default=upstream`), a hooks path set through `GIT_CONFIG_*`
variables, a variable's value as or before the command (`$x i`, `$x"npm" i`),
and Gemini's own file tools (`read_file`, `grep_search`), which run
no shell command and have no Read deny list.

Known over-block for every guard (safe direction, never a bypass): a heredoc
fed to a shell that runs a script file (`bash x.sh <<'EOF'`) has its body
lexed as commands, although the script reads it as input, and the string
`env -S` splits is lexed as shell input, so a `;` in it separates commands
although env passes it on as text. Backticks inside
double quotes are not an over-block: bash runs them, so
`` -m "never run `npm install`" `` is denied because it would run npm. Quote
such text in single quotes or a quoted heredoc (`<<'EOF'`), which bash never
expands.

**For real isolation, run the agent under OS-level sandboxing** (a container,
seccomp/AppArmor, a restricted `PATH`, or a VM). The guards are
defense-in-depth on top of that, never a replacement for it.

## Secret-file protection

Two layers keep secrets out of the agent: the Read-tool deny list in Claude
Code, and the shell guard in all three tools. The `.claude/settings.json`
`permissions.deny` Read-tool list enumerates common `.env*` / `.envrc` /
`.netrc` / `_netrc` / `.npmrc` / `secrets/` / `*.pem` / `*.key` / `*.p12` /
`*.pfx` / `*.jks` names, plus the credentials a developer machine holds outside
any repo: SSH private keys (`.ssh/id_*`), `.aws/credentials`,
`.config/gh/hosts.yml`, `.git-credentials`, `.kube/config`,
`.docker/config.json`, and `.pgpass`. Those, `.netrc`, `_netrc`, and `.npmrc`
are listed twice, as `Read(**/…)` for a copy under the project and `Read(~/…)`
for the real file: a `**/` rule anchors at the working directory and never
reaches the home directory. The Bash-path guard `deny-secret-reads`
covers the common shell-read forms of the same set (`.env` and `.envrc` matched
case-insensitively; `.environment` is not matched; an SSH key's `.pub` half is
readable; `credentials`, `config`, and `hosts.yml` count only under their
credential directory): direct readers, `<` redirects (including `$(<file)` and
`<>`), `pnpm exec` wrappers, and a glob that can expand to one of those names
(`.env*`, `~/.ssh/*`, `secret?/api.txt`, `?ecrets/api.txt`, `certs/*.pe?`).
A glob counts only where bash expands it: a quoted or escaped `*`, `?`, or `[`
is text, so a search pattern such as `grep "import .* from"` passes. `find -exec` and `-ok` are denied when a word
names a secret or a `-name` or `-path` pattern can match one, quoted or not,
because find matches it itself. A pattern whose matches can never reach the
`-exec` passes: a negated one (`-not -path '*/.*'`), or a pruned one with
nothing else in its branch (`-path '*/.*' -prune -o`). A pruned one beside
another test (`-name '.env*' -type d -prune -o`) is denied, because a match
that fails the other test falls through to the `-exec`.

The guard is the broader of the two; the Read list stays a curated subset so
`.env.example` remains openable. `.env.example` is the one carve-out; other
placeholder spellings (`.env.sample`, `.env.dist`) fail closed because a
filename cannot prove it holds no secret. Both layers are best-effort per the
threat model above.

`.npmrc` is denied: a filename cannot prove it holds no `_authToken`, and
`pnpm config list` shows the effective config with tokens masked. `.gitignore`
covers the repo-shaped subset of the set (env files, keystores, `secrets/`,
`.git-credentials`, `.pgpass`, the bare SSH key names) except `.npmrc`, which a
project may legitimately commit with `${VAR}` references (secretlint catches a
literal token); the other machine-credential files live outside any repository
and are covered by the guard and the Read list only.

Beyond the shared out-of-scope list, this guard cannot catch a recursive walker
with no secret literal (`grep -r .`), a filename routed via xargs or a stdin
pipe, or a glob that opens with a wildcard outside a credential directory
(`*rc`) or stops short of a key extension (`key.*`). The backstop is
`.gitignore`, the Read-tool deny list, and human review.

Known over-block (safe direction, never a bypass): a reader whose
secret-looking token is a search term or output prefix (`look .env`,
`split in .env_`) is denied although it reads no secret. `find` pointed at a
secret with `-exec` is denied whatever program it runs (`-exec ls`), because
`-exec sh -c …` can read what it is handed. Rephrase or run it in a terminal.

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
refspec, `heads/main` and `refs/heads/main` counting as `main`, or the current
branch when no refspec is given or the target is `HEAD`, `@`, or a lone
substitution such as `"$(git branch --show-current)"`) and when a target cannot
be resolved (detached HEAD, not a checkout, a substitution inside a longer
name). Also denied on any branch: bare `--force` / `-f` / a `+refspec`,
`--all` / `--branches` / `--mirror` and the unique prefixes git accepts for
them (`--al`, `--mirr`), and any wildcard refspec (`refs/heads/*`), which the
guard cannot evaluate against the remote. `--force-with-lease`, `--delete`, and
tag pushes pass on unprotected targets.

`pnpm release` and `changelogen --push` are denied outright: their push happens
inside changelogen where a `git push` rule cannot see it.

The remote must be a configured name (`origin`, `upstream`): a URL or a path in
its place is denied, because pushing there sidesteps the remotes the list is
written for.

Out of scope, beyond the shared list: `cd elsewhere && git push` resolves the
current branch in the project directory and ignores the `cd` target, a lone
substitution is taken for the current branch whatever it prints, and the
remote's own default-branch name is never consulted. Configure the list.

The server-side gate is a GitHub branch ruleset, created during first run with
the command below; this guard complements it and never replaces it.
`.claude/settings.json` is never synced, so a child sets its own
`PROTECTED_BRANCHES` in its `env` block when `main` is not the protected
branch, and drops any old blanket `Bash(git push:*)` deny so the guard can
allow feature-branch pushes.

The push-flow entries on the Claude Code allowlist let an agent push a branch
and open a PR without a prompt: `Bash(git push:*)`, `Bash(git fetch:*)`,
`Bash(gh auth status)`, `Bash(gh repo view:*)`, `Bash(gh pr create:*)`,
`Bash(gh pr view:*)`, `Bash(gh pr list:*)`, `Bash(gh pr checks:*)`,
`Bash(gh pr diff:*)`, `Bash(gh run list:*)`, `Bash(gh run view:*)`,
`Bash(gh run watch:*)`, `Bash(gh issue view:*)`, `Bash(gh issue list:*)`;
Codex and Gemini prompt for them
([agent-surfaces](./agent-surfaces.md#permission-prompts) says why). That
convenience rests on this guard (the guard runs before an allowed command), and
the out-of-scope list under [Limits](#limits) (nested interpreters first) is
why the server-side ruleset is the boundary that matters. `gh pr merge` stays off the
list: merging into a protected branch is a human decision and always asks.

Create the ruleset once `ci` and `docs` have reported on `main` at least once;
a required check that has never reported blocks every PR. The check names are
the matrix job names. The ruleset is free on public repositories and needs
GitHub Pro on private ones. Repository admins bypass it: the release script
pushes the release commit and tag straight to `main`, and a required check can
never have reported on a commit that does not exist yet. Agents on an admin's
machine are still stopped by this guard, and every PR still needs green
checks. Drop the `bypass_actors` line to make releases go through a temporary
ruleset change instead.

```sh
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
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

That ruleset stops deletions, force pushes, and unchecked commits; it does not
require a pull request, so a direct push with green checks is still legal.
That fits a single admin. With more than one committer, add a `pull_request`
rule so `main` changes only through a PR on the server side too, with as many
reviews as the team wants (zero keeps CODEOWNERS advisory, one makes it
binding); the admin bypass above still lets a human release:

```json
{
  "type": "pull_request",
  "parameters": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews_on_push": true,
    "require_code_owner_review": true,
    "require_last_push_approval": false,
    "required_review_thread_resolution": true
  }
}
```

## Build scripts

`deny-build-scripts` keeps dependency build scripts off, as the AGENTS.md rule
on `allowBuilds` requires. Wherever pnpm is a command word, `pnpm dlx` and
`pnpm exec` lines, the `pn`, `pnx`, and `pnpx` shorthands, and pnpm run
through `npx` included, directly or through a wrapper npx runs
(`npx corepack pnpm approve-builds`), it denies `approve-builds` and
`--allow-build`. It
also denies a setting that allows builds (`allowBuilds`,
`onlyBuiltDependencies`, `dangerouslyAllowAllBuilds`) where it is set: as a
flag (`--config.allowBuilds=…`) or after `pnpm config set` or `pnpm set`.
Reading one passes (`pnpm config get allowBuilds`, `pnpm exec grep allowBuilds`).
A `pnpm_config_*` variable that allows builds is denied when it is assigned,
inline or on its own line, and when it is exported (`export`, `declare -x`).

Out of scope, beyond the shared list: an edit to `pnpm-workspace.yaml` through
a file tool, which runs no shell command. Review catches it.

## Hook bypass

The git hooks are installed by `scripts/prepare.mts` at `pnpm install` through
simple-git-hooks, in the main checkout only: a linked worktree shares its
hooks. Pre-commit runs lint-staged: ESLint with `--fix` on staged TypeScript
and JavaScript, ESLint without it on staged JSON and YAML (the pnpm catalog
fix would write an unstaged `pnpm-workspace.yaml`, so the rule fails the
commit and `pnpm lint:fix` then `pnpm install` repair it), the portability
checker when a markdown file is staged, and secretlint on every staged file.
It runs with `CI=1` so the antfu config lints the same way it does in CI
rather than in editor mode; commit-msg runs commitlint. `deny-hook-bypass` keeps them in force. It denies
`--no-verify` (and its unique abbreviations) on `git commit`, `git push`, and
`git merge`; `-n` on `git commit` (its `--no-verify` alias; `git push -n` is
dry-run and passes); a `core.hooksPath` override through `git -c` or
`--config-env`; and the `SKIP_SIMPLE_GIT_HOOKS`, `HUSKY=0`, and
`HUSKY_SKIP_HOOKS` environment prefixes, whether inline, via `env`, or
exported (`export`, `declare -x`).

Quoted mentions (`-m "no --no-verify here"`) pass: words split where bash
splits them, so a quoted message is one word, and a quote closed mid-word keeps
its word whole (`-m "fix bug"s --no-verify` is denied). After a quote that
never closes, the rest of the command splits at any whitespace, so every word
from there on is scanned (fail closed).

Out of scope, beyond the shared list: a `git config core.hooksPath` run as an
earlier command, editing `.git/hooks` directly, and uninstalling
`simple-git-hooks`, all multi-step evasions the threat model already excludes.
The backstop is the same CI that the hooks pre-run locally.
