---
name: new-spec
description: Create a new specification (capability or entity spec) in the right area with the correct format. Use when the user says "new spec", "spec this endpoint/entity/behavior", or new externally observable behavior is being designed. Also use unprompted when a change adds or alters externally observable behavior (a route, command, flag, exit code, or invariant) that no existing spec covers.
---

# New specification

Create a spec under `docs/internal/specs/<area>/`.

0. If this is the roots template itself, write nothing under
   `docs/internal/specs/`. Use the check in step 0 of the `first-run` skill.
   Every child starts with a copy of `docs/internal/specs/`, so it stays clean
   here (see "What roots chose" in `docs/template/conventions.md`). A
   template mechanic's contract lives in its page under `docs/template/`, in
   the shape of `sync-template.md`: Source, Tests, and Last reviewed bullets,
   which `pnpm docs:check` holds to the spec rules. Edit that page, or add one
   and list it in `docs/template/README.md`, then stop.
1. Decide the kind, capability or entity, per "Spec kinds" in
   `docs/template/spec-discipline.md`.
2. Pick or create the `<area>` folder (for example `api/`, `cli/`, `domain/`).
   The handbook sidebar and `pnpm docs:list` discover new areas automatically.
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

If the request names the capability or entity, use it.
