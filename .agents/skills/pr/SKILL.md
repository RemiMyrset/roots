---
name: pr
description: Push the current feature branch and open a pull request. Verify first, check the branch name against the protected list, build the PR body from the repository template with the checklist ticked only where true, link the issue. Use when the user says "open a PR", "create a pull request", "push and PR", or "ship this branch". Never merges and never touches a protected branch.
---

# Open a pull request

The push flow runs unattended: `git push` and the read-only `gh` commands are
allow-listed, and the `deny-push-protected` guard keeps every push off a
protected branch. What counts as protected, and what else the guard denies, is
under "Push protection" in `docs/template/guards.md`. Merging is a human
decision; `gh pr merge` always prompts, and this skill never runs it.

1. Branch check. `git branch --show-current` must not match a protected
   pattern. If it does, stop and suggest a branch: `feat/`, `fix/`, `docs/`,
   `chore/`, or `refactor/` plus a short kebab slug, then `git switch -c`
   that branch and continue.
2. Clean tree. `git status --porcelain` must be empty; commit pending work
   first with a Conventional Commit (`type(scope): subject`, subject at most 50
   chars). Never `--no-verify`; the hooks are the gate, and a guard denies it.
3. Verify. `pnpm verify` must pass. Fix at the source; never open a PR over a
   red gate.
4. Push. `git push -u origin <branch>` (`--force-with-lease` only if the branch
   was rebased and the user knows).
5. Body. Read `.github/PULL_REQUEST_TEMPLATE.md` and fill it: a two-sentence
   Summary, the three-place-sync boxes ticked only for what this PR did (source
   and tests, spec, decision record, or N/A), the docs-hygiene boxes ticked only
   after the commands ran, reviewer notes for risks and follow-ups. If an issue
   number was given, add `Closes #<n>` under Summary.
6. Create. `gh pr create --base <default branch> --title "<conventional subject>"
   --body-file <the filled body>`. The title is the branch's headline commit
   subject, or a Conventional Commit summary of the set.
7. Report the PR URL and what CI will run. Then stop: watching checks
   (`gh pr checks`) or fixing a red run is a separate ask.

$ARGUMENTS may name the issue to close or the PR title.
