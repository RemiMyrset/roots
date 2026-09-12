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
portability requirement. The choices, each with its why:

- One agent rulebook, `AGENTS.md`, the cross-tool standard, plus one skills
  folder and one writing-rules file, read by Claude Code, Codex, and Gemini CLI
  alike. Overlapping instruction files were the first failure in the survey.
  How each tool reads them is in [agent-surfaces](./agent-surfaces.md).
- `docs/template/` holds the rules and agent material the template owns, listed
  in [its README](./README.md). It is synced into children and never edited in
  a child, so a fix lands once. `docs/internal/` and `docs/public/` are the
  child's own and start clean; the decisions and specs folders hold only their
  index and template files.
- Decisions are MADR 4 minimal, the maintained published standard, in
  `docs/internal/decisions/NNNN-kebab-title.md`, append-only. Metadata is
  visible bold bullets because YAML frontmatter is invisible in VitePress and
  noisy on GitHub.
- Specs cover externally observable behavior under `docs/internal/specs/`, in
  the two kinds and under the three-place sync defined in
  [spec-discipline](./spec-discipline.md). A spec that lags its code misleads
  more than no spec.
- Every doc renders in GitHub, VitePress, and Obsidian, and
  `pnpm docs:portability` blocks on a violation. Docs that rendered in one tool
  and broke in the others were a survey finding.
- automd plus repo generators produce the decisions and specs indexes, and the
  drift gate refuses generated output that differs from a fresh run.
  Hand-maintained indexes went stale in every surveyed repo.
- A synced GitHub Pages workflow publishes `docs/public/` and deploys only where
  Pages is enabled, so a repository without a public site pays nothing; the
  build emits `llms.txt` (the [llms.txt](https://llmstxt.org/) standard, "SEO
  for AI") plus a markdown copy of every page but the index. No `llms-full.txt`
  and no committed repo-wide map: a corpus file is in no version of the
  standard, and coding agents inside a checkout have the rulebook, the indexes,
  and file search. The recipe is in [docs-toolchain](./docs-toolchain.md); the
  template's own public site is the live demo.
- The stack is a TypeScript-first pnpm + Turborepo monorepo, node 24 minimum,
  with no JavaScript files: erasable-syntax TypeScript runs natively. No `class`
  or `enum`, functions and plain objects/union types only, enforced by ESLint
  `no-restricted-syntax` (enums also by `erasableSyntaxOnly`). When a dependency
  demands a subclass, escape with
  `// eslint-disable-next-line no-restricted-syntax -- <reason>`.
- Unit tests live in a sibling `test/` directory beside `src/`, never colocated:
  the unjs and antfu house layout. Every exported symbol carries a `/** */`
  block; ESLint `jsdoc/require-jsdoc` enforces presence, review enforces
  content.
- `secretlint` with the recommended preset runs on staged files at commit, in
  `pnpm verify`, and in CI: npm-native, no binary, no licence. It is the
  write-side counterpart to the secret-read guard.
- Renovate keeps dependencies and action pins current from one synced
  `renovate.json`: one grouped pull request a week, a two-day release cooldown,
  and automerge for the npm updates the done gate proves; action bumps and
  majors wait for a human. Dependabot's one pull request per dependency was
  the noise this replaces; the recipe is in
  [docs-toolchain](./docs-toolchain.md#keep-dependencies-current-with-renovate).
- One pre-tool dispatcher runs node-only `deny-*` guards in all three tools, no
  shell shims and no npm dependencies, so they work before `pnpm install`. What
  they block, and what they cannot, is in [guards](./guards.md).
- Template updates are pull-based and plain git: no bot, no token, nothing to
  install. `pnpm sync:template` stages the template's version of the synced
  paths, records the sync point, and prints the follow-ups a file copy cannot
  carry, for template copies, forks, and pre-existing repos alike.
  `package.json` and `.claude/settings.json` are never synced, so a template
  change that needs a hand-edit ships as a breaking Conventional Commit whose
  footer states it; recipe and contract are in
  [sync-template](./sync-template.md).

## Consequences

Enforcement no longer depends on memory: `pnpm docs:check`,
`pnpm docs:portability`, and the drift gate hold the conventions. A deployed
public site is discoverable by AI crawlers and agents out of the box, with
nothing to maintain by hand.

Against that, the docs toolchain requires node 24 and pnpm even in repos whose
product stack is something else. Sequential decision numbering can collide
across parallel branches; solo/small-team use accepts this. Template changes
never apply automatically: the follow-ups report is advisory, and a child that
never syncs keeps drifting.
