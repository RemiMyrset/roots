# Documentation

Three folders, three readers. The public site build reads only `public/`, so
internal content cannot leak into it.

- [internal/](./internal/index.md) is the engineering handbook: decisions,
  specs, and this project's own guides. VitePress renders it
  (`pnpm docs:internal:dev`) for the team, never for the open web; the hosting
  recipe is in
  [docs-toolchain](./template/docs-toolchain.md#serve-the-internal-handbook-to-the-team).
- [public/](./public/index.md) is the publishable site. VitePress renders it
  (`pnpm docs:public:dev`) and the synced Pages workflow publishes it. Keep it
  free of anything internal.
- [template/](./template/README.md) holds the rules and agent material every
  child of the roots template shares, synced and never edited here. Neither
  site renders it; read it on GitHub.

Obsidian users open this `docs/` folder as the vault. The committed
`.obsidian/app.json` makes Obsidian emit portable relative markdown links. The
authoring rules are in
[markdown-portability](./template/markdown-portability.md).
