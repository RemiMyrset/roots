---
name: new-adr
description: Create a new decision record (MADR 4 minimal) named by today's date, in the correct format. Use when the user says "new ADR", "record this decision", "write a decision record", or a load-bearing choice was just made. Also use unprompted immediately after making a load-bearing choice yourself, such as adding or swapping a dependency, changing a convention or format, or reversing an earlier decision.
---

# New decision record

Create a decision record under `docs/internal/decisions/`.

0. If this is the roots template itself, write no record. Use the check in
   step 0 of the `first-run` skill. Every child starts with a copy of
   `docs/internal/decisions/`, so it stays clean here (see "What roots chose"
   in `docs/template/conventions.md`). Add the choice and its why as a bullet
   under that heading, and its cost under "Consequences", then stop.
1. Name it `YYYYMMDD-kebab-title.md`: today's date with no hyphens
   (`date +%Y%m%d` prints it; in PowerShell, `Get-Date -Format yyyyMMdd`),
   then a short declarative kebab title, for example
   `20260929-use-postgres.md`. The date needs no counter, so records written
   on parallel branches never collide. Never create a numbered `NNNN-` name,
   even when the folder holds numbered records: those are legacy, stay as they
   are, and collide across branches.
2. Copy `docs/internal/decisions/_template.md` to that name.
3. Fill it in: the H1 is `# Title`, with no number or date; set
   `- **Status:**` (a decision being adopted now is `accepted`) and
   `- **Date:**` (today, YYYY-MM-DD). Write Context and Problem Statement,
   Considered Options, Decision Outcome ("Chosen option: X, because Y"), and
   Consequences (good and bad).
4. If it replaces or amends an earlier record: add a
   `- **Supersedes:** [ID](./file.md)` bullet here, and edit only the old
   record's Status line to `superseded by [ID](./file.md)`, linking this one.
   An amendment supersedes too: restate what still holds of the old record,
   so this one reads alone.
   The ID is the filename without `.md` for a dated record
   (`20260929-use-postgres`) and the number for a numbered one (`0007`). Never
   touch an old accepted record's body.
5. Run `pnpm docs:gen` (it rewrites any page that keeps a generated list),
   then `pnpm docs:check`; both must pass.

The filename date is the day the record was created and never changes, even
when the Date bullet later moves to the day it was accepted. A record written
today about an older decision is still named for today; its Date bullet
carries the older day.

If merging the default branch reports an add/add conflict on this file,
another branch wrote a record with the same name on the same day. When it is
the same decision written twice, merge the two into one record; when the
decisions differ, rename the one not yet on the default branch to a more
specific title and keep its date.

If the request names the decision topic, use it.
