# roots documentation

Two audiences, two directories: the public site build reads only `public/`, so
internal content cannot leak into it.

- [internal/](./internal/index.md) — the engineering handbook: decisions, specs,
  development guides. Rendered by VitePress locally (`pnpm docs:internal:dev`);
  host it for the team behind access control — recipe in
  [docs-toolchain](./template/docs-toolchain.md).
- [public/](./public/index.md) — the publishable site. Keep it free of anything
  internal.
- [template/](./template/README.md) — template-owned rules and agent material,
  synced from the roots template and never rendered by either site. Read it,
  do not edit it.

Machine consumers: the public site build emits its own `llms.txt` (the
"SEO for AI" standard) plus a markdown copy of every public page into its
`dist/`, for web agents on the deployed site — see the AI discoverability recipe
in [docs-toolchain](./template/docs-toolchain.md). Nothing indexes the internal
handbook for machines; coding agents work from `AGENTS.md` and the indexes.

Obsidian users: open this `docs/` folder as your vault. The committed
`.obsidian/app.json` makes Obsidian emit portable relative markdown links.
Authoring rules: [markdown-portability](./template/markdown-portability.md).
