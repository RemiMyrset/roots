---
name: new-spec
description: Create a new specification (capability or entity spec) in the right area with correct format and regenerated index. Use when the user says "new spec", "spec this endpoint/entity/behavior", or new externally observable behavior is being designed. Also use unprompted when a change adds or alters externally observable behavior (a route, command, flag, exit code, or invariant) that no existing spec covers.
---

# New specification

Create a spec under `docs/internal/specs/<area>/`.

1. Decide the kind: a **capability spec** covers one route/command/observable
   behavior; an **entity spec** covers one entity's cross-cutting invariants
   (uniqueness, casing, limits). Capability specs LINK to entity specs for
   shared invariants — never restate them.
2. Pick or create the `<area>` folder (for example `api/`, `cli/`, `domain/`).
   New areas are discovered automatically by the index and sidebar.
3. Copy `docs/internal/specs/_template.md` to `<area>/<name>.md` and fill it:
   Source and Tests bullets as backticked repo-relative paths (`(pending)` is
   legal spec-first), `- **Last reviewed:**` today. Purpose, Non-goals, Contract
   (precise inputs/outputs or invariants), Behavior as numbered binary
   Given/When/Then branches, Edge cases.
4. A reader of the spec must be able to write the tests without seeing the
   source. If a branch cannot be phrased as pass/fail, it is not specified yet.
5. Run `pnpm docs:gen`, then `pnpm docs:check` — both must pass before you are
   done. If this spec ships with a behavior change, source and tests move in the
   same PR (three-place sync).

$ARGUMENTS is the capability or entity to spec if provided.
