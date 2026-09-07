---
name: release
description: Prepare a release with changelogen — pre-flight gates, changelog preview, and the exact command for the human to run. Use only when the user explicitly asks — "release", "cut a release", "ship a version", "tag a release". Never unprompted. The release itself (pnpm release) pushes commits and tags to the default branch, so the push guard denies it to agents — the human runs it.
---

# Release

`pnpm release` runs `changelogen --release --push --no-github` — it bumps the
version from Conventional Commits since the last tag, writes `CHANGELOG.md`,
commits, tags `vX.Y.Z`, and **pushes commits and tags to origin**. `--no-github`
skips changelogen's extra GitHub Release API call, so the push is the only
outward action (drop the flag if you later want a GitHub Release too — it needs a
`GITHUB_TOKEN`/`gh` login and can set a non-zero exit even after a clean release).
The push happens inside changelogen, so the `deny-push-protected` guard denies
`pnpm release` and `changelogen --push` to agents outright. Your job ends at
handing over the command; never work around the guard.

1. Pre-flight, all clean before anything else: working tree clean, on the
   default branch, in sync with origin. Then `pnpm build && pnpm test && pnpm
   typecheck && pnpm lint`, plus the docs gate (verify-docs skill, or `pnpm
   docs:gen` with `git status --porcelain` quiet afterward, then `pnpm docs:check
   && pnpm docs:portability`). Fix failures first; never prepare a release over a
   red gate.
2. Preview: `pnpm exec changelogen` (no flags) prints the pending changelog
   entries without writing anything (it does not compute a version in this mode).
   To choose the bump, the human forces it: `pnpm release --patch|--minor|--major`,
   or `pnpm release -r <version>` for an exact one — usually the right tool for the
   first release (no tags yet: changelogen takes the whole history and creates
   `CHANGELOG.md`; it also treats `0.x.y` as `0.major.minor`, so going straight to
   `-r 1.0.0` is often cleanest).
3. Hand off: tell the user the exact command to run (`pnpm release` plus the bump
   flag), the version and tag it will create, and the remote it pushes to.
   Children can pin this release with `pnpm sync:template --ref vX.Y.Z`, so
   tag only from a green `main`. Stop.
4. If asked to verify afterwards: `git log -1` shows the release commit,
   `git tag -l` the new tag, tree clean. If the push was rejected (branch rulesets
   often block direct pushes to the default branch), the commit and tag exist
   locally — report that state and let the user decide; never force or retry.
