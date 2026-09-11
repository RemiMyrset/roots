# 0001. Renovate keeps dependencies and action pins current

- **Status:** accepted
- **Date:** 2026-09-11

## Context and Problem Statement

Nothing refreshed the repository's dependencies. The `catalog:` block in
`pnpm-workspace.yaml` floats on caret ranges that only move when someone runs
an update by hand, and the third-party actions in `.github/workflows/` are
pinned to full commit SHAs that rot silently. The template ships supply-chain
defaults (a 48-hour release cooldown, build scripts off, secrets scanned) but
no way to stay current, so every child inherited the same slow drift.

The constraint that shaped the answer is noise. Dependabot was tried in other
repositories and rejected: it opens one pull request per dependency on its own
cadence, and for a template that spawns many children that multiplies. Any bot
had to produce at most one pull request a week by default, merge what the done
gate proves safe without a human click, and need nothing per child beyond a
one-time install.

## Considered Options

* Dependabot
* Renovate, Mend-hosted app
* Renovate, self-hosted through a scheduled GitHub Actions workflow
* No bot; update by hand

## Decision Outcome

Chosen option: "Renovate, Mend-hosted app", because one `renovate.json`
controls how many pull requests exist and when. The shipped config groups every
minor and patch update into one pull request before 06:00 UTC on Mondays, waits
two days after a release (the same cooldown pnpm enforces at install), keeps
the action SHA pins and their version comments current, and automerges
non-major updates once every check on the branch is green. Major updates and
security fixes arrive as their own pull requests. A dependency dashboard issue
lists pending updates so any of them can be pulled on demand.

The hosted app wins over self-hosting because a child installs it in two
clicks with no token, secrets, or workflow to maintain, and Mend's free tier
covers unlimited public and private repositories. Self-hosting through
`renovatebot/github-action` stays the fallback for an organization that
forbids third-party apps.

Renovate merges through its own automerge rather than GitHub's native
auto-merge (`platformAutomerge` is off). GitHub merges the moment the
*required* checks pass, and a child with no branch ruleset has none, so a pull
request would merge before CI ran. Renovate's automerge waits for every check
on the branch to be green regardless of what the ruleset requires.

`renovate.json` is a synced path, so a policy fix in the template reaches every
child through `pnpm sync:template`; a child with its own policy lists it under
`exclude`.

### Consequences

* Good, because dependencies and action pins move on a fixed weekly cadence
  with one pull request, and what passes the done gate merges itself.
* Good, because the config is one file, versioned, synced, and readable by a
  reviewer without any bot dashboard.
* Bad, because every child must install the app once, and the app holds write
  access to the repository.
* Bad, because automerge trusts the done gate completely: a gap in the tests is
  a gap in what merges unattended.
* Bad, because Renovate's default commit subjects can exceed the 50-character
  commitlint limit; the merge commit is what lands, and the first pull request
  shows whether a `commitMessageTopic` rule is needed.
