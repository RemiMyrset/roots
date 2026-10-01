---
name: update-deps
description: Refresh the dependencies and the pinned GitHub Actions on request. List what is outdated, raise the catalog ranges, audit, refresh each action's SHA pin with gh, verify, and open a PR, with every major in its own commit. Use only when the user asks, with "update dependencies", "update deps", "bump dependencies", "check for outdated packages", or "refresh the action pins". Never unprompted, and never merges.
---

# Update dependencies

Nothing updates dependencies on a schedule; this skill is the procedure, run
when the user asks. pnpm refuses any version younger than the cooldown,
`minimumReleaseAge` in `pnpm-workspace.yaml`, so a release that young waits
for the next run unless a `minimumReleaseAgeExclude` entry names it (step 3).
Why there is no update bot is in `docs/template/conventions.md`.

Work on a branch such as `chore/update-deps`, cut from an up-to-date default
branch with a clean tree. Claude Code asks before each `pnpm outdated`,
`pnpm update`, `pnpm audit`, and `gh api` call: the allowlist leaves them out
(Permission prompts in `docs/template/agent-surfaces.md`).

1. List. `pnpm outdated -r` prints every dependency with a newer release, with
   its current and latest version, and exits 1 whenever it prints one; that is
   the listing, not a failure. Note each one whose latest is outside its
   catalog range: a new major, or a new minor of a `0.x` package. Step 5
   calls both majors.
2. Raise the catalog ranges. `pnpm update -r` moves every range in the
   `catalog:` block of `pnpm-workspace.yaml` up to the newest release the
   range allows and refreshes the lockfile. Then run `pnpm lint:fix`: an
   updated lint config can bring rules that reorder `pnpm-workspace.yaml` or
   add a setting. Review that diff, keep each comment above the key it
   explains, and leave the `allowBuilds` entries as they are; each is a human
   verdict. Commit.
3. Audit. `pnpm audit` lists the known advisories, and the table under
   "Keep dependencies current" in `docs/template/docs-toolchain.md` lists the
   accepted ones; drop a row whose advisory is gone. `pnpm audit --fix update`
   moves the lockfile to fixed versions within the ranges. Where no such
   release exists, a forced version (`pnpm audit --fix override`, which writes
   `overrides` into `pnpm-workspace.yaml`, then `pnpm install`) is the last
   resort and is named in the PR; an advisory whose fix would break the
   package that pins it joins the table instead, with a one-line reason.
   Either `--fix` run exits 1 while any advisory remains, even when it fixed
   others. Either one also appends a
   `minimumReleaseAgeExclude` list to `pnpm-workspace.yaml` naming the
   patched version of every advisory, installed or not, and that list lifts
   the cooldown for each. Delete the list and run `pnpm install`: it passes
   when every locked version is past the cooldown, and otherwise names each
   one that is not. Wait for those, or put back only their entries and name
   each in the PR as a cooldown exemption. Then run `pnpm lint:fix`, which
   moves a kept key into order, and commit whatever changed.
4. Refresh the action pins. Each `uses:` in `.github/workflows/` names a full
   commit SHA with the release in a trailing comment. For each
   `<owner>/<repo>`:
   - its release tags:
     `gh api --paginate repos/<owner>/<repo>/releases --jq '.[] | select(.prerelease | not) | .tag_name | select(test("^v?[0-9]+[.][0-9]+[.][0-9]+$"))'`,
     or, for a repository that tags without publishing releases,
     `gh api --paginate repos/<owner>/<repo>/tags --jq '.[].name | select(test("^v?[0-9]+[.][0-9]+[.][0-9]+$"))'`.
     Neither list is sorted by version: take the highest version in the
     pinned major, and leave a newer major to step 5
   - that tag's commit: `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`
   - its own manifest: `gh api -H "Accept: application/vnd.github.raw" "repos/<owner>/<repo>/contents/action.yml?ref=<sha>"`
     (`action.yaml` in some repositories; an action in a subdirectory keeps it
     there).

   Refuse a release whose manifest has a `uses:` pinned by a tag rather than a
   40-character SHA; "Keep dependencies current" in
   `docs/template/docs-toolchain.md` says why. Otherwise replace the SHA and
   set the comment to the exact tag (`# v6.1.0`, never `# v6`). Commit.
5. Majors, npm and actions alike, go in their own commit, one per major, after
   reading the release notes or changelog for breaking changes. For a package,
   edit its range in the catalog (`^9.0.0` becomes `^10.0.0`), run
   `pnpm install`, and make the code changes it needs in the same commit.
   `@types/node` stays on the node major in `.node-version`. A major that
   cannot land now stays out, and the PR says why.
6. Verify and open the PR. `pnpm verify` passes after the last edit; fix a
   failure at the source. Then the pr skill pushes the branch and opens the PR;
   label it with `gh pr edit <number> --add-label dependencies`. Merging is the
   human's call.

If the request names packages or actions, update only those.
