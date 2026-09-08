# Documentation

Two audiences, two directories: the public site build reads only `public/`, so
internal content cannot leak into it.

- [internal/](./internal/index.md) is the engineering handbook: decisions,
  specs, and this project's own guides. VitePress renders it locally
  (`pnpm docs:internal:dev`); host it for the team behind access control, recipe
  in [docs-toolchain](./template/docs-toolchain.md).
- [public/](./public/index.md) is the publishable site. Keep it free of anything
  internal.
- [template/](./template/README.md) holds template-owned rules and agent
  material, synced from the roots template and never rendered by either site.
  Read it, do not edit it.

The public site build emits its own `llms.txt` (the "SEO for AI" standard) plus
a markdown copy of every public page into its `dist/`, for web agents on the
deployed site; the AI discoverability recipe is in
[docs-toolchain](./template/docs-toolchain.md). Nothing indexes the internal
handbook for machines; coding agents work from `AGENTS.md` and the indexes.

Obsidian users open this `docs/` folder as the vault. The committed
`.obsidian/app.json` makes Obsidian emit portable relative markdown links. The
authoring rules are in
[markdown-portability](./template/markdown-portability.md).
