# Decision records

Append-only log of load-bearing decisions in
[MADR 4 minimal](https://adr.github.io/madr/) form. Each record is a one-time
write: when a decision is reversed or superseded, write a *new* record that
links back. Never rewrite history — the only permitted edit to an accepted
record is its Status line.

## How to write a new one

1. Copy [the template](./_template.md) to `NNNN-kebab-title.md` — `NNNN` is the
   next unused 4-digit integer (or invoke the `new-adr` skill).
2. Make the H1 match: `# NNNN. Title`.
3. Set the Status and Date bullets. A decision merged as agreed practice is
   `accepted`.
4. If it replaces or amends an earlier record, link both ways (see the template).
5. Run `pnpm docs:gen` — the index below is generated; never hand-edit it.

This directory starts empty in a fresh project. That is correct — the template's
own rationale lives in `docs/template/conventions.md`, which also shows the
shape a good record takes: context, the options considered, the choice and why,
and the consequences, good and bad.

## Index

<!-- automd:decisionsIndex -->

_No decisions yet. The first one appears here after `pnpm docs:gen`._

<!-- /automd -->
