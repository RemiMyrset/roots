---
paths:
  - "docs/internal/decisions/**"
  - "docs/internal/specs/**"
---

# Decisions and specs

Before editing these files, read `docs/template/spec-discipline.md`.
The load-bearing rules: decision records are append-only once accepted
(`proposed` drafts may be revised freely; after acceptance: supersede, never
rewrite — only the old record's Status line changes); specs describe externally
observable behavior with binary Behavior branches; entity specs own
cross-cutting invariants and capability specs link to them; when behavior
changes, source + tests + spec change in the same PR. Indexes are generated —
run `pnpm docs:gen`, never edit them by hand. Validate with `pnpm docs:check`.
