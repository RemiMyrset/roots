# Agent rulebook

What this project is and does lives in [README.md](./README.md); this file is
the rulebook.

## How this file works

This file is the **rulebook**: non-negotiable conventions, the commands that define
"done", and pointers to where facts live. It is **not** the architecture handbook.
Every fact has exactly one canonical home; this file links to it, never restates it.
The one deliberate exception is the Commands list below: it restates the done-gates
verbatim because they are the contract for "done" — keep it in sync when a gate
command changes. When this file and a spec or decision record disagree, the
spec/decision wins — fix the loser in the same PR. Hard budget: **200 lines**, enforced
by `pnpm docs:check`. When a section outgrows its space, move the content to its
canonical home and leave a link.

| Topic | Canonical source |
| --- | --- |
| Why a decision was made | [docs/internal/decisions/](./docs/internal/decisions/index.md) |
| What the system does now | [docs/internal/specs/](./docs/internal/specs/index.md) |
| One fact, one home, three-place sync | [spec-discipline](./docs/template/spec-discipline.md) |
| Markdown authoring rules | [markdown-portability](./docs/template/markdown-portability.md) |
| Docs toolchain, recipes, growth paths | [docs-toolchain](./docs/template/docs-toolchain.md) |
| Why the conventions are what they are | [conventions](./docs/template/conventions.md) (template-owned, synced) |
| Agent guard threat model | [guards](./docs/template/guards.md) |
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
- Test hooks: `pnpm test:hooks` (PreToolUse guard allow/deny fixtures)
- Test sync: `pnpm test:sync` (template-sync fixtures)
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` — run `pnpm lint:fix` after making code changes
- Secrets: `pnpm lint:secrets` (secretlint over every tracked file; also in lint-staged)
- Docs, regenerate: `pnpm docs:gen` (automd indexes)
- Docs, validate: `pnpm docs:check && pnpm docs:portability`
- Docs, build (CI-blocking): `pnpm docs:internal:build && pnpm docs:public:build`
- Docs, preview: `pnpm docs:internal:dev` / `pnpm docs:public:dev`

## Non-negotiable rules

<!-- ALWAYS/NEVER imperatives, one line each, one-clause rationale when non-obvious.
     Add a rule only after an agent actually got it wrong — every rule you add
     dilutes every other rule. Prune rules that stop being true. -->

- ALWAYS use `pnpm`. Never npm, yarn, or bun. Enforced by a pre-tool hook in Claude
  Code, Codex, and Gemini CLI. (`npx` passes — one-off bin runner; prefer `pnpm dlx`.)
- ALWAYS use TypeScript. No `.js` or `.mjs` files — node 24 runs `.ts`/`.mts`
  natively. Keep syntax erasable (no enums/namespaces/param-properties, enforced
  by `erasableSyntaxOnly`); never declare a `class` (banned by ESLint
  `no-restricted-syntax` — use functions and plain objects; escape with an
  `// eslint-disable-next-line no-restricted-syntax -- <reason>` when a dependency
  demands a subclass); and give relative imports explicit `.ts`/`.mts` extensions.
- ALWAYS write docs as portable markdown (GitHub + VitePress + Obsidian). Rules:
  [markdown-portability](./docs/template/markdown-portability.md).
  Enforced by `pnpm docs:portability`.
- ALWAYS write commits as Conventional Commits (`type(scope): subject`, subject
  ≤ 50 chars) — enforced by the commitlint `commit-msg` hook; `pnpm release`
  builds the changelog from them. NEVER bypass a git hook (`--no-verify`, `-n`,
  a `core.hooksPath` override, `SKIP_SIMPLE_GIT_HOOKS`): fix the failing check.
  Guard-enforced.
- ALWAYS give every exported symbol a `/** */` block saying what it is for and
  any constraint a caller cannot see from the signature — never a restatement of
  the code. Presence is enforced by ESLint `jsdoc/require-jsdoc`; content is on you.
- NEVER push to a protected branch. Default `main`; the list is `PROTECTED_BRANCHES`
  (comma-separated globs, e.g. `main,release/*`) in the `env` block of
  `.claude/settings.json`. A pre-tool guard denies it, along with `--force`/`--all`/
  `--mirror` pushes and `pnpm release` (its push runs inside changelogen — human-run
  only); the GitHub branch ruleset is the server-side boundary. Feature branches:
  commit, push, and open PRs freely — `git push` and read-only `gh` commands are
  allow-listed, `--force-with-lease` passes. Merging into a protected branch is a
  human action: `gh pr merge` always prompts.
- NEVER hand-edit content between `automd` markers — edit the source, run
  `pnpm docs:gen`.
- NEVER rewrite an accepted decision record. Supersede it with a new one and link
  both ways; only the old record's Status line changes.
- NEVER run dependency build scripts (`pnpm approve-builds`) or add or change
  `allowBuilds` entries — supply-chain code-exec vector;
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

Unit tests live in `<package>/test/`, never colocated in `src/` — the sibling
layout every unjs and antfu upstream uses; Vitest's default glob finds it with no
config, and a colocated test is a lint error.

When a package grows its own conventions, give it a scoped `AGENTS.md` — same
200-line budget — and a sibling `CLAUDE.md` next to it containing only `@AGENTS.md`.
Both files are required: Claude Code discovers nested `CLAUDE.md`, never nested
`AGENTS.md`, so the scoped rulebook is dead on its own. The import is the bare
`@AGENTS.md` — it resolves relative to the file holding it, so
`packages/foo/CLAUDE.md` picks up `packages/foo/AGENTS.md`, not the root.

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
  control — recipe in
  [docs-toolchain](./docs/template/docs-toolchain.md). It ships
  noindex + robots.txt as guards against accidental exposure.
