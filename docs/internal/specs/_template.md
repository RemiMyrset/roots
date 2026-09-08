# Capability or entity name

- **Source:** `path/to/implementation` <!-- repo-relative, backticked; verified by docs:check. "(pending)" is legal spec-first. -->
- **Tests:** `path/to/test` — name of the suite or describe block <!-- "(pending)" allowed, warned -->
- **Last reviewed:** YYYY-MM-DD

<!-- Two spec kinds share this template:
     CAPABILITY spec: one route, command, or observable behavior.
     ENTITY spec: one entity's cross-cutting invariants (e.g. "player name is
     unique"). Capability specs LINK to entity specs for shared invariants,
     never restate them. -->

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

Numbered branches; every branch is a binary pass/fail check. A reader of this
section can write the tests without seeing the source, and a reader of the
source can predict this section.

1. Given X, when Y, then Z.
2. ...

## Edge cases and gotchas

The traps: in-flight windows, ordering constraints, things tests cannot easily
catch. Link the decision record that explains any why; never restate it.
