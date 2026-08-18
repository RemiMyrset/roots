---
name: new-adr
description: Create a new decision record (MADR 4 minimal) with the next number, correct format, and regenerated index. Use when the user says "new ADR", "record this decision", "write a decision record", or a load-bearing choice was just made. Also use unprompted immediately after making a load-bearing choice yourself: adding or swapping a dependency, changing a convention or format, or reversing an earlier decision.
---

# New decision record

Create a decision record under `docs/internal/decisions/`.

1. Find the next number: list `docs/internal/decisions/[0-9]*.md`, take the
   highest `NNNN` prefix, add 1, zero-pad to 4 digits.
2. Copy `docs/internal/decisions/_template.md` to `NNNN-kebab-title.md` (short,
   declarative kebab title).
3. Fill it in: H1 must be `# NNNN. Title`; set `- **Status:**` (a decision being
   adopted now is `accepted`) and `- **Date:**` (today, YYYY-MM-DD). Write
   Context and Problem Statement, Considered Options, Decision Outcome
   ("Chosen option: X, because Y"), and Consequences (good AND bad).
4. If it replaces or amends an earlier record: add a
   `- **Supersedes:** [NNNN](./NNNN-slug.md)` bullet here, and edit ONLY the old
   record's Status line to `superseded by [NNNN](./NNNN-slug.md)`. Never touch
   an old accepted record's body.
5. Run `pnpm docs:gen` (regenerates the index and `docs/llms.txt`), then
   `pnpm docs:check` — both must pass before you are done.

$ARGUMENTS is the decision topic if provided.
