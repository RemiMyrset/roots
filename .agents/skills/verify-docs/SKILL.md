---
name: verify-docs
description: Run the full docs gate locally and fix what it finds. Generated-section drift, format violations, broken links, portability breaks. Use after any edit under docs/, README.md, or AGENTS.md, before committing docs changes, or when the user says 'check the docs' or 'verify docs'.
---

# Verify docs

Run the docs steps of the done gate, in CI order, and fix failures at the
source:

1. `pnpm docs:gen` rewrites the `.agents/skills` mirror and any automd
   region a page keeps. Then `git status --porcelain` catches staged and
   untracked output, same as CI; if generated files changed, include the
   regenerated output in this change. Only when you made no docs edits does a
   change mean the previous commit had drift.
2. `pnpm docs:check` enforces the couplings listed under "Generated vs
   hand-written" in `docs/template/spec-discipline.md`. Fix the document or the
   path, never loosen the checker.
3. `pnpm docs:portability` enforces the rules in
   `docs/template/markdown-portability.md`. Fix violations per that page; never
   suppress.
4. If VitePress content or config changed, `pnpm docs:internal:build` and
   `pnpm docs:public:build` must both succeed.

Report what was regenerated, what was fixed, and any remaining warnings (for
example stale `Last reviewed` dates that need a human re-read). A stale date
on a `docs/template/` page is the template's to fix: in the template,
re-verify the page and bump the date; in a child, never edit the page;
report the warning and propose `pnpm sync:template` (the sync-template
skill), which runs only when the user asks. For the full done gate (code and
docs together), run `pnpm verify` instead.
