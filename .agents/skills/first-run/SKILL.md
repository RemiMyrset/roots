---
name: first-run
description: Initialize a repository just created from the template by running the README "First run" checklist. Prove the done gate, name the project, replace the template's pitch, pages, and owner values with yours, apply the GitHub settings with gh, delete the section, and propose the commit. Use when the user says "first run", "initialize from template", "set up this repo", or "initialize this repo". Also use unprompted when README.md still contains a "## First run" section and this checkout is not the template itself. Never pushes.
---

# First run

The README section is the checklist; this skill executes it. Nothing in the tree
depends on the template's name, so every step is plain editing plus a few `gh`
calls. Ask before any step whose input you would otherwise have to invent.

0. Stop if this is the template itself: `git remote get-url origin` points at
   `github.com/RemiMyrset/roots`, or `gh repo view --json isTemplate -q .isTemplate`
   prints `true`. Say so; there the section is the product.
1. Derive identity. `OWNER/REPO` comes from `git remote get-url origin`, or
   `gh repo view --json owner,name` when authenticated. The slug is the repo
   name and must match `^[\w.-]+$`. The licence holder is `gh api user -q .name`,
   else `git config user.name`. Ask for the one-line pitch, never invent it;
   offer `gh repo view --json description -q .description` if it is set.
2. Done gate: `pnpm install && pnpm verify`. Red here is a template defect; stop
   and report it, never work around it.
3. Rename, exact edits:
   - `package.json`: `"name": "<slug>"`, `"description": "<pitch>"`, and
     `repository.url` to this repository's URL (the public site's GitHub link
     reads it).
   - `README.md`: the H1 becomes `# <slug>` (or the title the user gives); the
     two paragraphs under it become one paragraph, the pitch. Delete the
     sections `## Who it is for, and not for` and `## What is in the box` and
     the `mermaid` block under `## Layout`; they describe the template, not
     this repository. Under `## Where things live`, delete the parenthetical
     that names the template's own site and keep the provenance line.
   - `docs/public/index.md` becomes `# <slug> documentation`, one paragraph
     with the pitch, and `Start with [Getting started](./getting-started.md).`
     `docs/public/getting-started.md` becomes `# Getting started` with three
     numbered steps: install node 24 and pnpm then `pnpm install`;
     `pnpm verify` is what "done" means; replace this page with the product's
     first steps. Both pages spoke about the template; the public site
     publishes whatever is here.
   - `LICENSE`: `Copyright (c) <year> <holder>`.
   - `.github/CODEOWNERS`: the whole file becomes two lines, the comment
     `# Default reviewers for every path. Later rows override earlier ones; add path-specific owners below.`
     and `* @<owner>`; the shipped comment describes the template's owner.
   - `.github/ISSUE_TEMPLATE/config.yml`: `RemiMyrset/roots` becomes
     `<owner>/<repo>` in both links.
   - `CODE_OF_CONDUCT.md`: the `@RemiMyrset` contact link becomes the contact
     the user names.
   - Package scope, only if the user wants something other than `@repo/`:
     `grep -rl '@repo/' --exclude-dir=node_modules .` (the README's command)
     lists every file. Edit each except `pnpm-lock.yaml` and the
     `.agents/skills` copies, then `pnpm install` (the lockfile is regenerated,
     never hand-edited; CI installs with `--frozen-lockfile`) and
     `pnpm docs:gen` (the mirror rewrites the copies).
4. Protected branches: ask whether `main` is the only one; if not, set
   `PROTECTED_BRANCHES` (comma-separated globs) in the `env` block of
   `.claude/settings.json`. The trust prompts are the human's; mention them,
   do not attempt them: Codex asks to trust the folder and then each hook via
   `/hooks`; Gemini asks only to confirm the hooks' fingerprints (its folder
   trust is off by default); Claude Code asks nothing beyond the folder.
5. GitHub settings, only when `gh auth status` succeeds (in Claude Code the
   `gh repo edit`, `gh workflow run`, and `gh api` calls prompt, which is
   expected; Codex prompts for every command; Gemini's `tools.allowed` covers
   the read-only ones):
   `gh repo edit <owner>/<repo> --description "<pitch>" --add-topic typescript --add-topic pnpm --add-topic turborepo --add-topic ai-agents --enable-wiki=false --enable-projects=false --delete-branch-on-merge`
   (add the product's own topics),
   then `gh workflow run labels.yml`,
   `gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts`, and
   `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true`
   (the docs-toolchain Renovate section says why). If the user wants the public docs
   published: `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`,
   `gh workflow run pages.yml`, and
   `gh repo edit <owner>/<repo> --homepage https://<owner>.github.io/<repo>/`.
   If not authenticated, print the commands for the user instead.
   Then print the Renovate install link, `https://github.com/apps/renovate`,
   for the user: `gh` cannot install a GitHub App, and `renovate.json` is
   already in the tree.
6. Delete the `## First run` section from `README.md`, from that heading to the
   line before the next `## ` heading, then run `pnpm docs:portability` and
   `pnpm verify` once more.
7. Hand off: summarize the edits and propose
   `git commit -am "chore: initialize from roots"` (run it only if asked; never
   push). Print the two things that wait: the branch ruleset, whose command and
   timing are under "Push protection" in `docs/template/guards.md`, and the
   reminder that `packages/example-package`, `apps/example-app`, and the two
   `docs/public/` stubs are still placeholders. Then `grep -rn 'RemiMyrset\|remimyrset' --exclude-dir=node_modules --exclude-dir=.git .`
   must list only `docs/template/` and the provenance line in the README.

If the request carries the pitch or a package scope, use them.
