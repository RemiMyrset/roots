---
name: release
description: Cut a release with changelogen — pre-flight gates, version bump from Conventional Commits, CHANGELOG.md, tag, and push. Use only when the user explicitly asks — "release", "cut a release", "ship a version", "tag a release". Never unprompted, and never as part of another task — pnpm release pushes commits and tags to origin, an outward action that needs the user's explicit go-ahead.
---

# Release

`pnpm release` runs `changelogen --release --push --no-github` — it bumps the
version from Conventional Commits since the last tag, writes `CHANGELOG.md`,
commits, tags `vX.Y.Z`, and **pushes commits and tags to origin**. `--no-github`
skips changelogen's extra GitHub Release API call, so the push is the only
outward action (drop the flag if you later want a GitHub Release too — it needs a
`GITHUB_TOKEN`/`gh` login and can set a non-zero exit even after a clean release).
The push happens inside changelogen, so the `git push` permission deny never
intercepts it — the confirmation step below is the real gate.

1. Pre-flight, all clean before anything else: working tree clean, on the
   default branch, in sync with origin. Then run whichever code gates this repo
   defines — `pnpm build && pnpm test && pnpm typecheck && pnpm lint` on the
   TypeScript path, or none of them if the no-TypeScript init removed those
   scripts — plus the docs gate (verify-docs skill, or `pnpm docs:gen` with
   `git status --porcelain` quiet afterward, then `pnpm docs:check && pnpm
   docs:portability`). Fix failures first; never release over a red gate.
2. Preview: `pnpm exec changelogen` (no flags) prints the pending changelog
   entries without writing anything (it does not compute a version in this mode).
   To choose the bump, force it: `pnpm release --patch|--minor|--major`, or
   `pnpm release -r <version>` for an exact one — usually the right tool for the first release
   (no tags yet: changelogen takes the whole history and creates
   `CHANGELOG.md`; it also treats `0.x.y` as `0.major.minor`, so going
   straight to `-r 1.0.0` is often cleanest).
3. Tell the user the exact version, tag, and remote this will push, and STOP
   until they confirm in this session.
4. Run `pnpm release` (plus the bump flag chosen in step 2).
5. Verify and report: `git log -1` shows the release commit, `git tag -l` the
   new tag, tree clean. If the push was rejected (branch rulesets often block
   direct pushes to the default branch), the commit and tag exist locally —
   report that state and let the user decide; never force or retry.
