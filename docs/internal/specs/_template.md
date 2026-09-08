# Capability or entity name

- **Source:** `path/to/implementation` <!-- repo-relative, backticked; verified by docs:check. "(pending)" is legal spec-first. -->
- **Tests:** `path/to/test` — name of the suite or describe block <!-- "(pending)" allowed, warned -->
- **Last reviewed:** YYYY-MM-DD

<!-- Capability and entity specs share this template; the two kinds are under
     "Spec kinds" in docs/template/spec-discipline.md. -->

## Purpose

One paragraph: what this capability or entity is for and who depends on it.

## Non-goals

- What this deliberately does NOT do, so neither humans nor agents grow the
  scope. Delete the section only if truly empty.

## Contract

Inputs and outputs, precisely: for an API, method, path, params, body, and
every response code; for a CLI, flags, exit codes, and stdout/stderr shape; for
an entity, its invariants (uniqueness scope, casing, normalization, limits).
Machine-readable shapes (schemas, types) beat prose.

## Behavior

Numbered branches, each a binary check. The test this section must pass is
under "Spec kinds" in `docs/template/spec-discipline.md`.

1. Given X, when Y, then Z.
2. ...

## Edge cases and gotchas

The traps: in-flight windows, ordering constraints, things tests cannot easily
catch. Link the decision record that explains any why; never restate it.
