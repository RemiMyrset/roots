---
name: release
description: Prepare a release with changelogen. Pre-flight gates, changelog preview, and the exact command for the human to run. Use only when the user explicitly asks, with "release", "cut a release", "ship a version", "tag a release". Never unprompted. The release itself (pnpm release) pushes commits and tags to the default branch, so the push guard denies it to agents; the human runs it.
---

# Release

`pnpm release` runs `changelogen --release --push --no-github`. It bumps the
version from Conventional Commits since the last tag, writes `CHANGELOG.md`,
commits, tags `vX.Y.Z`, and pushes commits and tags to origin. `--no-github`
skips changelogen's GitHub Release API call, so the push is the only outward
action; drop the flag to get a GitHub Release too, which needs a
`GITHUB_TOKEN` or `gh` login and can exit non-zero even after a clean release.

The push happens inside changelogen, so the `deny-push-protected` guard denies
`pnpm release` and `changelogen --push` to agents outright. Your job ends at
handing over the command; never work around the guard.

1. Pre-flight: working tree clean, on the default branch, in sync with origin.
   Then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`, plus the docs
   gate (verify-docs skill, or `pnpm docs:gen` with `git status --porcelain`
   quiet afterward, then `pnpm docs:check && pnpm docs:portability`). Fix
   failures first; never prepare a release over a red gate.
2. Preview: `pnpm exec changelogen` (no flags) prints the pending changelog
   entries without writing anything or computing a version. The human chooses
   the bump: `pnpm release --patch|--minor|--major`, or `pnpm release -r <version>`
   for an exact one. On a first release, with no tags yet, changelogen takes the
   whole history, creates `CHANGELOG.md`, and treats `0.x.y` as `0.major.minor`,
   so `-r 1.0.0` is the cleanest start.
3. Hand off: tell the user the exact command to run (`pnpm release` plus the bump
   flag), the version and tag it will create, and the remote it pushes to.
   If other repositories sync mechanics from this one, they can pin this tag
   with `pnpm sync:template --ref vX.Y.Z`, so tag only from a green `main`. Stop.
4. If asked to verify afterwards: `git log -1` shows the release commit,
   `git tag -l` the new tag, tree clean. If the push was rejected (branch
   rulesets often block direct pushes to the default branch), the commit and tag
   exist locally; report that state and let the user decide, never force or
   retry.
