# Spec discipline

**Single source of truth per concern.** Every fact in this repository has
exactly one canonical home. Other files link, never restate. When a fact
changes, edit the canonical file — and only the canonical file — for that
concern.

This rule is doing the heavy lifting. If you take nothing else from this page,
take that.

## Three-place sync

Behavior lives in three places:

1. **Source code.**
2. **Tests.**
3. **The spec** — one file under `docs/internal/specs/`, not several.

**When a behavior changes, all three change in the same PR.** Three, not four,
not six. If you cannot describe the change in plain prose in its spec, you do
not understand it well enough to merge.

## Canonical-home map

The map of concerns to canonical homes is the table at the top of `/AGENTS.md` —
one place, owned by the project. If a concern is not in it, pick one canonical
home and add a row there. As the project grows, add directories with their own
rows: `runbooks/` for operational procedure, `design/` for product intent, a
structure map once the codebase has shape.

## Concrete triggers

- New externally visible capability → new capability spec under `specs/<area>/`.
- New cross-cutting invariant on an entity → the entity's spec (create it if
  missing); capability specs link to it.
- Renamed route, changed status code, new flag, changed exit code → spec edit.
- Swapping a load-bearing dependency or reversing a decision → a **new** record
  that supersedes; edit only the old record's Status line.
- New or renamed developer-facing command → README, plus the AGENTS.md Commands
  list when it gates done (the one sanctioned restatement).

If you find yourself updating a second doc "to keep it consistent", **stop** —
link to the canonical home instead. That second doc is supposed to be derived,
not parallel.

## Decisions vs specs vs docs

- **Specs** — *what* the system does; the contract callers see.
- **Decisions** — *why*; the reasoning behind the shape.
- **Docs** (guides, runbooks, design) — *how things hang together* for someone
  landing cold.

A new endpoint goes in a spec. The decision to have it goes in a decision
record. Overview docs link to both — they do not restate them.

## Generated vs hand-written

`pnpm docs:gen` generates the mechanical skeleton — the decisions index and the
specs index. The VitePress sidebars
are derived live at build time from the same readers, so they cannot drift
either. Never hand-edit generated output; change the source files and re-run.
`pnpm docs:check` enforces the couplings generation cannot (Source and Tests
paths resolve, formats hold; stale review dates surface as warnings for a human
re-read). CI runs both and fails on drift.

## In-flight planning

Plans, sketches, and pre-merge proposals are ephemeral — conversations, scratch
files, PR descriptions. Once a change ships, the decision record captures the
durable *why* and the spec the durable *what*. Do not merge planning artifacts
into `docs/internal/`.
