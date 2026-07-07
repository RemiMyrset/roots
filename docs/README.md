# roots documentation

Two audiences, two directories: the public site build reads only `public/`, so
internal content cannot leak into it.

- [internal/](./internal/index.md) — the engineering handbook: decisions, specs,
  development guides. Rendered by VitePress locally (`pnpm docs:internal:dev`);
  host it for the team behind access control — recipe in
  [docs-toolchain](./internal/development/docs-toolchain.md).
- [public/](./public/index.md) — the publishable site. Keep it free of anything
  internal.

Machine consumers: [llms.txt](./llms.txt) is the generated map of every doc;
[llms-full.txt](./llms-full.txt) is the whole corpus in one file. Both are
produced by `pnpm docs:gen` — never hand-edit them. Both embed the internal
handbook, so treat them with the same access rules as `internal/` — never publish
them on the public site.

Obsidian users: open this `docs/` folder as your vault. The committed
`.obsidian/app.json` makes Obsidian emit portable relative markdown links.
Authoring rules: [markdown-portability](./internal/development/markdown-portability.md).
