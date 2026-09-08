---
paths:
  - "docs/internal/decisions/**"
  - "docs/internal/specs/**"
---

# Decisions and specs

Before editing these files, read `docs/template/spec-discipline.md`.

Decision records are append-only once accepted: `proposed` drafts may be
revised freely, but after acceptance you supersede, never rewrite, and only the
old record's Status line changes. Specs describe externally observable behavior
with binary Behavior branches; entity specs own cross-cutting invariants and
capability specs link to them. When behavior changes, source, tests, and spec
change in the same PR.

Indexes are generated; run `pnpm docs:gen`, never edit them by hand. Validate
with `pnpm docs:check`.
