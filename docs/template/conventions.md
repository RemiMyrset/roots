# roots conventions

This page is the roots template's rationale: what roots is, why it is shaped
this way, and what that costs. It ships with every child under `docs/template/`
and `pnpm sync:template` updates it. A project's own rationale goes in
`docs/internal/decisions/`.

## Why roots exists

A 19-repo fleet survey found the same failures in every repo: two or three
overlapping agent-instruction files drifting apart, hand-maintained doc indexes
going stale ("24 decisions" prose beside 48 actual records), no committed
decision or spec templates, docs that rendered in one tool and broke in others,
and every new repo hand-assembling the same TypeScript scaffold slightly
differently. The question was which single set of conventions every project
seeded from one template should start with, and how they are kept true.

## Options that were considered

Three options were weighed: a convention document that contributors are asked
to follow, CI-enforced conventions with generated mechanical sections (roots),
and adopting an external framework wholesale (Spec-Kit, log4brains, docs
generators).

## What roots chose

CI-enforced conventions with generated mechanical sections: rules that live
only in prose drift, and external frameworks impose their own formats over the
portability requirement.

`AGENTS.md`, the cross-tool standard, is the one agent rulebook. Claude Code
reads it through a one-line `CLAUDE.md` import, Codex reads it natively, and
`.gemini/settings.json` points Gemini CLI at it. Skills live once under
`.claude/skills/`; Codex and Gemini reach them through a generated
`.agents/skills/` copy (no symlinks: Windows is first-class).

The writing rules live once under `.claude/output-styles/`; a SessionStart hook
loads them in Codex and Gemini, with no copy.

`docs/template/` holds the rules and agent material the template owns: this
page, spec discipline, markdown portability, the docs toolchain and its recipes.
It is synced into children, never rendered by either site, and never edited in
a child. `docs/internal/` and `docs/public/` are the child's own and start
clean; the decisions and specs folders hold only their index and template files.

Decisions are MADR 4 minimal (the maintained published standard) in
`docs/internal/decisions/NNNN-kebab-title.md`, append-only. Metadata is visible
bold bullets; YAML frontmatter is invisible in VitePress and noisy on GitHub.

Specs cover externally observable behavior under `docs/internal/specs/`, in two
kinds, capability specs and entity specs, with three-place sync: source, tests,
and spec change in the same PR.

Every doc renders in GitHub, VitePress, and Obsidian; `pnpm docs:portability`
checks this and blocks.

automd plus repo generators produce the decisions and specs indexes; CI
diff-gates the output so generated sections cannot drift.

A synced GitHub Pages workflow publishes `docs/public/` on a push to `main`
that touches its inputs, deploying only where Pages is enabled; the template's
own public site is the live demo.

The public site build emits `llms.txt` (the [llms.txt](https://llmstxt.org/)
standard, "SEO for AI") plus a markdown copy of every page but the index, via
`vitepress-plugin-llms`; that is the web-facing artifact for crawlers and agents
on a deployed site. There is no committed repo-wide map and no concatenated
`llms-full.txt`: coding agents inside a checkout have the rulebook, the indexes,
and file search, and a corpus file is in no version of the standard.

The stack is a TypeScript-first pnpm + Turborepo monorepo, node 24 minimum,
with no JavaScript files (erasable-syntax TypeScript runs natively). No `class`
or `enum`: functions and plain objects/union types only, enforced by ESLint
`no-restricted-syntax` (enums also by `erasableSyntaxOnly`). When a dependency
demands a subclass, escape with
`// eslint-disable-next-line no-restricted-syntax -- <reason>`.

Unit tests live in a sibling `test/` directory beside `src/`, never colocated
(the unjs and antfu house layout). Every exported symbol carries a `/** */`
block; ESLint `jsdoc/require-jsdoc` enforces presence, review enforces content.

`secretlint` (npm-native, no binary, no licence) with the recommended preset
runs on staged files at commit, in `pnpm verify`, and in CI. It is the
write-side counterpart to the secret-read guard.

One pre-tool dispatcher, registered in Claude Code, Codex, and Gemini CLI, runs
node-only `deny-*` guards (no shell shims, no npm dependencies). They block
non-pnpm package managers, dependency build scripts, shell reads of secrets,
pushes to protected branches (`PROTECTED_BRANCHES`, default `main`;
feature-branch pushes are allowed), and git-hook bypasses (`--no-verify`,
hooks-path overrides, skip variables). Threat model and scope live in
[guards](./guards.md); the fixture suite (`pnpm test:hooks`) pins every covered
case.

Template updates are pull-based and plain git. `pnpm sync:template` stages the
template's version of an allow-list of mechanics paths (including
`docs/template/`, the agent registrations, and the sync script itself), records
the sync point in `.template-sync.json`, and prints the template commits since
plus the `package.json` scripts that differ, as follow-ups. It works for
template copies, forks, and pre-existing repos alike (the first sync infers its
baseline), and a child can pin a template branch or tag with `ref`.

`package.json` and `.claude/settings.json` are never synced; a template change
that needs a hand-edit ships as a breaking Conventional Commit whose footer
states it. The contract is [sync-template](./sync-template.md).

## Consequences

Enforcement no longer depends on memory: `pnpm docs:check`,
`pnpm docs:portability`, and the CI diff-gate hold the conventions. A deployed
public site is discoverable by AI crawlers and agents out of the box, with
nothing to maintain by hand.

Against that, the docs toolchain requires node 24 and pnpm even in repos whose
product stack is something else. Sequential decision numbering can collide
across parallel branches; solo/small-team use accepts this. Template changes
never apply automatically: the follow-ups report is advisory, and a child that
never syncs keeps drifting.
