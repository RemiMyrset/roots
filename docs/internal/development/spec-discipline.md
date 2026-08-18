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
3. **The spec** — inside `docs/`, that is one file, not several.

**When a behavior changes, all three change in the same PR.** Three, not four,
not six. If you cannot describe the change in plain prose in its spec, you do
not understand it well enough to merge.

## Canonical-home map

| Concern | Canonical home |
|---|---|
| Why a decision was made | a new record under [decisions](../decisions/index.md) |
| What a capability does now | one capability spec under [specs](../specs/index.md) |
| An entity's cross-cutting invariants | one entity spec under [specs](../specs/index.md) |
| Decision status changes | the Status line of the original record (the record is otherwise immutable) |
| Markdown authoring rules | [markdown-portability](./markdown-portability.md) |
| Docs toolchain, recipes, growth paths | [docs-toolchain](./docs-toolchain.md) |
| Agent rules and pointers | `/AGENTS.md` — links into the homes above, never restates |
| Project commands and quickstart | `/README.md` |

If a concern is not in the table, pick one canonical home and **add a row**. As
the project grows, add directories with their own rows: `runbooks/` for
operational procedure, `design/` for product intent, a structure map once the
codebase has shape.

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

`pnpm docs:gen` generates the mechanical skeleton — the decisions index, the
specs index, and `docs/llms.txt`. The VitePress sidebars
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
