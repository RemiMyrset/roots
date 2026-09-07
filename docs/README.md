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

Machine consumers: [llms.txt](./llms.txt) is the generated map of every doc —
one line each, path plus a one-sentence description. Produced by `pnpm docs:gen`;
never hand-edit it. It indexes the internal handbook, so treat it with the same
access rules as `internal/` — never publish it on the public site. Agents search
the map and follow the links; there is deliberately no concatenated corpus.

Obsidian users: open this `docs/` folder as your vault. The committed
`.obsidian/app.json` makes Obsidian emit portable relative markdown links.
Authoring rules: [markdown-portability](./template/markdown-portability.md).
