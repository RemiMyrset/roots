---
name: verify-docs
description: Run the full docs gate locally and fix what it finds — generated-section drift, format violations, broken links, portability breaks. Use after any edit under docs/, README.md, or AGENTS.md, before committing docs changes, or when the user says 'check the docs' or 'verify docs'.
---

# Verify docs

Run the same gates CI runs, in order, and fix failures at the source:

1. `pnpm docs:gen` — regenerates indexes and `docs/llms.txt`.
   Then `git status --porcelain` (catches staged and untracked output, same as
   CI) — if generated files changed, include the regenerated output in this
   change; only if you made no docs edits does it mean the previous commit had
   drift.
2. `pnpm docs:check` — decision/spec format, Source/Tests paths resolving,
   staleness warnings. Fix the document or the path, never loosen the checker.
3. `pnpm docs:portability` — trifecta rules. Fix violations per
   `docs/template/markdown-portability.md`; never suppress.
4. If VitePress content or config changed: `pnpm docs:internal:build` and
   `pnpm docs:public:build` must both succeed.

Report what was regenerated, what was fixed, and any remaining warnings (for
example stale `Last reviewed` dates that need a human re-read).
