# Template sync

- **Source:** `scripts/sync-template.mts`
- **Tests:** `scripts/test-sync.mts` — `pnpm test:sync`
- **Last reviewed:** 2026-09-29

The contract for `pnpm sync:template`. The tests pin behaviors 1 to 27; the
per-file-error branch of behavior 23 is untested. The user-facing recipe is the
[Recipe](#recipe) section below.

## Purpose

Bring the template's shared mechanics into a repository made from it, safely
enough for an agent to run it unattended. The repository may come from **Use
this template** (no shared git history), a fork or clone (shared history), or
predate the template. Safe means: stage rather than commit, refuse to clobber,
work out where the repository branched off, record where it is now, and say
what a file copy cannot carry: template commits since; the `package.json`
entries and `pnpm-workspace.yaml` settings the synced gates rely on that now
differ; the files the template added outside the synced paths; and
the `.claude/settings.json` rules, hooks, and output style the template has
and this repository lacks.

## Non-goals

- Never edits a path outside the synced ones, such as `package.json`,
  `pnpm-workspace.yaml`, `.claude/settings.json`, `docs/internal/`,
  `docs/public/`, `src/`, `packages/`, or `apps/`. The follow-ups report what
  the synced paths need from the first three and the files the template adds
  outside its content; the rest is the repository's own.
- Takes the template's version of each synced path wholesale;
  review-and-discard is the merge.
- No push-based or scheduled sync, no tokens, no bots.
- Never runs inside the template itself.

## Recipe

The sync works the same for a repository made with **Use this template**,
forked or cloned from roots, or older than roots. There is no bot, cron, or
token:

```sh
pnpm sync:template                # URL and ref from .template-sync.json, else the defaults
pnpm sync:template <fork-url>     # or point at your own fork (recorded for next time)
pnpm sync:template --ref <name>   # pin a template branch or tag (recorded for next time)
```

Nothing is committed. Review with `git diff --cached`, keep what applies, and
discard the rest with `git restore --staged --worktree <path>`. Apply each
`BREAKING CHANGE` footer by hand (it names an edit outside the synced paths)
and the printed follow-ups, then run the done gate and commit
`.template-sync.json` with the rest.

The template also ships files it never syncs: `package.json`,
`.claude/settings.json`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`,
`.devcontainer/devcontainer.json`, `.gitignore`, `eslint.config.ts`,
`turbo.json`, and every other path outside the synced list. The sync never
copies them, so a template commit that changes one carries a `BREAKING CHANGE`
footer naming the edit, marked optional when a child may skip it.

The synced paths, grouped: the CI, docs, labels, labeler, and Pages workflows
with the label list and the path-label map, the agent-task issue template, and
the PR template; the docs generators and checkers, the verify gate, the
git-hook installer, the four test suites, and the sync script itself; the
guards, rules, skills, and writing rules under `.claude/`, the Codex and Gemini
registrations, and the generated `.agents/` mirror; and `docs/template/`. The
exact list is `MECHANICS` in the script.

The synced scripts are `.mts` on purpose. `.mts` runs as ESM whatever the
repository's `package.json` `"type"` says, whereas a `.ts` file is read as
CommonJS in a repo that sets `"type": "commonjs"`, which breaks its
`import`/`export`.

`.template-sync.json` customizes the sync. List a synced path under `exclude`
to stop pulling it (say `.gemini/settings.json` once you have local Gemini
settings), or an extra path under `include` (for example `tsconfig.base.json`
or `eslint.config.ts`) to pull it too. You can write the file by hand before
the first sync and commit it; the sync fills in `commit`. An uncommitted state
file is refused like any other change (behavior 7), and a stashed one takes
its lists with it. Never edit `MECHANICS` in the script itself: the script is
synced, and the edit would be staged for revert on the next run.

An organization that keeps its own fork of roots as its template syncs the
fork from roots, and a repository made from the fork syncs from the fork. The
fork's state file comes with the repository's first commit and names the fork
as the repository that wrote it (`repo`), so the first sync there takes the
fork as the template (behavior 25). Pass a URL to sync from another one.

A repo that predates the script, or holds an older copy that never recorded a
sync point, bootstraps with plain git, so a private fork works with whatever
auth git already has. Overwrite an older copy; behavior 7 says why. In Claude
Code the `sync-template` skill drives the whole flow.

```sh
mkdir -p scripts && git fetch --no-tags https://github.com/RemiMyrset/roots.git main && git show FETCH_HEAD:scripts/sync-template.mts > scripts/sync-template.mts && node scripts/sync-template.mts
```

Sync stages deletions only inside the synced paths, and only for files the
template shipped and has since retired: one in its tree at the sync point, or
a byte-identical copy of a version it shipped at that path, however the copy
got here. An artifact the template retired elsewhere (a doc, a config line)
stays behind as an orphan; the breaking-commit footer names it, so sweep it by
hand.

A file of your own under a synced directory (say `.claude/skills/my-skill/`,
a path-scoped rule, or a `deny-*.mts` guard) stays; at a path the template
ships, the template's version replaces it (an `M` line), so discard that path.
A file at a path the template once shipped that matches none of its versions
stays too, listed under `Kept`: it is yours, or a template file you edited;
`git rm` the template's. Behavior 24 has the rule.

## Contract

Invocation is `node scripts/sync-template.mts [git-url] [--ref <ref>]`
(`--ref=<ref>` also works), as `pnpm sync:template`. It runs from any
directory inside the repository and changes to the git top level first. Any
other option, or a second bare argument, is refused.

The template URL is the first match of: the argument; `url` in
`.template-sync.json`; the existing `template` remote; the built-in roots URL.
The argument must match `^[\w@:/.+~%-]+$` and not start with `-`.

A state file is inherited when it came with the repository rather than from a
sync here: it records a `commit`, the one commit that wrote it is a root
commit, it has no change in the index or the worktree, and the `repo` it names
is not this repository's `origin` (compared by host and path), or it names
none. A shallow clone never inherits: git cuts the parents off its oldest
commits, so a root commit there may not be one. An inherited file's `commit`
is dropped, so the run is a first sync, and a warning on stderr says so.

When an inherited file names a `repo`, that URL replaces its `url`, and its
`ref`, `exclude`, and `include` are dropped too: they configured the writer's
own sync. When it names none, its `url`, `ref`, and lists stay, and the
warning says to pass the template's URL.

The ref is the first match of: `--ref`; `ref` in the state file; `main`. It
must match `^\w[\w./+-]*$` and contain no `..`. The `template` remote is
always set to the resolved URL with tags disabled.

The ref is fetched as a branch first (into `refs/remotes/template/<ref>`),
then as a tag (into `refs/template-tags/<ref>`, never `refs/tags/`, so
changelogen in this repository cannot see template tags). A name that is both
resolves as the branch.

The synced paths are the `MECHANICS` list in the script, minus `exclude`, plus
`include` from the state file. An `exclude` entry matches a whole `MECHANICS`
entry, never a file inside one, and one that matches none draws a warning on
stderr; an `include` entry already in the list is ignored. Entries are files
or directories, and a directory means every tracked file under it. Entries
are literal repo-relative paths with forward slashes: a glob character (`*`,
`?`), a leading `:` (pathspec magic), an absolute path, or an empty, `.`, or
`..` segment is refused, and a trailing `/` is dropped. Every git call reads
its paths literally (`GIT_LITERAL_PATHSPECS=1`), so `x[1].md` names that file
only. `.agents/skills` is a generated copy of `.claude/skills` (no symlinks
anywhere), so it syncs as plain files.

A tracked file under a synced path that the template head does not ship is
retired, and staged for deletion, only when it is the template's: it is in the
tree at an exact sync point, or its content is byte-identical to a version the
template shipped at that path. An exact sync point is the recorded commit,
fetched by its hash when this clone lacks it (a fresh clone syncing back to an
older ref), or a `shared history` or `root tree` baseline; with a `root time`
baseline, which is approximate, with none, or when the template no longer has
the recorded commit (a force-push, or a URL for another fork), the content
test is the only one. The content test reads the template head's history and
the sync point's, so it also catches a copy that got here another way (an
older copy of the script that recorded no sync point, a sync while the path
was excluded).

A file that stays is listed under `Kept` when it may still be the template's:
at a path the template once shipped (a copy edited here, or a file of the
repository's own that reuses the path), or at any path when the recorded
commit is lost, since the template may have shipped it only in the history it
lost. Any other file is the repository's own and is never touched or
mentioned.

The state file `.template-sync.json` at the repo root is written with LF and
staged whenever it changes:

```json
{
  "$comment": "...",
  "url": "https://github.com/RemiMyrset/roots.git",
  "ref": "<branch or tag; absent means main>",
  "commit": "<40 hex, the template commit whose mechanics are staged>",
  "repo": "<this repository's origin URL>",
  "exclude": ["<synced path to skip>"],
  "include": ["<extra path to pull>"]
}
```

`ref` is optional, written only when a ref other than `main` is tracked;
`--ref main` unpins. `exclude` and `include` are optional and preserved across
rewrites. `commit` always records the fetched template head, never an inferred
baseline.

`repo` is taken from `origin` the first time the file is written where one
exists, with the user and token of an `http(s)` URL dropped, and is kept after
that, so a contributor whose `origin` is a fork never changes it; a file that
lacks it is rewritten to add it. The run that writes it first says so in its
report, since that `origin` may itself be a personal fork or a mirror. Correct
it by hand then, or if the repository moves. It must match the same pattern as
`url`.

A missing state file, or one without `commit`, means a first sync; a file
holding only `url`, `ref`, `exclude`, or `include` is a configuration written
before the first sync, and all of it applies. A leading byte-order mark is
ignored, here and in `package.json` and `.claude/settings.json`. An invalid
`commit` produces a warning on stderr, is treated as a first sync with the
other fields kept, and is rewritten. Anything else invalid (not a JSON object,
a bad `url` or `ref`, an `exclude` or `include` that is not an array of valid
entries) stops the run: dropping the field would switch the template or ref,
or overwrite an excluded path.

The baseline for a first sync (no recorded commit) is the first match of: the
merge-base of `HEAD` and the template head when history is shared; else the
template commit whose tree the repository's root commit carries verbatim (a
"Use this template" copy); else the template commit at the root commit's time,
accepted only when at least one synced path is identical between the two; else
none. Later syncs use the recorded commit.

Exit `0` means the sync staged changes or was already up to date. Exit `1`
means one of: not inside a git repository; an invalid state file; an unknown
option or a second bare argument; a refused URL or ref; the repository's
`origin` is the template URL; a synced path has uncommitted changes; the ref
cannot be fetched as a branch or a tag; none of the synced paths exist on the
template; no synced path could be checked out. On exit `1` the state file is
untouched, the script stages nothing further, and the failure is printed on
stderr with a leading `✖`. The `template` remote may already be set, since it
is added before the fetch.

A skipped path is in one of two states. When git aborted (a required filter
failed), the file being written is gone, the files git wrote earlier in the
same directory stay in the worktree unstaged (new ones untracked), and nothing
is staged. When git reported a per-file error and went on (a locked or
read-only file), the path is staged from the template while the file keeps its
old bytes. When every checkout fails, the files the template retired are
already staged for deletion. `git restore --staged --worktree -- <path>`
returns the staged and modified files to HEAD; an untracked leftover needs
`git clean -n -- <path>` first, then the same command without `-n`. The next
sync's dirty check refuses untracked files under the synced paths.

stdout, in order:

1. `Template: <url>`.
2. `Fetched template/<ref> at <sha>` (`Fetched template/<ref> (tag) at <sha>`
   when pinned to a tag), ending in one of "first sync", "unchanged since last
   sync", "N commits since last sync" followed by the commit list, "is ahead of
   it" (the recorded commit is newer than the ref being synced to), or "not in
   its history".
3. On a first sync, exactly one `Baseline:` line: `<sha> (shared history)`,
   `<sha> (root tree)`, `<sha> (root time)`, or `none`, each with a note; then
   `No template commits since the baseline.` or "N commits since the baseline"
   followed by the commit list.
4. Either `Already up to date — nothing staged.` or a `Staged` header followed
   by one line per staged entry: the status letter (`M`, `A`, `D`; rename
   detection is off, so a rename is a `D` and an `A`), two spaces, the path,
   and for the script itself the suffix
   `(this script — the new version runs next time)`. Then, only when this run
   records `repo` for the first time, a `Recorded this repository as <url>`
   line. Then, only when a checkout
   failed, a `Skipped` header with one `<path>  <reason>` line each, and only
   when a file that may be the template's stays, a `Kept` header with one line
   per such file (behavior 24).
5. `Follow-ups: none new.`, `Follow-ups: skipped` with a reason, or a
   `Follow-ups` header followed by one block per `package.json` entry (the
   `<block>.<key>`, its label, `template:`, `yours:`, and an optional `note:`
   line), then an optional `Customized locally` line. The entries are
   `packageManager`, then the blocks `scripts`, `devDependencies`,
   `simple-git-hooks`, `lint-staged`, `commitlint`, and `engines`, in that
   order; a value that is not a string prints as its JSON text. Labels say
   "since the baseline" on a first sync and "since last sync" afterwards.
   Then the same for the top-level settings of `pnpm-workspace.yaml` under
   `Workspace`, in file order: a scalar as its key (`minimumReleaseAge`), a
   map entry as `<key>.<name>` (`catalog.vite`, `allowBuilds.esbuild`), and a
   list item as `<key>.<item>` with the value `- <item>`
   (`trustPolicyExclude.vite@5.4.21`). Then `Files: none new.`, `Files: skipped` with a
   reason, or a `Files` header followed by one `<path>  missing here` line per
   file the template added since the sync point outside the synced paths and
   `docs/internal/`, `docs/public/`, `src/`, `packages/`, and `apps/`, each
   with a `git restore --source=<sha> -- <path>` line that fetches it. Then
   `Settings: none new.`,
   `Settings: skipped` with a reason, or a `Settings` header followed by one
   `<rule>  missing here` line per `permissions.allow` or `permissions.deny`
   entry the template has and this repository lacks, an
   `outputStyle <name>  missing here` line when the template sets an output
   style and this repository sets none, and one block per template hook
   registration (event, matcher, command) this repository lacks. The block
   opens with `hooks.<event>  differs` when it replaced a registration here
   (behavior 14), else `hooks.<event>  missing here`, then a `template:` line
   and one `yours:` line per replaced registration, each reading
   `matcher <matcher>, command <command>`.
6. A `Next:` block with the review, discard, and commit commands, only when
   something is staged.

Commit lines are `  ! <sha> <subject>` for breaking commits and
`    <sha> <subject>` otherwise, newest first, merge commits left out unless
breaking, with the `BREAKING CHANGE` paragraph indented beneath its commit.
The count leaves out the same merges and says how many (`; N merges left
out`), since the full log lists them.
The cap is 40 non-breaking commits: every breaking commit is listed, and when
any are hidden the list ends with `… and N more, none breaking`. Every list
ends with `Full log: git log <from>..<head>`. Warnings and errors go to
stderr.

## Behavior

1. Given a working directory outside any git repository, when run, then exit `1`
   and stderr contains "Not a git repository".
2. Given no state file, when run with a template URL, then the `template`
   remote exists with `tagOpt --no-tags`, the template's version of every
   synced path is staged, tracked files under a synced path that the template
   retired (behavior 24; a file inside a path or a whole path) are staged for
   deletion, files outside the synced paths are untouched, the state file is
   written with that URL and the template head and is staged, stdout says
   "first sync", and no template tag exists locally.
3. Given the recorded commit equals the template head and every synced file
   already matches, when run, then nothing is staged and stdout says "unchanged
   since last sync" and "Already up to date".
4. Given template commits after the recorded one, when run, then stdout counts
   them, lists them newest first with `!` on commits whose subject carries `!`
   or whose body has a `BREAKING CHANGE` footer, prints that footer's paragraph
   beneath the commit, and the state advances to the template head. A merge
   commit is listed and counted only when it is breaking, and the count says
   how many merges it left out. Past 40 non-breaking
   commits the rest are counted, not listed, while every breaking commit is
   still listed with its footer.
5. Given a recorded commit that is neither an ancestor nor a descendant of the
   template head, when run, then stdout says the sync point is "not in its
   history", no commit list is printed, script follow-ups are computed
   two-way, and the state is rewritten to the template head. stdout says the
   staged diff is complete, or, when git cannot fetch the recorded commit,
   that the files it cannot place are listed under `Kept` (behavior 24).
6. Given a state file that is not a JSON object, or whose `url`, `ref`,
   `exclude`, or `include` fails validation, when run, then exit `1`, stderr
   says it "is invalid" and names the field, and nothing is fetched or staged.
   Given an invalid `commit` alone, stderr warns, the run proceeds as a first
   sync keeping the other fields, and the file is rewritten. Given no
   `commit`, the run is a first sync with no warning that uses the file's
   `url` and lists. A leading byte-order mark is ignored.
7. Given uncommitted changes under a synced path or to the state file, when run,
   then exit `1`, stderr names the paths, nothing is fetched or staged, and the
   `template` remote is not added or changed. `scripts/sync-template.mts`
   itself never counts, untracked or modified: a fresh copy dropped in by hand
   is how an older repo bootstraps. The state file counts only when it has
   worktree changes: staged and clean is what a previous run left, so a second
   run before the commit proceeds.
8. Given an untracked copy of the script, or an older tracked and now modified
   one, when run with a URL, then the run succeeds and the template's version
   of the script is staged.
9. Given an unreachable URL, when run, then exit `1`, stderr says "Could not
   fetch" with git's reason on a `git:` line, and the state file is untouched.
10. Given no `package.json` in the repository, when run, then follow-ups are
    skipped with "no package.json here" and the sync otherwise proceeds.
11. Given `exclude` and `include` lists in the state, when run, then excluded
    synced paths are not staged, included paths are, and both lists survive
    the state rewrite; an `exclude` entry that matches no synced path draws a
    warning, and an entry that is not a literal repo-relative path (a glob,
    `.`, a `..` segment, a leading `:`) fails as in behavior 6.
12. Given no URL argument and no `template` remote, when a state file exists,
    then its `url` is used and the remote is re-added.
13. Given a template URL whose repository has none of the synced paths, when
    run, then exit `1`, stderr says "Nothing to pull", and neither the state
    file nor the index is touched.
14. Settings follow-ups are two-way: every `permissions.allow` and
    `permissions.deny` rule in the template's `.claude/settings.json` that this
    repository's file lacks is listed as "missing here", as is the template's
    `outputStyle` when this repository sets none, and so is every template
    hook registration (event, matcher, command) absent here. It is "differs"
    when it replaced a registration here that the template head lacks, and
    each such registration gets a `yours:` line. A registration here that any
    version of the template's file held (in the template's history or at the
    sync point) is the template's, however far it lags the sync point: it was
    replaced by the template's new registrations for that event with its
    command (a changed matcher), else its matcher (a changed command), else
    all of them. One that no version held is the repository's own; it was
    replaced by those running its command (an edited matcher) only when it is
    the one registration here for that event running that command.
    Otherwise it is "missing here". The repository's own rules and hooks are
    otherwise never listed, even beside the template's under the same matcher
    or running the same command; a hook of its own registered ahead of the
    template's is no difference, the file is never edited, and a missing or
    unreadable file skips the block with a reason. `package.json` follow-ups
    compare only the template's keys of each block (behavior 26), in template
    order. A
    key absent here is "missing here", unless the template at the baseline
    already had it, in which case it is listed as customized, "absent here"; a
    key whose local value differs from the template's is "changed on the
    template since ..." when the value also changed on the template, "differs"
    when no baseline is known, and "customized locally" when the template value
    is unchanged since the baseline. A local value that mentions a file this
    run deleted carries a "which this sync deletes" note, including an entry
    the template does not have.
15. Given a repository that shares history with the template (a fork or clone)
    and no state file, when run, then stdout prints
    `Baseline: <merge-base> (shared history)`, the commit list starts there,
    follow-ups are three-way against that commit, and the repository's own
    files are untouched.
16. Given a repository whose root commit tree equals a template commit's tree
    (a pristine "Use this template" copy) and no state file, when run, then
    stdout prints `Baseline: <that commit> (root tree)` and the list starts
    there.
17. Given a repository with no shared history whose root commit tree matches no
    template commit, when run, then the template commit at the root commit's
    time is the baseline only when at least one synced path is byte-identical
    between the two, printed as `(root time)` and marked approximate;
    otherwise `Baseline: none`.
18. Given `Baseline: none`, when run, then the state records the template head
    and stdout says the next run lists template commits since.
19. Given `--ref <tag>`, when run, then the tag is fetched into
    `refs/template-tags/`, the content staged is the tag's, stdout labels the
    ref `(tag)`, the state records `ref` and the tag's commit, and no local tag
    is created; a later run with no arguments stays on the tag; `--ref main`
    drops `ref` and lists the commits from the tag's commit to the branch head.
20. Given a recorded commit that is a descendant of the ref being synced to,
    when run, then stdout says the sync point "is ahead of it", no commit list
    is printed, the older mechanics are staged, and the state moves to the
    older commit.
21. Given a refused ref (`--ref -x`), an unknown option, or a ref that is
    neither a branch nor a tag, when run, then exit `1` with a reason and the
    state file is untouched.
22. Given a checkout whose `origin` is the template URL, when run, then exit `1`
    and stderr says this is the template itself.
23. Given a synced path whose checkout fails, when run, then the path and the
    first line of git's reason appear under `Skipped`, the other paths are still
    staged, and exit is `0`; when every checkout fails, exit `1` with the list.
    Files git wrote before an abort stay in the worktree unstaged, new ones
    untracked, and the next run's dirty check refuses them until they are
    restored or cleaned. The tests cover the abort case only.
24. Given a tracked file under a synced path that the template head does not
    ship, when run, then it is staged for deletion only when it is in the
    template's tree at an exact sync point (the recorded commit, fetched by
    its hash when this clone lacks it, or a `shared history` or `root tree`
    baseline) or byte-identical to a version the template shipped at that
    path, however it got here (an older copy of the script that recorded no
    sync point, a sync while its path was excluded). Otherwise it stays
    untouched and unstaged. It is listed under `Kept` when the template once
    shipped a file at that path or, given a recorded commit the template no
    longer has, whatever its path; otherwise it is the repository's own (a
    skill, rule, guard, or included path) and is never mentioned.
25. Given a state file that came with the repository's first commit (a
    repository made with **Use this template** from one that syncs, such as
    an organization's fork of roots), when run with no URL, then stderr warns
    that it holds another repository's sync point and the run is a first sync.
    When the file names its writer in `repo`, the writer is the template and
    the file's `ref`, `exclude`, and `include` are dropped; when it names none,
    the file's `url`, `ref`, and lists are used and the warning says to pass
    the template's URL. The rewritten state is this repository's, so a rerun
    before the commit is not inherited. A clone whose later commit wrote the
    file, whatever its `origin`, is not inherited, nor is a history squashed
    into one commit whose `repo` is its own `origin`. `repo` is written once
    and kept; a file without it gets it on the next run, from `origin` with
    the user and token of an `http(s)` URL dropped, and stdout names the URL
    recorded.
26. Given a template that changed what a synced gate relies on outside the
    synced paths, when run, then `packageManager` and the `devDependencies`,
    `simple-git-hooks`, `lint-staged`, `commitlint`, and `engines` blocks of
    `package.json` are compared like its `scripts` (behavior 14), and so is
    every top-level setting of `pnpm-workspace.yaml` but the `packages` globs
    under `Workspace`, skipped with a reason when either side has no
    `pnpm-workspace.yaml`. A file the template added since the
    sync point outside the synced paths (every `MECHANICS` and `include`
    entry, excluded ones too) and `docs/internal/`, `docs/public/`, `src/`,
    `packages/`, and `apps/` that this repository lacks is listed under
    `Files` with the command that fetches it; `Files` is skipped when the sync
    point is not on the template head's history (no baseline, a lost or newer
    recorded commit).
27. Given a shallow clone (`git clone --depth 1`, the default of
    `actions/checkout`) whose state file was written by a commit the clone cut
    off, when run, then the file is this repository's own, not inherited: the
    sync starts at its recorded commit and lists every template commit since,
    breaking ones with their footer.

## Edge cases and gotchas

- The script syncs itself. The staged copy takes effect on the next run; the
  running process is unaffected. Customize via the state file, never the list.
- The state file's `url` and `ref` beat a stale per-clone remote on purpose:
  the file is shared through git, the remote is not. An inherited file is the
  exception (behavior 25): it is shared from the repository this one was made
  from.
- `pnpm-workspace.yaml` is read line by line, since node has no YAML parser:
  each top-level scalar, and the entries or items of a block-style top-level
  map or list at its first entry's indent, with quotes and comments dropped.
  A flow-style value (`[...]`, `{...}`) and anything deeper, such as named
  `catalogs:`, are not compared.
- `Files` reports an added file once: the next sync's sync point is past it,
  so a file you chose not to take is not listed again.
- `root time` is a heuristic: a template commit made long before it was pushed
  can predate a copy taken from an older head. The `Baseline:` note says so,
  and the staged diff does not depend on it.
- A retired template file kept by discarding its `D` line is staged for
  deletion again on every sync while it stays byte-identical to a version the
  template shipped. Edited, it stays and is listed under `Kept`; moved to a
  path the template never shipped, it is never mentioned again.
- Template tags live under `refs/template-tags/`, so `git describe` and
  changelogen in this repository never see them and `git tag -l` stays clean.
- Rename entries in `git status` are read as their destination path. The
  report's `git diff --cached` runs with `--no-renames`, so a deletion paired
  with an unrelated addition cannot hide which file goes.
- Paths are read with `-z` so `core.quotePath` and Windows line endings cannot
  alter them; the state file is written with `\n`.
- `merge-base --is-ancestor` failing for an unknown object (after a template
  force-push) is treated exactly like "not an ancestor".
- A ref typo fails at the fetch; there is no silent fallback to `main`.
