# Template-owned docs

The [roots](https://github.com/RemiMyrset/roots) template owns every file in
this folder. They are the repository-level rules and agent material every child
of the template shares.

- [conventions](./conventions.md): what roots is, why it is shaped this way, and
  what that costs.
- [spec-discipline](./spec-discipline.md): one fact, one home; three-place sync.
- [markdown-portability](./markdown-portability.md): the authoring rules every
  doc follows.
- [docs-toolchain](./docs-toolchain.md): how the docs mechanics work, plus the
  recipes for everything roots deliberately does not ship wired.
- [sync-template](./sync-template.md): the contract behind `pnpm sync:template`.
- [guards](./guards.md): the agent guards' threat model, what they catch, what
  they do not, and the server-side boundaries behind them.

`pnpm sync:template` pulls the template's version of this folder like any other
mechanic. Do not add or edit files here; extend `AGENTS.md` or `docs/internal/`
instead. `exclude` in `.template-sync.json` takes whole synced paths, so this
folder can only be excluded as a unit (`docs/template`), never one page of it.

Neither VitePress site renders this folder; it is read on GitHub and in
Obsidian. Pages inside the internal site name these files as paths, because
VitePress rejects links to pages it does not build.

`pnpm docs:portability` lints it with the rest of `docs/`.

## Vocabulary

One word per concept, used the same way in every page, skill, and script.

- The **template** is roots, the repository these files come from. A **child**
  is a repository made from it, whether by "Use this template", fork, or clone.
- The **mechanics** are the paths `pnpm sync:template` keeps current (the
  synced paths). A **template-owned** file is one the template maintains and a
  child never edits.
- The **rulebook** is `AGENTS.md`, the one agent-instruction file. The
  **skills** are the procedures under `.claude/skills/`, mirrored to
  `.agents/skills/` for Codex and Gemini CLI.
- The **writing rules** are `.claude/output-styles/writing.md`, the one prose
  rulebook, loaded at session start in all three tools.
- The **guards** are the agent pre-tool guards under `.claude/hooks/` that deny
  a command before it runs. Never "hooks": the **git hooks** are the commit-time
  checks listed under [Hook bypass](./guards.md#hook-bypass) in guards.
- The **done gate** is `pnpm verify`, singular: every CI check in CI order.
- The **sync point** is the template commit recorded in `.template-sync.json`.
- A **decision** is a record of why, under `docs/internal/decisions/`. A
  **spec** is a contract of what, under `docs/internal/specs/`.
- The **handbook** is the internal VitePress site (`docs/internal/`). The
  **public site** is `docs/public/`, the surface for the open web.
