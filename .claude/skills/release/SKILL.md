---
name: release
description: Prepare a release with changelogen. Pre-flight checks, changelog preview, and the exact command for the human to run. Use only when the user explicitly asks, with "release", "cut a release", "ship a version", "tag a release". Never unprompted. The release itself (pnpm release) pushes commits and tags to the default branch, so the push guard denies it to agents; the human runs it.
---

# Release

`pnpm release` runs `changelogen --release --clean --push --no-github`. It
bumps the version from Conventional Commits since the last tag, writes
`CHANGELOG.md`, commits, tags `vX.Y.Z`, and pushes commits and tags to origin.
`--no-github` skips changelogen's GitHub Release API call; drop the flag to
get a GitHub Release too, which needs a `GITHUB_TOKEN` or `gh` login and can
exit non-zero even after a clean release.

`--clean` refuses a working tree with any change: staged, unstaged, or
untracked. The release commit takes in the whole index and goes to the
default branch past review, so without the flag a staged file rides along. It
checks nothing else; the branch and the sync with origin stay the human's.

Every changelogen run, the preview included, sends each commit author's email
to `ungh.cc` to look up a GitHub handle, and writes the raw address into the
changelog when the lookup fails. `"changelog": { "excludeAuthors": [""] }` in
`package.json` stops both: the empty string matches every author, so no
lookup is sent and no Contributors section is written. `noAuthors` drops the
Contributors section and `hideAuthorEmail` drops the address from it, but
both still send the lookup; with the key in place, the push is the only
outward action.

The push happens inside changelogen, so the `deny-push-protected` guard denies
`pnpm release` and `changelogen --push` to agents outright. Your job ends at
handing over the command; never work around the guard.

1. `package.json` holds `changelog.excludeAuthors` as a list with `""` in it.
   Without it, stop before the preview and say why: every changelogen run
   sends the commit authors' emails to a third party. A list of names without
   `""` is the maintainers' choice to send the lookup for the authors it
   leaves in; name them and ask before the preview.
2. Working tree clean, on the default branch, in sync with origin, and
   `pnpm verify` green; fix failures first, never prepare a release over a
   red gate.
3. Preview: `pnpm exec changelogen` (no flags) prints the pending changelog
   entries without writing anything or computing a version. The human chooses
   the bump: `pnpm release --patch|--minor|--major`, or `pnpm release -r <version>`
   for an exact one. `-r` must differ from the `version` in `package.json`
   (changelogen exits 1 on an equal one) and from every tag `git tag -l`
   lists.

   A first release has no tag, no `CHANGELOG.md`, and version `0.0.0`:
   changelogen takes the whole history, creates `CHANGELOG.md`, and treats
   `0.x.y` as `0.major.minor`, so `-r 1.0.0` is the cleanest start. No tag
   but a `CHANGELOG.md` or a version above `0.0.0` is how a repository made
   from a released template looks until the `first-run` skill resets both;
   say so and ask before going on.
   Tags a fork or a clone inherited stay: changelogen starts after the latest
   (`git describe --tags --abbrev=0`), so the new version must sort above it.
4. Hand off: tell the user the exact command to run (`pnpm release` plus the bump
   flag), the version and tag it will create, and the remote it pushes to.
   If other repositories sync mechanics from this one, they can pin this tag
   with `pnpm sync:template --ref vX.Y.Z`, so tag only from a green `main`. Stop.
5. If asked to verify afterwards: `git log -1` shows the release commit,
   `git tag -l` the new tag, tree clean. If the push was rejected (branch
   rulesets often block direct pushes to the default branch), the release
   commit is local only, but the tag may be on origin anyway, pointing at a
   commit no branch there holds: `git push --follow-tags` is not atomic, and a
   branch ruleset does not cover tags. `git ls-remote --tags origin vX.Y.Z`
   shows whether it landed; report the branch's state and the tag's, let the
   user decide, and never force, retry, or delete a published tag.
