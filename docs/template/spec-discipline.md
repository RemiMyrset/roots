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

## Spec kinds

A capability spec covers one route, command, or observable behavior. An entity
spec covers one entity's cross-cutting invariants: "player name is unique" (its
scope, casing, and normalization) lives in the player entity spec, and the
create and rename capability specs link to it and state only their own outcome,
such as a `duplicate_name` rejection.

Either kind describes the contract between caller and implementation, never a
rephrasing of the source or a list of functions called. A spec passes one test:
a reader of the spec can write the tests without seeing the source, and a
reader of the source can predict the spec. When they disagree, the spec lagged
a code change; fix it in the same PR.

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
  Commands list when it is part of the done gate (the one sanctioned
  restatement).

When you catch yourself updating a second doc to keep it consistent, stop and
link to the canonical home instead. That second doc is derived.

## Decisions vs specs vs docs

A spec says what the system does, the contract callers see. A decision says
why, the reasoning behind the shape. Docs (guides, runbooks, design) say how
things hang together for someone landing cold.

A new endpoint goes in a spec, the decision to have it in a decision record,
and overview docs link to both without restating them.

## Generated vs hand-written

No committed file lists the decisions or specs. The VitePress sidebars and
`pnpm docs:list` read them from the files through the same readers, so they
cannot drift. `pnpm docs:gen` rewrites the `.agents/skills` mirror and any
automd region a page opts into. Never hand-edit generated output; change the
source files and re-run.

`pnpm docs:check` enforces the couplings generation cannot. CI runs both and
fails on drift. The checks:

- a decision is named `YYYYMMDD-kebab-title.md` with a real date no more than
  a day ahead and the title alone as its H1, or is a legacy
  `NNNN-kebab-title.md` whose H1 opens with the same number and whose number
  no other legacy record shares; a name that opens with a hyphenated date,
  such as `2026-09-29-`, is an error, since it would read as record 2026
- a decision's Status is in the vocabulary; a superseded status links the
  newer record with that record's ID as the link text (a dated name without
  `.md`, or a legacy number), and that record exists; its Date is real
- a legacy record whose Date is later than the earliest dated record's
  filename date is a warning: it was most likely numbered by habit, and new
  records are dated
- a spec's Source and Tests paths resolve, and its Last reviewed date is real
  (a warning after 180 days); a Source or Tests value that opens with
  `(pending)` is a warning instead, and HTML comments on the line are ignored
- specs sit one level below an area, never at the top or nested deeper
- a template page with a Source bullet meets the spec rules above
- both index pages exist; neither needs a region
- no committed automd warning comment, and every automd region under `docs/`
  is closed, free of merge conflict lines, and current with its generator
- no page under `docs/` holds a `<<<<<<<` conflict line outside a region or a
  fence
- every `AGENTS.md` is within the 200-line budget
- `.agents/skills` matches `.claude/skills` byte for byte

## In-flight planning

Plans, sketches, and pre-merge proposals live in conversations, scratch files,
and PR descriptions. Once a change ships, the decision record holds the durable
why and the spec the durable what. Do not merge planning artifacts into
`docs/internal/`.
