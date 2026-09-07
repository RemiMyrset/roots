# Template-owned docs

Everything in this folder is owned by the [roots](https://github.com/RemiMyrset/roots)
template, not by this repository. It holds the repository-level rules and agent
material that every child of the template shares:

- [conventions](./conventions.md) — what roots is, why it is shaped this way, and
  what that costs.
- [spec-discipline](./spec-discipline.md) — one fact, one home; three-place sync.
- [markdown-portability](./markdown-portability.md) — the authoring rules every
  doc follows.
- [docs-toolchain](./docs-toolchain.md) — how the docs machinery works, plus the
  recipes for everything roots deliberately does not ship wired.

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
