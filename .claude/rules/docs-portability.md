---
paths:
  - "docs/**/*.md"
  - "README.md"
  - "AGENTS.md"
---

# Portable markdown

Before editing any of these files, read and obey
`docs/template/markdown-portability.md`, the canonical ruleset for docs that
render in GitHub, VitePress, and Obsidian. `pnpm docs:portability` enforces it;
fix violations, never suppress them.

Never hand-edit content between automd markers; edit the source and run
`pnpm docs:gen`.
