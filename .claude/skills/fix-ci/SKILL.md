---
name: fix-ci
description: Make a red CI run green by reproducing the failing step locally and fixing it at the source. Use when the user says "fix CI", "the checks are red", "why did CI fail", "CI is failing", or after the pr skill reports a red run. Also use unprompted when a PR you opened shows a failed check. Never loosens a checker, never bypasses a hook, never retries a run hoping it passes.
---

# Fix CI

CI runs the same steps as `pnpm verify`, in the same order, on Ubuntu and
Windows under bash; `scripts/test-gates.mts` keeps the two equal. So every red
step has a local twin, and the fix is local.

1. Find the failure. `gh pr checks <n>` (or `gh run list --branch <branch>`)
   names the red job; `gh run view <run-id> --log-failed` prints only the
   failing step's log. Read the first error, not the last line.
2. Reproduce. Map the step to its gate and run `pnpm verify --only <gate>`
   (`pnpm verify <gate>` resumes from there through the rest). A step that is
   red on Windows only usually means a path separator, a CRLF, or a spawn
   difference; the log says which.
3. Fix at the source. A failing check means the code, the doc, or the lockfile
   is wrong, never the checker: do not loosen a rule, skip a test, or add
   `--no-verify` (the guards deny it anyway). A stale lockfile is
   `pnpm install`, then commit `pnpm-lock.yaml`. Stale generated docs are
   `pnpm docs:gen`, then commit the output.
4. Stop if the failing gate is a template mechanic (`pnpm verify` marks them
   "template mechanics": `test:hooks`, `test:sync`, `test:docs`,
   `test:gates`). The synced files are not this repository's to patch; say so
   and point at the `sync-template` skill, or report it upstream.
5. Prove it. `pnpm verify` end to end, then commit with a Conventional subject
   (`fix(scope): what`, at most 50 chars) and push the same branch. Watch with
   `gh pr checks <n> --watch`; report the outcome and stop. In Claude Code the
   `gh` calls run without a prompt; Codex asks for each.
