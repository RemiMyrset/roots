# Spec discipline

Every fact in this repository has exactly one canonical home. Other files link
to it, never restate it. When a fact changes, edit the canonical file and no
other.

## Three-place sync

Behavior lives in source code, tests, and one spec file under
`docs/internal/specs/` (template mechanics are specified under
`docs/template/`). **When a behavior changes, all three change in the same
PR.** If you cannot describe the change in plain prose in its spec, you do not
understand it well enough to merge.

## Canonical-home map

The table at the top of `/AGENTS.md` maps concerns to canonical homes, and the
project owns it. If a concern is missing, pick one canonical home and add a row.
As the project grows, add directories with their own rows: `runbooks/` for
operational procedure, `design/` for product intent, a structure map once the
codebase has shape.

## Concrete triggers

- New externally visible capability → new capability spec under
  `specs/<area>/`.
- New cross-cutting invariant on an entity → the entity's spec (create it if
  missing); capability specs link to it.
- Renamed route, changed status code, new flag, changed exit code → spec edit.
- Swapping a load-bearing dependency or reversing a decision → a new record
  that supersedes; edit only the old record's Status line.
- New or renamed developer-facing command → README, plus the AGENTS.md
  Commands list when it gates done (the one sanctioned restatement).

When you catch yourself updating a second doc to keep it consistent, stop and
link to the canonical home instead. That second doc is derived.

## Decisions vs specs vs docs

A spec says what the system does, the contract callers see. A decision says
why, the reasoning behind the shape. Docs (guides, runbooks, design) say how
things hang together for someone landing cold.

A new endpoint goes in a spec, the decision to have it in a decision record,
and overview docs link to both without restating them.

## Generated vs hand-written

`pnpm docs:gen` generates the decisions index and the specs index. The
VitePress sidebars are derived at build time from the same readers, so they
cannot drift either. Never hand-edit generated output; change the source files
and re-run.

`pnpm docs:check` enforces the couplings generation cannot: Source and Tests
paths resolve, formats hold, and stale review dates surface as warnings for a
human re-read. CI runs both and fails on drift.

## In-flight planning

Plans, sketches, and pre-merge proposals live in conversations, scratch files,
and PR descriptions. Once a change ships, the decision record holds the durable
why and the spec the durable what. Do not merge planning artifacts into
`docs/internal/`.
