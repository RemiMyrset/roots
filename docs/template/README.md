# Template-owned docs

Everything in this folder is owned by the [roots](https://github.com/RemiMyrset/roots)
template, not by this repository. It holds the repository-level rules and agent
material that every child of the template shares:

- [conventions](./conventions.md) — what roots is, why it is shaped this way, and
  what that costs.
- [spec-discipline](./spec-discipline.md) — one fact, one home; three-place sync.
- [markdown-portability](./markdown-portability.md) — the authoring rules every
  doc follows.
- [docs-toolchain](./docs-toolchain.md) — how the docs mechanics work, plus the
  recipes for everything roots deliberately does not ship wired.
- [sync-template](./sync-template.md) — the contract behind `pnpm sync:template`.
- [guards](./guards.md) — the agent guards' threat model: what they catch, what
  they do not, and the server-side boundaries behind them.

Three things follow from "template-owned":

1. **It is synced.** `pnpm sync:template` pulls the template's version of this
   folder like any other mechanic. Do not add or edit files here — extend
   `AGENTS.md` or `docs/internal/` instead. To diverge on one page deliberately,
   list it under `exclude` in `.template-sync.json`.
2. **It is never rendered.** Neither VitePress site reads this folder; it is read
   on GitHub and in Obsidian. Pages inside the internal site name these files as
   paths rather than linking to them, because VitePress rejects links to pages
   it does not build.
3. **It follows the same rules.** `pnpm docs:portability` lints it with the rest
   of `docs/`.

## Vocabulary

One word per concept, used the same way in every page, skill, and script:

- **template** — roots, the repository these files come from. **child** — a
  repository made from it, whether by "Use this template", fork, or clone.
- **mechanics** — the paths `pnpm sync:template` keeps current (the synced
  paths); **template-owned** — a file the template maintains and a child never
  edits.
- **rulebook** — `AGENTS.md`, the one agent-instruction file; **skills** — the
  procedures under `.claude/skills/` (mirrored to `.agents/skills/` for Codex
  and Gemini CLI).
- **guards** — the agent pre-tool guards under `.claude/hooks/` that deny a
  command before it runs. Never "hooks": **git hooks** are commitlint,
  lint-staged, and secretlint running through simple-git-hooks at commit time.
- **done gate** — `pnpm verify`, singular: every CI check in CI order.
- **sync point** — the template commit recorded in `.template-sync.json`.
- **decision** — a record of why, under `docs/internal/decisions/`; **spec** —
  a contract of what, under `docs/internal/specs/`.
- **handbook** — the internal VitePress site (`docs/internal/`); **public
  site** — `docs/public/`, the surface for the open web.
