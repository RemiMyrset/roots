---
name: Agent task
about: A well-scoped task an AI agent can execute end to end
labels: agent-task
---

## Goal

<!-- One sentence: the outcome, not the implementation. -->

## Context

<!-- Why this matters; links to the relevant spec/decision/docs. -->

## Requirements

- R1:
- R2:

## Acceptance criteria

<!-- Every criterion is binary pass/fail. Given/When/Then where it helps. -->

- [ ] AC1: Given ..., when ..., then ...
- [ ] AC2:

## Non-goals

<!-- The biggest lever against scope creep. -->

-

## Technical constraints

- Follow `AGENTS.md` (conventions, commands, spec discipline).
- Behavior change → source + tests + spec in the same PR.
- No new dependencies unless a requirement names them; if one seems necessary,
  stop and comment on the issue with the candidate and why, instead of adding it.
- Do not modify unrelated functionality.

## Testing requirements

<!-- New tests expected. The exact gate commands live in the Commands section of
     AGENTS.md — they define "done" — so run those (`pnpm verify` runs them all). -->

- Every non-interactive command in the `AGENTS.md` Commands section passes clean
  (skip the `docs:*:dev` previews — they are dev servers, not gates).
