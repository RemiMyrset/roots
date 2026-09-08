# Template sync

- **Source:** `scripts/sync-template.mts`
- **Tests:** `scripts/test-sync.mts` — `pnpm test:sync`
- **Last reviewed:** 2026-09-07

The contract for `pnpm sync:template`; the tests pin this page. The
user-facing recipe is in [docs-toolchain](./docs-toolchain.md).

## Purpose

Bring the template's shared mechanics into a repository made from it, safely
enough for an agent to run it unattended. The repository may come from **Use
this template** (no shared git history), a fork or clone (shared history), or
predate the template. Safe means: stage rather than commit, refuse to clobber,
work out where the repository branched off, record where it is now, and say
what a file copy cannot carry (template commits since, and the `package.json`
scripts that now differ).

## Non-goals

- Never edits `package.json`, `.claude/settings.json`, `docs/internal/`,
  `docs/public/`, `src/`, `packages/`, or `apps/`. Drift there is reported.
- Takes the template's version of each synced path wholesale;
  review-and-discard is the merge.
- No push-based or scheduled sync, no tokens, no bots.
- Never runs inside the template itself.

## Contract

Invocation is `node scripts/sync-template.mts [git-url] [--ref <ref>]`, as
`pnpm sync:template`. It runs from any directory inside the repository and
changes to the git top level first. Any other option, or a second bare
argument, is refused.

The template URL is the first match of: the argument; `url` in
`.template-sync.json`; the existing `template` remote; the built-in roots URL.
The argument must match `^[\w@:/.+~%-]+$` and not start with `-`.

The ref is the first match of: `--ref`; `ref` in the state file; `main`. It
must match `^\w[\w./+-]*$` and contain no `..`. The `template` remote is
always set to the resolved URL with tags disabled.

The ref is fetched as a branch first (into `refs/remotes/template/<ref>`),
then as a tag (into `refs/template-tags/<ref>`, never `refs/tags/`, so
changelogen in this repository cannot see template tags). A name that is both
resolves as the branch.

The synced paths are the `MECHANICS` list in the script, minus `exclude`, plus
`include` from the state file. Entries are files or directories, and a
directory means every tracked file under it. `.agents/skills` is a generated
copy of `.claude/skills` (no symlinks anywhere), so it syncs as plain files.

The state file `.template-sync.json` at the repo root is written with LF and
staged whenever it changes:

```json
{
  "$comment": "...",
  "url": "https://github.com/RemiMyrset/roots.git",
  "ref": "<branch or tag; absent means main>",
  "commit": "<40 hex, the template commit whose mechanics are staged>",
  "exclude": ["<mechanics path to skip>"],
  "include": ["<extra path to pull>"]
}
```

`ref` is optional, written only when a ref other than `main` is tracked;
`--ref main` unpins. `exclude` and `include` are optional and preserved across
rewrites. `commit` always records the fetched template head, never an inferred
baseline.

A missing state file means a first sync. A file that is not JSON, or whose
`url`, `ref`, or `commit` fails validation, produces a warning on stderr, is
treated as a first sync, and is rewritten.

The baseline for a first sync (no recorded commit) is the first match of: the
merge-base of `HEAD` and the template head when history is shared; else the
template commit whose tree the repository's root commit carries verbatim (a
"Use this template" copy); else the template commit at the root commit's time,
accepted only when at least one synced path is identical between the two; else
none. Later syncs use the recorded commit.

Exit `0` means the sync staged changes or was already up to date. Exit `1`
means one of: not inside a git repository; an unknown option; a refused URL or
ref; the repository's `origin` is the template URL; a synced path has
uncommitted changes; the ref cannot be fetched as a branch or a tag; none of
the synced paths exist on the template; no synced path could be checked out.
On exit `1` nothing has been staged, the state file is untouched, and the
failure is printed on stderr with a leading `✖`.

stdout, in order:

1. `Template: <url>`.
2. `Fetched template/<ref> at <sha>`, with a `(tag)` suffix when pinned to a
   tag, ending in one of "first sync", "unchanged since last sync", "N commits
   since last sync" followed by the commit list, "is ahead of it" (the recorded
   commit is newer than the ref being synced to), or "not in its history".
3. On a first sync, exactly one `Baseline:` line: `<sha> (shared history)`,
   `<sha> (root tree)`, `<sha> (root time)`, or `none`, each with a note; then
   `No template commits since the baseline.` or "N commits since the baseline"
   followed by the commit list.
4. Either `Already up to date — nothing staged.` or a `Staged` header followed
   by one line per staged entry: the status letter (`M`, `A`, `D`, `R`), two
   spaces, the path. Then, only when a checkout failed, a `Skipped` header with
   one `<path>  <reason>` line each.
5. `Follow-ups: none new.`, `Follow-ups: skipped` with a reason, or a
   `Follow-ups` header followed by one block per script (the key, its label,
   `template:`, `yours:`, and an optional `note:` line), then an optional
   `Customized locally` line. Labels say "since the baseline" on a first sync
   and "since last sync" afterwards.
6. A `Next:` block with the review, discard, and commit commands.

Commit lines are `  ! <sha> <subject>` for breaking commits and
`    <sha> <subject>` otherwise, newest first, capped at 40, with the
`BREAKING CHANGE` paragraph indented beneath its commit. Warnings and errors go
to stderr.

## Behavior

1. Given a working directory outside any git repository, when run, then exit `1`
   and stderr contains "Not a git repository".
2. Given no state file, when run with a template URL, then the `template`
   remote exists with `tagOpt --no-tags`, the template's version of every
   synced path is staged, tracked files under a synced path that the template
   no longer ships (a file inside a path or a whole path) are staged for
   deletion, files outside the synced paths are untouched, the state file is
   written with that URL and the template head and is staged, stdout says
   "first sync", and no template tag exists locally.
3. Given the recorded commit equals the template head and every synced file
   already matches, when run, then nothing is staged and stdout says "unchanged
   since last sync" and "Already up to date".
4. Given template commits after the recorded one, when run, then stdout counts
   them, lists them newest first with `!` on commits whose subject carries `!`
   or whose body has a `BREAKING CHANGE` footer, prints that footer's paragraph
   beneath the commit, and the state advances to the template head.
5. Given a recorded commit that is neither an ancestor nor a descendant of the
   template head, when run, then stdout says the sync point is "not in its
   history", no commit list is printed, follow-ups are computed two-way, and
   the state is rewritten to the template head.
6. Given an unreadable state file, when run, then stderr warns that it is
   "unreadable", the run proceeds as a first sync, and the file is rewritten.
7. Given uncommitted changes under a synced path or to the state file, when run,
   then exit `1`, stderr names the paths, nothing is fetched or staged, and the
   `template` remote is not added or changed. `scripts/sync-template.mts`
   itself never counts, untracked or modified: a fresh copy dropped in by hand
   is how an older repo bootstraps.
8. Given an untracked copy of the script, or an older tracked and now modified
   one, when run with a URL, then the run succeeds and the template's version
   of the script is staged.
9. Given an unreachable URL, when run, then exit `1`, stderr says "Could not
   fetch", and the state file is untouched.
10. Given no `package.json` in the repository, when run, then follow-ups are
    skipped with "no package.json here" and the sync otherwise proceeds.
11. Given `exclude` and `include` lists in the state, when run, then excluded
    mechanics paths are not staged, included paths are, and both lists survive
    the state rewrite.
12. Given no URL argument and no `template` remote, when a state file exists,
    then its `url` is used and the remote is re-added.
13. Given a template URL whose repository has none of the synced paths, when
    run, then exit `1`, stderr says "Nothing to pull", and neither the state
    file nor the index is touched.
14. Follow-ups compare only the template's `scripts` keys, in template order. A
    key absent here is "missing here", unless the template at the baseline
    already had it, in which case it is listed as customized, "absent here"; a
    key whose local value differs from the template's is "changed on the
    template since ..." when the value also changed on the template, "differs"
    when no baseline is known, and "customized locally" when the template value
    is unchanged since the baseline. A local value that mentions a file this
    run deleted carries a "which this sync deletes" note, including a script
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

## Edge cases and gotchas

- The script syncs itself. The staged copy takes effect on the next run; the
  running process is unaffected. Customize via the state file, never the list.
- The state file's `url` and `ref` beat a stale per-clone remote on purpose:
  the file is shared through git, the remote is not.
- `root time` is a heuristic: a template commit made long before it was pushed
  can predate a copy taken from an older head. The `Baseline:` note says so,
  and the staged diff is exact regardless.
- Template tags live under `refs/template-tags/`, so `git describe` and
  changelogen in this repository never see them and `git tag -l` stays clean.
- Staged rename entries are read as their destination path when parsing
  `git status` and `git diff --cached`.
- Paths are read with `-z` so `core.quotePath` and Windows line endings cannot
  alter them; the state file is written with `\n`.
- `merge-base --is-ancestor` failing for an unknown object (after a template
  force-push) is treated exactly like "not an ancestor".
- A ref typo fails at the fetch; there is no silent fallback to `main`.
