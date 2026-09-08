# Internal handbook

The engineering handbook, rendered locally with `pnpm docs:internal:dev`.
Paths under `docs/template/` are template-owned pages outside this site; read
them on GitHub.

<!-- Counts and lists on this page are links, never numbers: numbers drift. -->

## Start here

1. `/README.md`, commands and quickstart. It lives at the repo root, outside
   this site.
2. `/AGENTS.md`, the agent rulebook and canonical-source map.
3. `docs/template/spec-discipline.md`, one fact, one home, three-place sync.
4. [Decision records](./decisions/index.md), the why, append-only.
5. [Specifications](./specs/index.md), the what: capability and entity specs.

## Reference

- `docs/template/markdown-portability.md`, authoring rules for every doc.
- `docs/template/docs-toolchain.md`, how the docs mechanics work, plus recipes.
- Create `runbooks/` or `design/` for this project's own guides when the first
  one appears, and give it a sidebar group in `.vitepress/config.ts`.
