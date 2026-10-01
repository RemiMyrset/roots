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

- a decision is named `YYYYMMDD-kebab-title.md` with a real date from 2000
  on, no more than a day ahead, and the title alone as its H1, which opens
  with no number and dot, no `NNNN.` placeholder, and no date; or it is a
  legacy `NNNN-kebab-title.md` whose H1 opens with the same number and whose
  number no other legacy record shares
- a name that opens with a hyphenated date, such as `2026-09-29-x.md`,
  `2026-9-29-x.md`, or `2026-09-29.md`, is an error, since it would read as
  record 2026
- a decision's Status is exactly `proposed`, `accepted`, `rejected`, or
  `deprecated` (HTML comments on the line ignored), or a superseded status
  that links the newer record with that record's ID as the link text (a
  dated name without `.md`, or a legacy number), and that record exists and
  is not the record itself; its Date is real
- a legacy record whose Date is later than the earliest dated record's
  filename date is a warning: either it was numbered by habit, or the dated
  record is named for a day before it was created. A numbered record made
  before any dated one exists passes unwarned; only the duplicate-number
  check catches its collision
- a spec's Source and Tests each name at least one backticked path, and
  every backticked path resolves in the case written (a `:42` or `#L42`
  suffix is dropped first; a route file such as `[slug]/+page.ts` is a
  path); its Last reviewed date is real (a warning after 180 days); a Source
  or Tests value that opens with `(pending)` is a warning instead, and HTML
  comments in the value are ignored. A bullet may wrap onto indented lines,
  and the paths there are checked too; a path itself stays on one line
- specs sit one level below an area, never at the top or nested deeper
- a template page with a Source bullet meets the spec rules above; its
  stale-date warning tells a child to run `pnpm sync:template`, since only
  the template edits the page
- both index pages exist; neither needs a region
- no committed automd warning comment, and every automd region under `docs/`
  is closed and free of merge conflict lines; an index region is also current
  with its generator (the drift gate holds any other region), and a conflicted
  one's error says deleting it stops the next one
- no page under `docs/` holds a `<<<<<<<` conflict line outside a region or a
  fence
- every `AGENTS.md` in this checkout is within the 200-line budget; a
  directory with its own `.git` entry (a worktree under `.claude/worktrees/`, a
  nested clone) is another checkout and is skipped
- `.agents/skills` matches `.claude/skills` byte for byte
- every `.claude/skills/<dir>/SKILL.md` opens with a closed frontmatter block
  Codex can parse as YAML (it skips a skill whose frontmatter fails):
  - each line is a top-level `key: value` (each key set once), a continuation
    indented with spaces, a list item under an empty `key:`, a comment, or a
    blank line; no line's indentation holds a tab or another space YAML reads
    as text (a no-break space, U+3000, a byte-order mark), a blank line
    included, which also refuses a few such shapes YAML takes
  - a value is trimmed of spaces and tabs alone, as YAML trims it: another
    space after a closing quote, a closing bracket, or a block indicator
    fails, and one around `name` is part of the name
  - the block holds no character YAML rejects (a control character but a tab
    and a newline, DEL, U+FFFE, U+FFFF) and no line break but a newline (NEL,
    U+2028, U+2029, a lone CR)
  - `name` is `<dir>`, written as no block scalar (YAML keeps a block
    scalar's line breaks and spaces), and `description` is a non-empty
    string; neither is a map or a list, or an unquoted value YAML reads as
    null, a boolean, a number, a date, or YAML 1.1's merge or value key
    (`true`, `yes`, `~`, `123`, `.inf`, `<<`, `=`)
  - an unquoted value holds no `: `, no ` #`, and no colon at a line end,
    opens with no character YAML reserves, and does not go on after a comment
    line
  - a quoted value closes at its end, with `''` for an apostrophe inside
    single quotes and only YAML escapes inside double quotes, none naming a
    surrogate or a code point past U+10FFFF
  - a `|` or `>` line holds only its indicators and a comment
  - each text line below it is indented at least as far as the indent digit
    or else the first text line; a less-indented comment ends the block; and
    without an indent digit, a blank line above the first text line holds no
    more spaces than it
  - a value opening with `[` or `{` closes that collection at its end, with
    only a comment after it
  - what a nested block map or list, or a flow collection, holds is not
    checked further

## In-flight planning

Plans, sketches, and pre-merge proposals live in conversations, scratch files,
and PR descriptions. Once a change ships, the decision record holds the durable
why and the spec the durable what. Do not merge planning artifacts into
`docs/internal/`.
