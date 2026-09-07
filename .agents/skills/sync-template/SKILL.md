---
name: sync-template
description: Pull the roots template's shared mechanics into this repository and land them safely — bootstrap the script if missing, run the sync, review the staged diff, apply the printed follow-ups, run the done gate, and propose the commit. Use when the user says "sync from template", "pull template updates", "update the mechanics", or "sync roots". Never commits or pushes on its own.
---

# Sync from the template

`pnpm sync:template` stages the template's version of the shared mechanics
(CI workflows, labels, the agent-task issue and PR templates, docs generators and checkers, the
guard, sync, docs, and gate test-suites, agent hooks/rules/skills, `docs/template/`, and the
script itself), records the sync point in `.template-sync.json`, and prints two
things a file copy cannot carry: the template commits since the last sync
(breaking ones marked `!`) and the `package.json` scripts that differ, as
follow-ups. Recipe and contract: `docs/template/docs-toolchain.md` and
`docs/template/sync-template.md`.

1. Bootstrap if needed. If `scripts/sync-template.mts` is missing, or there is
   no `.template-sync.json` yet (an older copy of the script that never recorded
   a sync point), fetch a fresh copy with plain git — overwriting the old one is
   fine, the script exempts itself from its own dirty check — then continue
   with step 2. The `sync:template` script shows up as a missing follow-up on a
   first run:
   `mkdir -p scripts && git fetch --no-tags https://github.com/RemiMyrset/roots.git main && git show FETCH_HEAD:scripts/sync-template.mts > scripts/sync-template.mts`
2. Start clean. The script refuses uncommitted changes under the synced paths;
   commit or stash them first rather than discarding anything.
3. Run `pnpm sync:template` (add the fork URL if this repo tracks a fork, or
   `--ref <branch|tag>` to pin a template branch or tag; both are remembered). Read
   the output top to bottom. On a first sync, the `Baseline:` line says how the
   starting point was found — `root time` is approximate, `none` means no
   commit list this run.
4. Breaking commits first. Every `!` line and its `BREAKING CHANGE` paragraph is
   an instruction for a hand-edit outside the synced paths — a
   `.claude/settings.json` entry, a devDependency, an orphan file to delete.
   Apply each one, or tell the user why not.
5. Review the staged diff with `git diff --cached`. Deliberate local divergence
   in a synced file is normal: discard that path with
   `git restore --staged --worktree <path>`, and if it should stay diverged
   for good, add it to `exclude` in `.template-sync.json`. A file of your own
   under a synced directory shows up as a deletion — discard that hunk or move
   the file. A `Skipped` block means a checkout failed; fix the path and re-run.
6. Apply the follow-ups. "missing here" and "changed on the template" entries
   are edits to make in `package.json`; "differs" (first sync) needs judgment;
   "customized locally" is informational — leave those alone. Never edit
   `.claude/settings.json` unless a breaking footer says so.
7. Gates. `pnpm install` if `package.json` changed, then `pnpm verify` (every
   CI gate in order; it stops at the first failure and names it). Fix at the
   source; never loosen a synced checker.
8. Hand off: summarize what came in, what was discarded and why, which
   follow-ups were applied, and propose
   `git commit -m "chore: sync mechanics from template"` including
   `.template-sync.json`. Do not commit or push unless asked.
