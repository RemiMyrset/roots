# Agent rulebook

What this project is and does lives in [README.md](./README.md); this file is
the rulebook.

## How this file works

This file is the **rulebook**: non-negotiable conventions, the commands that define
"done", and pointers to where facts live. It is **not** the architecture handbook.
Every fact has exactly one canonical home; this file links to it, never restates it.
The one deliberate exception is the Commands list below: it restates the done gate
verbatim because it is the contract for "done" — keep it in sync when a gate
command changes. When this file and a spec or decision record disagree, the
spec/decision wins — fix the loser in the same PR. Hard budget: **200 lines**, enforced
by `pnpm docs:check`. When a section outgrows its space, move the content to its
canonical home and leave a link.

Skills (procedures) live in `.claude/skills/` and are mirrored to `.agents/skills/`
for Codex and Gemini CLI; path-scoped rules live in `.claude/rules/`; the guard
threat model lives in `docs/template/guards.md`; the words every page uses are
defined in the [vocabulary](./docs/template/README.md#vocabulary).

| Topic | Canonical source |
| --- | --- |
| What this project is | [README.md](./README.md) |
| Why a decision was made | [docs/internal/decisions/](./docs/internal/decisions/index.md) |
| What the system does now | [docs/internal/specs/](./docs/internal/specs/index.md) |
| One fact, one home, three-place sync | [spec-discipline](./docs/template/spec-discipline.md) |
| Markdown authoring rules | [markdown-portability](./docs/template/markdown-portability.md) |
| Docs toolchain, recipes, growth paths | [docs-toolchain](./docs/template/docs-toolchain.md) |
| Why the conventions are what they are | [conventions](./docs/template/conventions.md) (template-owned, synced) |
| Agent guard threat model | [guards](./docs/template/guards.md) |
| Template sync contract | [sync-template](./docs/template/sync-template.md) |
| Setup, install, quickstart | [README.md](./README.md) |
<!-- This table is the canonical-home map. Add one row per fact as homes appear:
     ports, env vars, glossary, deploy runbook, architecture overview, runbooks/,
     design/. If a fact has no row, pick one home, add a row. -->

## Commands

A task is complete only when every command below that your change can affect passes
clean after your last edit — when unsure which apply, run them all.

- Done gate: `pnpm verify` (everything below, in CI order; stops at the first failure)
- Install: `pnpm install`
- Build: `pnpm build` (turbo; packages that define `build`)
- Test: `pnpm test` (turbo; single package: `pnpm --filter @repo/example-package test`)
- Test hooks: `pnpm test:hooks` (agent guard allow/deny fixtures)
- Test sync: `pnpm test:sync` (template-sync fixtures)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` — run `pnpm lint:fix` after making code changes
- Secrets: `pnpm lint:secrets` (secretlint over every tracked file; also in lint-staged)
- Docs, regenerate: `pnpm docs:gen` (automd indexes and the `.agents/skills` mirror)
- Docs, validate: `pnpm docs:check && pnpm docs:portability`
- Docs, build (CI-blocking): `pnpm docs:internal:build && pnpm docs:public:build`
- Docs, preview: `pnpm docs:internal:dev` / `pnpm docs:public:dev`

## Non-negotiable rules

<!-- ALWAYS/NEVER imperatives, one or two lines each, mechanism in parentheses, a
     pointer for the rest. Add a rule only after an agent actually got it wrong —
     every rule you add dilutes every other rule. Prune rules that stop being true. -->

- ALWAYS use `pnpm`, never npm, yarn, or bun (guard-enforced in Claude Code, Codex,
  and Gemini CLI; `npx` passes as a one-off runner, prefer `pnpm dlx`).
- ALWAYS use TypeScript: no `.js`/`.mjs`, erasable syntax only, no `class`, explicit
  `.ts`/`.mts` on relative imports (tsc `erasableSyntaxOnly` and ESLint; the escape
  hatch for a dependency that demands a subclass is in [conventions](./docs/template/conventions.md)).
- ALWAYS write docs as portable markdown (`pnpm docs:portability`; rules in
  [markdown-portability](./docs/template/markdown-portability.md)).
- ALWAYS write Conventional Commits with a subject of at most 50 characters
  (commitlint), and NEVER bypass a git hook (guard-enforced): fix the failing check.
- ALWAYS give every exported symbol a `/** */` block saying what it is for and what
  a caller cannot see from the signature (presence is lint-enforced; content is on you).
- NEVER push to a protected branch: `PROTECTED_BRANCHES` in the `env` block of
  `.claude/settings.json`, default `main` (guard-enforced; the GitHub ruleset is the
  server-side boundary). Feature branches push and open PRs freely; merging is a
  human action. Details in [guards](./docs/template/guards.md).
- NEVER hand-edit generated content: automd marker regions and the `.agents/skills`
  mirror (run `pnpm docs:gen`).
- NEVER rewrite an accepted decision record; supersede it and link both ways.
- NEVER run dependency build scripts or touch `allowBuilds` in `pnpm-workspace.yaml`
  (the guard blocks the flags; each existing entry is a human verdict).

## Judgment calls

For minor implementation choices — naming, file placement, the shape of a refactor,
which of two equivalent approaches — pick a reasonable option and note it in the PR
description rather than asking. Ask first only for: a change in scope, a new
dependency, deleting user data or git history, or anything a hook blocks.

## Spec discipline

When behavior changes, source, tests, and its spec change in the same PR. The
full rules — spec kinds, concrete triggers, generated versus hand-written — live in
[spec-discipline](./docs/template/spec-discipline.md) and the
[specs index](./docs/internal/specs/index.md); read them before touching
behavior.

## Monorepo map

- `packages/example-package` — `@repo/example-package`, sample library; replace
  it with (or rename it to) your first real package.
- `apps/example-app` — `@repo/example-app`, sample CLI consuming the package over
  `workspace:*` (`pnpm --filter @repo/example-app start`); replace it with your
  first real app. Placement alone registers a package — the workspace globs cover
  `apps/*` and `packages/*`; scaffold with the `new-package` skill.
<!-- Keep this a map, not a manual: one line per package, its purpose, nothing
     else. A stale map is worse than none — agents follow it literally. -->

Unit tests live in `<package>/test/`, never colocated in `src/` (a colocated test is
a lint error). A package with its own conventions gets a scoped `AGENTS.md` (same
200-line budget) plus a sibling `CLAUDE.md` holding only `@AGENTS.md`: Claude Code
discovers nested `CLAUDE.md`, never nested `AGENTS.md`, and the import resolves
relative to the file holding it.

## Gotchas

<!-- The non-obvious things an agent gets wrong on first contact: naming traps,
     ordering constraints, things tests cannot catch. Add entries as they are
     discovered; delete entries that stop being true. When you hit a non-obvious
     failure a future agent would repeat, add a one-line entry here in the same PR. -->

- `pnpm docs:gen` mutates files; never run it inside a pre-commit hook (the
  pre-commit hook runs the read-only `docs:portability` instead).
- automd swallows generator failures: it writes the error into the marker region as
  a comment and still exits 0, and the re-run is byte-identical so the drift gate
  stays green. `pnpm docs:check` is what catches it — never commit a generated
  region containing a warning comment.
- The internal handbook is for the team: if you host it, gate it behind access
  control — recipe in [docs-toolchain](./docs/template/docs-toolchain.md). It ships
  noindex + robots.txt as guards against accidental exposure.
- `pnpm install` refuses any dependency version published in the last 48 hours
  (`minimumReleaseAge` in `pnpm-workspace.yaml`); a fresh release is not a broken
  registry, wait or pin the previous version.
