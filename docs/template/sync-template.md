# Template sync

- **Source:** `scripts/sync-template.mts`
- **Tests:** `scripts/test-sync.mts` — `pnpm test:sync`
- **Last reviewed:** 2026-09-07

The contract for `pnpm sync:template`, in spec form. The user-facing recipe is
in [docs-toolchain](./docs-toolchain.md); this page is what the tests pin.

## Purpose

Bring the template's shared mechanics into a repository that shares no git
history with it, safely enough to run unattended by an agent: stage rather than
commit, refuse to clobber, record where you are, and say what a file copy cannot
carry (template commits since, and the `package.json` scripts that now differ).

## Non-goals

- Never edits `package.json`, `.claude/settings.json`, `docs/internal/`,
  `docs/public/`, `src/`, or `packages/`. Drift there is reported, not fixed.
- Not a merge. It takes the template's version of each synced path wholesale;
  review-and-discard is the merge.
- No push-based or scheduled sync, no tokens, no bots.

## Contract

Invocation: `node scripts/sync-template.mts [git-url]` (as `pnpm sync:template`).
Runs from any directory inside the repository; it changes to the git top level
first.

Template URL, first match wins: the argument; `url` in `.template-sync.json`;
the existing `template` remote; the built-in roots URL. The argument must match
`^[\w@:/.+~-]+$` and not start with `-`. The `template` remote is always set to
the resolved URL with tags disabled.

Synced paths: the `MECHANICS` list in the script, minus `exclude`, plus
`include` from the state file. Entries are files or directories; a directory
means every tracked file under it.

State file `.template-sync.json` at the repo root, written with LF and staged
whenever it changes:

```json
{
  "$comment": "...",
  "url": "https://github.com/RemiMyrset/roots.git",
  "commit": "<40 hex, the template commit last synced>",
  "exclude": ["<mechanics path to skip>"],
  "include": ["<extra path to pull>"]
}
```

`exclude` and `include` are optional and preserved across rewrites. A missing
file means a first sync. A file that is not JSON, or whose `url` or `commit`
fails validation, produces a warning on stderr and is treated as a first sync,
then rewritten.

Exit codes: `0` when the sync staged changes or was already up to date; `1`
when not inside a git repository, the URL argument is refused, a synced path has
uncommitted changes, the fetch fails, or none of the synced paths exist on the
template. On exit `1` nothing has been staged and the state file is untouched.

stdout layout, in order:

1. `Template: <url>`.
2. `Fetched template/main at <sha>` ending in one of: "first sync", "unchanged
   since last sync", "N commits since last sync" followed by the commit list, or
   "not in its history".
3. Either `Already up to date — nothing staged.` or a `Staged` header followed
   by one line per staged entry: the status letter (`M`, `A`, `D`, `R`), two
   spaces, the path.
4. `Follow-ups: none new.`, `Follow-ups: skipped` with a reason, or a
   `Follow-ups` header followed by one block per script (the key, its label,
   `template:`, `yours:`, and an optional `note:` line), then an optional
   `Customized locally` line.
5. A `Next:` block with the review, discard, and commit commands.

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
   no longer ships are staged for deletion, files outside the synced paths are
   untouched, the state file is written with that URL and the template head
   and is staged, stdout says "first sync", and no template tag exists locally.
3. Given the recorded commit equals the template head and every synced file
   already matches, when run, then nothing is staged and stdout says "unchanged
   since last sync" and "Already up to date".
4. Given template commits after the recorded one, when run, then stdout counts
   them, lists them newest first with `!` on commits whose subject carries `!`
   or whose body has a `BREAKING CHANGE` footer, prints that footer's paragraph
   beneath the commit, and the state advances to the template head.
5. Given a recorded commit that is not an ancestor of the template head, when
   run, then stdout says the sync point is "not in its history", no commit list
   is printed, follow-ups are computed two-way, and the state is rewritten to
   the template head.
6. Given an unreadable state file, when run, then stderr warns that it is
   "unreadable", the run proceeds as a first sync, and the file is rewritten.
7. Given uncommitted changes under a synced path or to the state file, when run,
   then exit `1`, stderr names the paths, and nothing is fetched or staged.
   `scripts/sync-template.mts` itself never counts, untracked or modified: a
   fresh copy dropped in by hand is how an older repo bootstraps.
8. Given a repository that holds an untracked, or an older tracked and now
   modified, copy of the script, when run with a URL, then the run succeeds and
   the template's version of the script is staged.
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
    run, then exit `1`, stderr says "Nothing to pull", and the state file is
    untouched.
14. Follow-ups compare only the template's `scripts` keys, in template order: a
    key absent here is "missing here" unless the template at the last sync
    already had it (then it is listed as customized, "absent here"); a key
    whose local value differs from the template's is "changed on the template
    since last sync" when the value also changed on the template, "differs" in
    two-way mode, and "customized locally" when the template value is
    unchanged since the last sync; a local value that mentions a file this run
    deleted carries a "which this sync deletes" note, including a script the
    template does not have.

## Edge cases and gotchas

- The script syncs itself. The staged copy takes effect on the next run; the
  running process is unaffected. Customize via the state file, never the list.
- The state file's `url` beats a stale per-clone remote on purpose: the file is
  shared through git, the remote is not.
- Staged rename entries are read as their destination path when parsing
  `git status` and `git diff --cached`.
- Paths are read with `-z` so `core.quotePath` and Windows line endings cannot
  alter them; the state file is written with `\n`.
- `merge-base --is-ancestor` failing for an unknown object (after a template
  force-push) is treated exactly like "not an ancestor".
