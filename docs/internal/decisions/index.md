# Decision records

An append-only log of load-bearing decisions in
[MADR 4 minimal](https://adr.github.io/madr/) form. A record is written once.
When a decision is reversed or superseded, write a new record that links back;
the only permitted edit to an accepted record is its Status line.

## How to write a new one

1. Copy [the template](./_template.md) to `NNNN-kebab-title.md`, where `NNNN`
   is the next unused 4-digit integer (or invoke the `new-adr` skill).
2. Make the H1 match: `# NNNN. Title`.
3. Set the Status and Date bullets. A decision merged as agreed practice is
   `accepted`.
4. If it replaces or amends an earlier record, link both ways (see the template).
5. Run `pnpm docs:gen`. The index below is generated; never hand-edit it.

This directory starts empty in a fresh project, and that is correct. The
template's own rationale lives in `docs/template/conventions.md`, which also
shows the shape of a good record: context, the options considered, the choice
and why, and the consequences, good and bad.

## Index

<!-- automd:decisionsIndex -->

| # | Title | Status |
| --- | --- | --- |
| [0001](./0001-renovate-for-dependency-updates.md) | Renovate keeps dependencies and action pins current | accepted |

<!-- /automd -->
