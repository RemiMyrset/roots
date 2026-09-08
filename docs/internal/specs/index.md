# Specifications

A spec describes externally observable behavior: the contract between caller
and implementation, never a rephrasing of the source or a list of functions
called. The two kinds, capability and entity, and the test a good spec passes
are under "Spec kinds" in `docs/template/spec-discipline.md` (template-owned,
outside this site).

## How to write a new one

1. Copy [the template](./_template.md) to `specs/<area>/<name>.md`, or invoke
   the `new-spec` skill. Create an `<area>` folder when the first spec in a
   domain appears (for example `api/`, `cli/`, `domain/`). The index and
   sidebar discover new areas automatically.
2. Fill the Source, Tests, and `- **Last reviewed:**` bullets.
   `pnpm docs:check` verifies the paths resolve and warns on stale review dates.
3. Number the Behavior branches; every branch is a binary check.
4. Run `pnpm docs:gen`. The index below is generated; never hand-edit it.

This directory starts empty in a fresh project; do not backfill specs for code
that does not exist yet. For a worked example, read
`docs/template/sync-template.md` first. It is a real capability spec, with its
Source and Tests bullets, a Contract, and binary Behavior branches.

## Index

<!-- automd:specIndex -->

_No specs yet. The first one appears here after `pnpm docs:gen`._

<!-- /automd -->
