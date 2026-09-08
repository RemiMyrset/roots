---
name: new-spec
description: Create a new specification (capability or entity spec) in the right area with correct format and regenerated index. Use when the user says "new spec", "spec this endpoint/entity/behavior", or new externally observable behavior is being designed. Also use unprompted when a change adds or alters externally observable behavior (a route, command, flag, exit code, or invariant) that no existing spec covers.
---

# New specification

Create a spec under `docs/internal/specs/<area>/`.

1. Decide the kind, capability or entity, per "Spec kinds" in
   `docs/template/spec-discipline.md`.
2. Pick or create the `<area>` folder (for example `api/`, `cli/`, `domain/`).
   The index and sidebar discover new areas automatically.
3. Copy `docs/internal/specs/_template.md` to `<area>/<name>.md` and fill it:
   Source and Tests bullets as backticked repo-relative paths (`(pending)` is
   legal spec-first), `- **Last reviewed:**` today. Purpose, Non-goals, Contract
   (precise inputs/outputs or invariants), Behavior as Given/When/Then branches,
   Edge cases.
4. Behavior is numbered branches, each a binary check. The test the spec must
   pass is under "Spec kinds" in `docs/template/spec-discipline.md`; a branch
   that fails it is not specified yet.
5. Run `pnpm docs:gen`, then `pnpm docs:check`; both must pass. If this spec
   ships with a behavior change, source and tests move in the same PR
   (three-place sync).

$ARGUMENTS is the capability or entity to spec if provided.
