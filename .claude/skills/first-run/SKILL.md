---
name: first-run
description: Initialize a repository just created from the template — run the README "First run" checklist with judgment: prove the gates, name the project, fill the owner placeholders, apply the GitHub settings with gh, delete the section, and propose the commit. Use when the user says "first run", "initialize from template", "set up this repo", or "initialize this repo". Also use unprompted when README.md still contains a "## First run" section and this checkout is not the template itself. Never pushes.
---

# First run

The README section is the checklist; this skill executes it. Nothing in the tree
depends on the template's name, so every step is plain editing plus a few `gh`
calls. Ask before any step whose input you would otherwise have to invent.

0. Bail out if this is the template itself: `git remote get-url origin` points at
   `github.com/RemiMyrset/roots`, or `gh repo view --json isTemplate -q .isTemplate`
   prints `true`. Say so and stop — there the section is the product.
1. Derive identity. `OWNER/REPO` from `git remote get-url origin` (prefer
   `gh repo view --json owner,name` when authenticated). The slug is the repo
   name and must match `^[\w.-]+$`. Licence holder: `gh api user -q .name`,
   else `git config user.name`. Ask for the one-line pitch — never invent it;
   offer `gh repo view --json description -q .description` if it is set.
2. Gates: `pnpm install && pnpm verify`. Red here is a template defect — stop
   and report it rather than working around it.
3. Rename, exact edits:
   - `package.json`: `"name": "<slug>"`, `"description": "<pitch>"`.
   - `README.md`: the H1 becomes `# <slug>` (or the title the user gives); the
     paragraphs between the H1 and `## First run` become the pitch. Keep the
     provenance line under "Where things live".
   - `LICENSE`: `Copyright (c) <year> <holder>`.
   - `.github/CODEOWNERS`: `@OWNER` becomes `@<owner>`.
   - `.github/ISSUE_TEMPLATE/config.yml`: `OWNER/REPO` becomes `<owner>/<repo>`.
   - `CODE_OF_CONDUCT.md`: `[INSERT CONTACT METHOD]` becomes the contact the
     user names.
   - Package scope, only if the user wants something other than `@repo/`:
     replace it in `packages/*/package.json`, `apps/*/package.json`,
     `apps/*/src/*.ts`, `AGENTS.md`, `README.md`, and
     `.claude/skills/new-package/SKILL.md`, then `pnpm install` (the lockfile's
     importer names change).
4. Protected branches: ask whether `main` is the only one; if not, set
   `PROTECTED_BRANCHES` (comma-separated globs) in the `env` block of
   `.claude/settings.json`. The Codex and Gemini trust prompts are the human's —
   mention them, do not attempt them.
5. GitHub settings, only when `gh auth status` succeeds (each call prompts for
   permission — expected):
   `gh repo edit <owner>/<repo> --description "<pitch>" --add-topic typescript --enable-wiki=false --enable-projects=false`
   then `gh workflow run labels.yml`. If the user wants the public docs
   published: `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`,
   `gh workflow run pages.yml`, and
   `gh repo edit <owner>/<repo> --homepage https://<owner>.github.io/<repo>/`.
   Not authenticated: print the commands for the user instead.
6. Delete the `## First run` section from `README.md` — from that heading to the
   line before the next `## ` heading — then run `pnpm docs:portability` and
   `pnpm verify` once more.
7. Hand off: summarize the edits; propose
   `git commit -am "chore: initialize from roots"` (run it only if asked; never
   push). Print the two things that need the first push before they can happen:
   the branch-ruleset command from `docs/template/guards.md` ("Push
   protection"), to run once `ci` and `docs` have reported on `main`; and the
   reminder that `packages/example-package`, `apps/example-app`, and the
   `docs/public/` pages are still placeholders.

$ARGUMENTS may carry the pitch or a package scope.
