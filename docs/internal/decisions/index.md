# Decision records

An append-only log of load-bearing decisions in
[MADR 4 minimal](https://adr.github.io/madr/) form. A record is written once.
When a decision is reversed or superseded, write a new record that links back;
the only permitted edit to an accepted record is its Status line.

## How to write a new one

1. Copy [the template](./_template.md) to `YYYYMMDD-kebab-title.md`, today's
   date and a short declarative title (or invoke the `new-adr` skill). A date
   needs no counter, so records written on parallel branches never collide.
   Numbered `NNNN-` records from before stay as they are; never start one.
2. Make the H1 the title alone: `# Title`.
3. Set the Status and Date bullets. A decision merged as agreed practice is
   `accepted`.
4. If it replaces or amends an earlier record, it supersedes that record: link
   both ways (see the template). An amendment restates what still holds of the
   old record, so the new one reads alone.
5. Run `pnpm docs:check`.

This directory starts empty in a fresh project, and that is correct. The
template's own rationale lives in `docs/template/conventions.md`, which also
shows the shape of a good record: context, the options considered, the choice
and why, and the consequences, good and bad.

## The list

No committed file lists the records, so two branches that each add one touch
different files and merge without a conflict. The folder view on GitHub and in
Obsidian sorts them oldest first, the handbook sidebar adds each one's status,
and `pnpm docs:list decisions` prints them as a table.
