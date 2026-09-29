---
name: sync-template
description: Pull the roots template's shared mechanics into this repository. Bootstrap the script if missing, run the sync, review the staged diff, apply the printed follow-ups, run the done gate, and propose the commit. Use when the user says "sync from template", "pull template updates", "update the mechanics", or "sync roots". Never commits or pushes on its own.
---

# Sync from the template

`pnpm sync:template` stages the template's version of the synced paths, records
the sync point in `.template-sync.json`, and prints the follow-ups a file copy
cannot carry: the template commits since the last sync (breaking ones marked
`!`), the `package.json` scripts that differ, and the `.claude/settings.json`
entries the template has and this repo lacks. The synced paths, the recipe,
and the contract are in `docs/template/sync-template.md`.

1. Bootstrap if needed. If `scripts/sync-template.mts` is missing, or there is
   no `.template-sync.json` yet (an older copy of the script that never recorded
   a sync point), fetch a fresh copy with plain git and continue with step 2.
   Overwrite it; behavior 7 says why. The `sync:template` script shows up as a
   missing follow-up on a first run:
   `mkdir -p scripts && git fetch --no-tags https://github.com/RemiMyrset/roots.git main && git show FETCH_HEAD:scripts/sync-template.mts > scripts/sync-template.mts`
2. Start clean. The script refuses uncommitted changes under the synced paths
   and in `.template-sync.json`; commit or stash them first, never discard
   them. Commit an edited `.template-sync.json`, never stash it: the sync would
   run without its `exclude` and `include`.
3. Run `pnpm sync:template`, or `node scripts/sync-template.mts` while
   `package.json` has no `sync:template` script (add the fork URL if this repo
   tracks a fork, or `--ref <branch|tag>` to pin a template branch or tag; both
   are remembered). Claude Code runs it without a prompt; Codex and Gemini ask.
   If it stops on an invalid `.template-sync.json`, fix the field it names;
   deleting the file drops its `exclude` and `include`.
   Read the output top to bottom. On a first sync, the `Baseline:` line says how
   the starting point was found: `root time` is approximate, `none` means no
   commit list this run.
4. Breaking commits first. Every `!` line and its `BREAKING CHANGE` paragraph is
   an instruction for a hand-edit outside the synced paths: a
   `.claude/settings.json` entry, a devDependency, an orphan file to delete.
   Apply each one, or tell the user why not. When a hand-edit takes the
   template's text for a file the sync does not stage, the sync has fetched
   it: `git show template/<ref>:<path>` prints it (a pinned tag is
   `refs/template-tags/<tag>:<path>`).
5. Review the staged diff with `git diff --cached`. Deliberate local divergence
   in a synced file is normal: discard that path with
   `git restore --staged --worktree <path>`. A file of your own at a path the
   template now ships shows as `M`; discard it too. A `D` line is a file the
   template retired: one in its tree at the sync point, your edits included,
   or a byte-identical copy of a version it shipped there. Discard it to keep
   the file; an unedited one comes back as `D` next sync until you move it. A
   `Kept` block lists files that stayed but may be the template's: each is
   yours or one the template retired; `git rm` the template's. A `Skipped`
   block means a checkout failed; fix the path and re-run.
6. Apply the follow-ups. `scripts.*` lines are `package.json` edits:
   "missing here" and "changed on the template" entries are edits to make;
   "differs" (first sync) needs judgment; "customized locally" is
   informational, leave those alone. `Settings` lines are
   `.claude/settings.json` edits: add each rule, output style, and hook
   registration marked "missing here", beside your own hooks. For a hook that
   "differs", the `yours:` lines are registrations the template replaced:
   remove them and add the `template:` one, unless you changed that matcher
   on purpose. Never remove a hook no `yours:` line names. Edit by hand;
   never copy the template's settings file over yours.
7. Done gate. `pnpm install` if `package.json` changed, then `pnpm verify`; it
   stops at the first failure and names it. Fix at the source; never loosen a
   synced checker.
8. Hand off: summarize what came in, what was discarded and why, which
   follow-ups were applied, and propose
   `git commit -m "chore: sync mechanics from template"` including
   `.template-sync.json`. Do not commit or push unless asked.
