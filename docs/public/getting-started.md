# Getting started

This page takes a repository made from roots through its one-time first run.

## First run

> [!IMPORTANT]
> Press **Use this template** on
> [github.com/RemiMyrset/roots](https://github.com/RemiMyrset/roots), clone
> the new repository, and work through this list once there, where this page
> sits at `docs/public/getting-started.md`. In Claude Code the `first-run`
> skill does every step marked **(skill)** and hands you the rest; say "first
> run".
>
> Nothing in the tree depends on the template's name, so there is no rename
> script.

1. **Prove the done gate.** With node 24 and pnpm installed as
   [setup](https://github.com/RemiMyrset/roots/blob/main/docs/template/setup.md)
   says, `pnpm install && pnpm verify`, green before you touch anything.
   **(skill)**
2. **Name it.** **(skill; it asks for the pitch, the licence and its holder,
   the owners it cannot derive, and the security and conduct contacts)**
   - `package.json`: `name` (your repo slug), `description`,
     `repository.url`, and `version` back to `0.0.0`.
   - `CHANGELOG.md`, when present: delete it. It is the template's release
     history; your first `pnpm release` writes your own.
   - `README.md` describes the template. Copy
     `.claude/skills/first-run/readme-skeleton.md` from your checkout over it
     and replace the `<slug>`, `<pitch>`, `<owner>`, and `<repo>` placeholders,
     with `<owner>` lowercased in the public-site address;
     `pnpm docs:portability` fails while one remains.
   - `docs/public/index.md` and this page: two stubs for your product; the
     shipped pages describe the template and the public site publishes what
     is here. Replace this page last, in step 6.
   - `LICENSE`: the template ships MIT; set the copyright holder and year.
     For another licence replace the file and name it in the README's License
     link; for none delete it and the README's License section.
   - `.github/CODEOWNERS`: `@RemiMyrset` becomes your GitHub user, or in an
     organization a team (`@org/team`) or user handles, since an organization
     name alone is not a valid owner; the comment above it goes.
   - `SECURITY.md`, repositories that are not public: a contact address
     replaces the **Report a vulnerability** button, which GitHub offers on
     public repositories alone (step 5 turns it on there).
   - `.github/ISSUE_TEMPLATE/config.yml`: `RemiMyrset/roots` in both links.
   - `CODE_OF_CONDUCT.md`: the report contact under Enforcement becomes an
     email address that reaches your maintainers privately. GitHub has no
     private messages, so a handle takes reports only in public.
   - Optional: a package scope other than `@repo/`. In any POSIX shell (Git
     Bash on Windows),
     `grep -rl '@repo/' --exclude-dir=node_modules --exclude-dir=.claude --exclude-dir=.agents .`
     lists the files that name it; it skips the synced skills, which name
     `@repo/` only as the default. Edit each one except `pnpm-lock.yaml`,
     then run `pnpm install` to regenerate the lockfile, since the done gate
     installs with `--frozen-lockfile`.
3. **Agent tools.** Say yes to each tool's trust prompts, as
   [setup](https://github.com/RemiMyrset/roots/blob/main/docs/template/setup.md)
   says, or the guards stay off.
   If `main` is not your only protected branch, set `PROTECTED_BRANCHES` as
   [Push protection](https://github.com/RemiMyrset/roots/blob/main/docs/template/guards.md#push-protection)
   in guards says. **(skill; the branch list only)**
4. **Samples and stubs.** `packages/example-package` and `apps/example-app`
   keep the done gate honest; replace them when real code lands (the
   `new-package` skill scaffolds the house shape). The two `docs/public/`
   stubs from step 2 grow into product docs later; keep one page beside
   `docs/public/index.md` or the build emits no `llms.txt`. Not today.
5. **GitHub settings.** Needs `gh auth login`; `OWNER/REPO` is your repository.
   A fork of roots inherits the template flag, so add `--template=false` to
   `gh repo edit`. **(skill)**

   ```sh
   gh repo edit OWNER/REPO --description "your pitch" --add-topic typescript --add-topic pnpm --add-topic turborepo --add-topic ai-agents --enable-wiki=false --enable-projects=false --delete-branch-on-merge
   gh workflow run labels.yml -R OWNER/REPO   # seeds the labels from .github/labels.yml
   gh api -X PUT repos/OWNER/REPO/private-vulnerability-reporting   # public repositories: SECURITY.md's reporting button
   gh api -X PUT repos/OWNER/REPO/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
   ```

6. **Commit and push.** Replace this page with its stub, then
   `git commit -am "chore: initialize from roots"` and push `main` yourself.
   This and `pnpm release` are the only direct pushes, and both are yours: the
   push guard denies them to agents. Every other change lands through a PR.
   **(skill replaces the page and proposes the commit; it never pushes)**
7. **Branch ruleset.** Run the command under
   [Push protection](https://github.com/RemiMyrset/roots/blob/main/docs/template/guards.md#push-protection)
   in guards; it says when the ruleset can be created and what it costs.
8. **Publish the public docs (optional).** After the push, run the three
   commands under
   [Publish the public site on GitHub Pages](https://github.com/RemiMyrset/roots/blob/main/docs/template/docs-toolchain.md#publish-the-public-site-on-github-pages):
   enable Pages, run the first deploy
   (`gh workflow run pages.yml -R OWNER/REPO`), and set the homepage. The
   recipe also says what Pages costs on a private repository.
   **(skill prints them)**

After first run, `pnpm verify` is what done means and `pnpm sync:template`
pulls the template's updates whenever you want them. The rules every
repository made from roots follows live in the template-owned `docs/template/`
folder of your checkout; the rationale is its `conventions.md`.
