# Specifications

A spec describes externally observable behavior: the contract between caller
and implementation. It is not a rephrasing of the source, a list of functions
called, or an implementation guide.

Specs come in two kinds. A capability spec covers one route, command, or
observable behavior. An entity spec covers one entity's cross-cutting
invariants; for example, "player name is unique" (its scope, casing, and
normalization) lives in the player entity spec, and the create and rename
capability specs link to it and state only their own outcome, such as a
`duplicate_name` rejection.

A good spec passes one test: a reader of the spec can write the tests without
seeing the source, and a reader of the source can predict the spec. If they
disagree, the spec lagged a code change; fix it in the same PR. The full rules
are in `docs/template/spec-discipline.md` (template-owned, outside this site).

## How to write a new one

1. Copy [the template](./_template.md) to `specs/<area>/<name>.md` (or invoke
   the `new-spec` skill). Create an `<area>` folder when the first spec in a
   domain appears (for example `api/`, `cli/`, `domain/`); the index and
   sidebar discover new areas automatically.
2. Fill the Source, Tests, and `- **Last reviewed:**` bullets.
   `pnpm docs:check` verifies the paths resolve and warns on stale review dates.
3. Number the Behavior branches; every branch is binary pass/fail.
4. Run `pnpm docs:gen`. The index below is generated; never hand-edit it.

This directory starts empty in a fresh project; do not backfill specs for code
that does not exist yet. For a worked example, read
`docs/template/sync-template.md` first: a real capability spec, with its Source
and Tests bullets, a Contract, and binary Behavior branches.

## Index

<!-- automd:specIndex -->

_No specs yet. The first one appears here after `pnpm docs:gen`._

<!-- /automd -->
