---
name: first-run
description: Initialize a repository just created from the template by running the README "First run" checklist. Prove the done gate, name the project, replace the template's pitch, pages, licence, and owner values with yours, apply the GitHub settings with gh, delete the section, and propose the commit. Use when the user says "first run", "initialize from template", "set up this repo", or "initialize this repo". Also use unprompted when README.md still contains a "## First run" section and this checkout is not the template itself. Never pushes.
---

# First run

The README section is the checklist; this skill executes it. Nothing in the tree
depends on the template's name, so every step is plain editing plus a few `gh`
calls. Ask before any step whose input you would otherwise have to invent.

0. Stop if this is the template itself: `git remote get-url origin` points at
   `github.com/RemiMyrset/roots`, or `gh repo view --json isTemplate -q .isTemplate`
   prints `true`. Say so; there the section is the product.
1. Environment. `node --version` must print v24 or later (`.node-version`
   pins 24) and `pnpm --version` must print a version. If either fails, say
   the machine is not set up yet, point to the README's `## Setup` section,
   and stop; that is the environment, not a template defect.
2. Derive identity, then ask for what cannot be derived. `OWNER/REPO` comes
   from `git remote get-url origin`, or `gh repo view --json owner,name` when
   authenticated. The slug is the repo name and must match `^[\w.-]+$`.
   `gh api repos/<owner>/<repo> --jq '.owner.type, .visibility'` prints
   whether the owner is a `User` or an `Organization` and whether the
   repository is `public`, `private`, or `internal`; without `gh`, ask. Then
   ask, never invent:
   - the one-line pitch; offer `gh repo view --json description -q .description`
     if it is set;
   - the licence: keep MIT, another licence, or none;
   - the licence holder, unless the answer was none: offer the owner's name,
     `gh api users/<owner> --jq '.name // .login'`, which is the
     organization's for an organization, else `git config user.name`;
   - for an organization, the code owners: a team (`@<org>/<team>`) or user
     handles, since an organization name alone is not a valid owner;
   - for a repository that is not public, the address that takes security
     reports: GitHub offers private vulnerability reporting on public
     repositories only;
   - the contact for conduct reports in `CODE_OF_CONDUCT.md`: a user handle
     or an address; offer `@<owner>` for a user.
3. Done gate: `pnpm install && pnpm verify`. Red here is a template defect;
   stop and report it, never work around it.
4. Rename, exact edits:
   - `package.json`: `"name": "<slug>"`, `"description": "<pitch>"`,
     `repository.url` to this repository's URL (the public site's GitHub link
     reads it), and `"version": "0.0.0"`: a template release bumps the
     version, and the `release` skill takes `0.0.0` with no tag and no
     `CHANGELOG.md` as a first release.
   - `CHANGELOG.md`, when present: delete it. It is the template's release
     history, with links into the template's repository; the first
     `pnpm release` writes this repository's own.
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
   - `LICENSE`, by the user's choice. MIT: `Copyright (c) <year> <holder>`.
     Another licence: replace the file with
     `gh api licenses/<key> --jq .body` (`gh api licenses --jq '.[].key'`
     lists the keys), fill in its year and holder placeholders, and name it
     in the link under `## License` in `README.md`. None: delete `LICENSE`
     and the `## License` section of `README.md`.
   - `.github/CODEOWNERS`: the whole file becomes two lines, the comment
     `# Default reviewers for every path. Later rows override earlier ones; add path-specific owners below.`
     and `* @<owner>` for a user, or `*` followed by the handles the user
     gave for an organization; the shipped comment describes the template's
     owner.
   - `SECURITY.md`, only when the repository is not public: the paragraph
     that names the **Report a vulnerability** button becomes one sentence
     saying to email the address the user gave. A public repository keeps it;
     step 6 turns the button on.
   - `.github/ISSUE_TEMPLATE/config.yml`: `RemiMyrset/roots` becomes
     `<owner>/<repo>` in both links.
   - `CODE_OF_CONDUCT.md`: the `@RemiMyrset` contact link becomes the contact
     the user names.
   - Package scope, only if the user wants something other than `@repo/`:
     `grep -rl '@repo/' --exclude-dir=node_modules --exclude-dir=.claude --exclude-dir=.agents .`
     (the README's command) lists every file. Edit each except
     `pnpm-lock.yaml`, then `pnpm install` (the lockfile is regenerated,
     never hand-edited; CI installs with `--frozen-lockfile`). Leave the
     skills alone: they are synced, name `@repo/` only as the default, and the
     next sync would revert the edit.
5. Protected branches: ask whether `main` is the only one; if not, set
   `PROTECTED_BRANCHES` (comma-separated globs) in the `env` block of
   `.claude/settings.json`. The trust prompts are the human's; mention them,
   do not attempt them: each tool asks to trust the folder, and Codex then
   asks to trust each hook via `/hooks`. Claude Code and Gemini load the
   guards only when started at the repository root ("Trust and registration"
   in `docs/template/agent-surfaces.md`).
6. GitHub settings, only when `gh auth status` succeeds (the `gh repo edit`,
   `gh workflow run`, and `gh api` calls prompt in every tool, which is
   expected):
   `gh repo edit <owner>/<repo> --description "<pitch>" --add-topic typescript --add-topic pnpm --add-topic turborepo --add-topic ai-agents --enable-wiki=false --enable-projects=false --delete-branch-on-merge`
   (add the product's own topics),
   then `gh workflow run labels.yml` and
   `gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true`
   ("Keep dependencies current" in `docs/template/docs-toolchain.md` says
   why). For a public repository also run
   `gh api -X PUT repos/<owner>/<repo>/private-vulnerability-reporting`,
   which turns on the button `SECURITY.md` names. If not authenticated, print
   the commands for the user instead.
7. Delete the `## First run` section from `README.md`, from that heading to the
   line before the next `## ` heading, then run `pnpm docs:portability` and
   `pnpm verify` once more.
8. Hand off: summarize the edits and propose
   `git commit -am "chore: initialize from roots"` (run it only if asked; never
   push). Print what waits for after the user's push, with `<owner>/<repo>`
   filled in: the branch ruleset, whose command and timing are under "Push
   protection" in `docs/template/guards.md`, and, if the user wants the public
   docs, the three commands under "Publish the public site on GitHub Pages" in
   `docs/template/docs-toolchain.md`, with the cost sentence above them for a
   repository that is not public. Run before the push, the first deploy
   would publish the template's pages. Then remind the user that
   `packages/example-package`, `apps/example-app`, and the two `docs/public/`
   stubs are still placeholders. Last,
   `git grep -n -i remimyrset -- . ':!docs/template' ':!.claude/skills' ':!.agents/skills' ':!scripts/sync-template.mts'`
   must print only the provenance line in the README. The excluded paths are
   synced and name the template on purpose (the sync URL, the bootstrap
   command); never edit them.

If the request carries the pitch, the licence, or a package scope, use them.
