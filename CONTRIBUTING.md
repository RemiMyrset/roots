# Contributing

This repository is opinionated on purpose. Tooling enforces the rules below, so
following them is a matter of running the commands.

1. **Read the rulebook.** [AGENTS.md](./AGENTS.md) is the contract for humans and
   AI agents alike: pnpm only, TypeScript only, no classes, a doc block on every
   export, portable markdown. It links to the canonical home of every rule.
2. **Set up.** Node 24 and pnpm as [setup](./docs/template/setup.md) says, then
   `pnpm install`. The git hooks install themselves.
3. **Branch.** `feat/`, `fix/`, `docs/`, `chore/`, or `refactor/` plus a short
   kebab-case slug. Never commit to `main`: by convention every change reaches
   it through a PR. The server requires a PR and its review only once the
   `pull_request` rule under
   [Push protection](./docs/template/guards.md#push-protection) is added to
   the branch ruleset.
4. **Done means green.** `pnpm verify` runs every check CI runs, in CI order, and
   stops at the first failure. Never loosen a checker or bypass a git hook to get
   there; fix the cause.
5. **Commits.** Conventional Commits, `type(scope): subject`, subject at most 50
   characters; commitlint enforces it and the changelog is built from them. A
   change that requires downstream hand-edits carries a `BREAKING CHANGE` footer.
   In the template, so does every edit to a file the sync never copies, marked
   optional when a child may skip it
   ([sync-template](./docs/template/sync-template.md#recipe)).
6. **Behavior changes travel together.** Source, tests, and the spec change in
   the same PR; a load-bearing choice gets a decision record. The rules are in
   [spec-discipline](./docs/template/spec-discipline.md).
7. **Where docs go.** Decisions and specs under `docs/internal/`, user-facing
   pages under `docs/public/`. `docs/template/` is synced from the template,
   and a child never edits it. Every doc follows
   [markdown-portability](./docs/template/markdown-portability.md).
8. **Open the PR** with `.github/PULL_REQUEST_TEMPLATE.md` filled in honestly.
   Bugs go through the bug issue template; security issues follow
   [SECURITY.md](./SECURITY.md), never a public issue.
