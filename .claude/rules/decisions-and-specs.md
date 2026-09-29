---
paths:
  - "docs/internal/decisions/**"
  - "docs/internal/specs/**"
---

# Decisions and specs

Before editing these files, read `docs/template/spec-discipline.md`.

Decision records are append-only once accepted: `proposed` drafts may be
revised freely, but after acceptance you supersede, never rewrite, and only the
old record's Status line changes. Specs describe externally observable behavior;
the two kinds and the test a spec passes are under "Spec kinds" in that page.
When behavior changes, source, tests, and spec change in the same PR.

New decision records are named `YYYYMMDD-kebab-title.md` with the title alone
as the H1 (the `new-adr` skill); numbered `NNNN-` records are legacy and stay
as they are. The handbook sidebar and `pnpm docs:list` list the records, read
from the files. Validate with `pnpm docs:check`.
