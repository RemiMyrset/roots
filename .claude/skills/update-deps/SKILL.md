---
name: update-deps
description: Refresh the dependencies and the pinned GitHub Actions on request. List what is outdated, raise the catalog ranges, audit, refresh each action's SHA pin with gh, verify, and open a PR, with every major in its own commit. Use only when the user asks, with "update dependencies", "update deps", "bump dependencies", "check for outdated packages", or "refresh the action pins". Never unprompted, and never merges.
---

# Update dependencies

Nothing updates dependencies on a schedule; this skill is the procedure, run
when the user asks. pnpm refuses any version published in the last 48 hours
(`minimumReleaseAge` in `pnpm-workspace.yaml`), so a release that young waits
for the next run. Why there is no update bot is in
`docs/template/conventions.md`.

Work on a branch such as `chore/update-deps`, cut from an up-to-date default
branch with a clean tree.

1. List. `pnpm outdated -r` prints every dependency with a newer release, with
   its current and latest version. Note each one whose latest is a new major.
2. Raise the catalog ranges. `pnpm update -r` moves every range in the
   `catalog:` block of `pnpm-workspace.yaml` up to the newest release within
   its major and refreshes the lockfile. Then run `pnpm lint:fix`: an updated
   lint config can bring rules that reorder `pnpm-workspace.yaml` or add a
   setting. Review that diff, keep each comment above the key it explains, and
   leave the `allowBuilds` entries as they are; each is a human verdict.
   Commit.
3. Audit. `pnpm audit` lists the known advisories. `pnpm audit --fix update`
   moves the lockfile to fixed versions within the ranges. Where no such
   release exists, a forced version (`pnpm audit --fix override`) is the last
   resort and is named in the PR. Commit.
4. Refresh the action pins. Each `uses:` in `.github/workflows/` names a full
   commit SHA with the release in a trailing comment. For each
   `<owner>/<repo>`:
   - the latest release: `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`
   - its commit: `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`
   - its own manifest: `gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<repo>/contents/action.yml?ref=<sha>"`
     (`action.yaml` in some repositories; an action in a subdirectory keeps it
     there).

   Refuse a release whose manifest has a `uses:` pinned by a tag rather than a
   40-character SHA: first run turns on required SHA pinning, and GitHub then
   refuses every workflow that calls it. Otherwise replace the SHA and set the
   comment to the exact tag (`# v6.1.0`, never `# v6`). Commit.
5. Majors, npm and actions alike, go in their own commit, one per major, after
   reading its release notes or changelog for breaking changes. For a package,
   edit its range in the catalog (`^9.0.0` becomes `^10.0.0`), run
   `pnpm install`, and make the code changes it needs in the same commit.
   `@types/node` stays on the node major in `.node-version`. A major that
   cannot land now stays out, and the PR says why.
6. Verify and open the PR. `pnpm verify` passes after the last edit; fix a
   failure at the source. Then the pr skill pushes the branch and opens the PR;
   label it with `gh pr edit <number> --add-label dependencies`. Merging is the
   human's call.

If the request names packages or actions, update only those.
