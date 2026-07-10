<!-- roots:template-only -->
> [!IMPORTANT]
> This repository is an **uninitialized copy of the roots template**. Before any
> other work, run `node scripts/init.mts` (non-interactive: `--defaults`). It
> renames the project, resets the decision log, strips these template-only
> banners, and deletes itself. This banner disappears once init has run.
>
> **Exception:** if you are working on the roots template itself (this repo is
> `RemiMyrset/roots`), do NOT run init — the banners and `scripts/init.mts` are
> the product, not scaffolding to remove.
<!-- /roots:template-only -->

# roots agent rulebook

Rapid Opinionated Onboarding — TypeScript. A template repository that seeds
AI-agent-ready pnpm + Turborepo monorepos with a specs-and-decisions docs system.
<!-- After init: replace the two lines above with one sentence saying what THIS
     project is and does. Elevator pitch only — details live in docs/. -->

## How this file works

This file is the **rulebook**: non-negotiable conventions, the commands that define
"done", and pointers to where facts live. It is **not** the architecture handbook.
Every fact has exactly one canonical home; this file links to it, never restates it.
The one deliberate exception is the Commands list below: it restates the done-gates
verbatim because they are the contract for "done" — keep it in sync when a gate
command changes. When this file and a spec or decision record disagree, the
spec/decision wins — fix the loser in the same PR. Hard budget: **200 lines**. When
a section outgrows its space, move the content to its canonical home and leave a link.

| Topic | Canonical source |
| --- | --- |
| Why a decision was made | [docs/internal/decisions/](./docs/internal/decisions/index.md) |
| What the system does now | [docs/internal/specs/](./docs/internal/specs/index.md) |
| One fact, one home, three-place sync | [spec-discipline](./docs/internal/development/spec-discipline.md) |
| Markdown authoring rules | [markdown-portability](./docs/internal/development/markdown-portability.md) |
| Docs toolchain, recipes, growth paths | [docs-toolchain](./docs/internal/development/docs-toolchain.md) |
| Setup, install, quickstart | [README.md](./README.md) |
| Machine-readable docs map and corpus | `docs/llms.txt` and `docs/llms-full.txt` (generated) |
<!-- Add one row per fact as homes appear: ports, env vars, glossary, deploy
     runbook, architecture overview. If a fact has no row, pick a home, add a row. -->

## Commands

A task is complete only when every command below that your change can affect passes
clean after your last edit — when unsure which apply, run them all.

- Install: `pnpm install`
- Build: `pnpm build` (turbo; packages that define `build`)
- Test: `pnpm test` (turbo; single package: `pnpm --filter @roots/core test`)
- Test hooks: `pnpm test:hooks` (PreToolUse guard allow/deny fixtures)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` — run `pnpm lint:fix` after making code changes
- Docs, regenerate: `pnpm docs:gen` (automd indexes + llms.txt + llms-full.txt)
- Docs, validate: `pnpm docs:check && pnpm docs:portability`
- Docs, build (CI-blocking): `pnpm docs:internal:build && pnpm docs:public:build`
- Docs, preview: `pnpm docs:internal:dev` / `pnpm docs:public:dev`

## Non-negotiable rules

<!-- ALWAYS/NEVER imperatives, one line each, one-clause rationale when non-obvious.
     Add a rule only after an agent actually got it wrong — every rule you add
     dilutes every other rule. Prune rules that stop being true. -->

- ALWAYS use `pnpm`. Never npm, yarn, or bun. Enforced by a PreToolUse hook. (`npx`
  passes — one-off bin runner; prefer `pnpm dlx`.)
- ALWAYS use TypeScript. No `.js` or `.mjs` files — node 24 runs `.ts`/`.mts`
  natively. Keep syntax erasable (no enums/namespaces/param-properties, enforced
  by `erasableSyntaxOnly`); never declare a `class` (banned by ESLint
  `no-restricted-syntax` — use functions and plain objects; escape with an
  `// eslint-disable-next-line no-restricted-syntax -- <reason>` when a dependency
  demands a subclass); and give relative imports explicit `.ts`/`.mts` extensions.
- ALWAYS write docs as portable markdown (GitHub + VitePress + Obsidian). Rules:
  [markdown-portability](./docs/internal/development/markdown-portability.md).
  Enforced by `pnpm docs:portability`.
- ALWAYS write commits as Conventional Commits (`type(scope): subject`, subject
  ≤ 50 chars) — enforced by the commitlint `commit-msg` hook; `pnpm release`
  builds the changelog from them.
- ALWAYS give every exported symbol a `/** */` block saying what it is for and
  any constraint a caller cannot see from the signature — never a restatement of
  the code. Convention, not lint-enforced.
- NEVER `git push`. Pushing is a human operation: `.claude/settings.json` denies
  it, and `pnpm release` is the only sanctioned path (it confirms with you
  first). Commit freely; leave the push to the human.
- NEVER hand-edit content between `automd` markers or the generated
  `docs/llms.txt` / `docs/llms-full.txt` — edit the source, run `pnpm docs:gen`.
- NEVER rewrite an accepted decision record. Supersede it with a new one and link
  both ways; only the old record's Status line changes.
- NEVER run dependency build scripts (`pnpm approve-builds`) or add or change
  `allowBuilds` / `onlyBuiltDependencies` entries — supply-chain code-exec vector;
  each entry is a human verdict. The entries already in `pnpm-workspace.yaml` are
  such verdicts — leave them alone. The hook blocks the CLI flags; config edits
  are on your honor.

## Judgment calls

For minor implementation choices — naming, file placement, the shape of a refactor,
which of two equivalent approaches — pick a reasonable option and note it in the PR
description rather than asking. Ask first only for: a change in scope, a new
dependency, deleting user data or git history, or anything a hook blocks.

## Spec discipline

When behavior changes, source, tests, and its spec change in the same PR. The
full rules — spec kinds, canonical-home map, concrete triggers — live in
[spec-discipline](./docs/internal/development/spec-discipline.md) and the
[specs index](./docs/internal/specs/index.md); read them before touching
behavior.

## Monorepo map

- `packages/core` — `@roots/core` sample starter package; replace it with (or
  rename it to) your first real package.
- `apps/` — created when the first app lands; add the package to the workspace
  by directory placement alone (globs cover it; scaffold with the
  `new-package` skill).
<!-- Keep this a map, not a manual: one line per package, its purpose, nothing
     else. A stale map is worse than none — agents follow it literally. -->

Unit tests live in `<package>/test/`, never colocated in `src/` — the sibling
layout every unjs and antfu upstream uses; Vitest's default glob finds it with no
config, and a colocated test is a lint error.

When a package grows its own conventions, give it a scoped `AGENTS.md` — nearest
file wins for agents working inside it; same 200-line budget.

## Gotchas

<!-- The non-obvious things an agent gets wrong on first contact: naming traps,
     ordering constraints, things tests cannot catch. Add entries as they are
     discovered; delete entries that stop being true. When you hit a non-obvious
     failure a future agent would repeat, add a one-line entry here in the same PR. -->

- `pnpm docs:gen` mutates files; never run it inside a pre-commit hook (the
  pre-commit hook runs the read-only `docs:portability` instead).
- The internal handbook is for the team: if you host it, gate it behind access
  control — recipe in
  [docs-toolchain](./docs/internal/development/docs-toolchain.md). It ships
  noindex + robots.txt as guards against accidental exposure.
