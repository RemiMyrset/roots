# Template-owned docs

The [roots](https://github.com/RemiMyrset/roots) template owns every file in
this folder. They are the repository-level rules and agent material every child
of the template shares.

- [conventions](./conventions.md): what roots is, why it is shaped this way, and
  what that costs.
- [spec-discipline](./spec-discipline.md): one fact, one home; three-place sync.
- [markdown-portability](./markdown-portability.md): the authoring rules every
  doc follows.
- [docs-toolchain](./docs-toolchain.md): how the docs mechanics work, the
  recipes for what ships unwired, and the growth paths.
- [sync-template](./sync-template.md): the recipe and the contract behind
  `pnpm sync:template`.
- [guards](./guards.md): the agent guards' threat model, what they catch, what
  they do not, and the server-side boundaries behind them.
- [agent-surfaces](./agent-surfaces.md): how Claude Code, Codex, and Gemini CLI
  each read the rulebook, guards, skills, and writing rules.

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
- The **synced paths** are the paths `pnpm sync:template` stages, defined in
  [sync-template](./sync-template.md); the **mechanics** are what they hold.
  Never "mechanics paths". A **template-owned** file is one the template
  maintains and a child never edits.
- The **rulebook** is `AGENTS.md`, the one agent-instruction file. The
  **skills** are the procedures under `.claude/skills/`; the **mirror** is
  `.agents/skills/`, their generated copy for Codex and Gemini CLI.
- The **writing rules** are `.claude/output-styles/writing.md`, the one prose
  rulebook, loaded at session start in all three tools. The **session hook** is
  `session-start.mts`, which prints them in Codex and Gemini CLI.
- The **guards** are the agent pre-tool guards under `.claude/hooks/` that deny
  a command before it runs. Never "hooks": the **git hooks** are the commit-time
  checks listed under [Hook bypass](./guards.md#hook-bypass) in guards.
- The **done gate** is `pnpm verify`, singular: every CI check in CI order. A
  **gate** is one step of it; "gates" is never a synonym for `pnpm verify`,
  while "N gates pass" is fine.
- The **drift gate** is the CI step that runs `pnpm docs:gen` and fails on any
  resulting diff. Never "diff-gate".
- A **checker** is a script under `scripts/docs/` behind `pnpm docs:check` or
  `pnpm docs:portability`.
- The **sync point** is the template commit recorded in `.template-sync.json`.
  The **baseline** is the template commit a first sync starts its commit list
  from, inferred when no sync point exists.
- The **follow-ups** are what the sync prints and cannot apply: the template
  commits since, and the `package.json` scripts that differ.
- The **house shape** is the package layout `new-package` scaffolds: catalog
  dependencies, the base tsconfig, source-direct exports, vitest, and tests
  under `test/`.
- A **decision** is a record of why, under `docs/internal/decisions/`. A
  **spec** is a contract of what, under `docs/internal/specs/`.
- The **handbook** is the internal VitePress site (`docs/internal/`). The
  **public site** is `docs/public/`, the surface for the open web.
