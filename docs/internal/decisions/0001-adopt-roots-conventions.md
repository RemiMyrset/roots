# 0001. Adopt the roots template conventions

- **Status:** accepted
- **Date:** 2026-07-03

## Context and Problem Statement

roots exists because a 19-repo fleet survey found the same failures repeated
everywhere: two or three overlapping agent-instruction files drifting apart,
hand-maintained doc indexes going stale ("24 decisions" prose beside 48 actual
records), no committed decision or spec templates, docs that rendered in one
tool but broke in others, and every new repo hand-assembling the same TypeScript
scaffold slightly differently. What single set of conventions should every
project seeded from this template start with, and how are they kept true?

## Considered Options

* A convention document that contributors are asked to follow
* CI-enforced conventions with generated mechanical sections (this template)
* Adopting an external framework wholesale (Spec-Kit, log4brains, docs generators)

## Decision Outcome

Chosen option: "CI-enforced conventions with generated mechanical sections",
because rules that only live in prose drift, and external frameworks impose
their own formats over the portability requirement. Concretely:

* **One agent rulebook**: `AGENTS.md` (the cross-tool standard) is canonical;
  `CLAUDE.md` contains only an import of it, because Claude Code reads
  `CLAUDE.md`, not `AGENTS.md`.
* **Decisions**: MADR 4 minimal (the maintained published standard) in
  `docs/internal/decisions/NNNN-kebab-title.md`, append-only, with metadata as
  visible bold bullets rather than YAML frontmatter — frontmatter is invisible
  in VitePress and noisy on GitHub.
* **Specs**: externally observable behavior under `docs/internal/specs/`, in two
  kinds — capability specs and entity specs — with three-place sync (source,
  tests, spec change in the same PR).
* **Portability**: every doc renders in GitHub, VitePress, and Obsidian;
  machine-checked by `pnpm docs:portability` (blocking).
* **Generation**: automd + repo generators produce the indexes, `docs/llms.txt`,
  and `docs/llms-full.txt`; CI diff-gates the output so generated sections can
  never drift.
* **Stack**: TypeScript-first pnpm + Turborepo monorepo, node 24 minimum, no
  JavaScript files (erasable-syntax TypeScript runs natively).

### Consequences

* Good, because conventions are enforced by `pnpm docs:check`,
  `pnpm docs:portability`, and the CI diff-gate — not by memory.
* Good, because the generated `docs/llms.txt` map and `docs/llms-full.txt`
  corpus let a docs-QA agent (for example LibreChat with the GitHub MCP server)
  ground answers in one or two deterministic fetches.
* Bad, because the docs toolchain requires node 24 and pnpm even in repos whose
  product stack is something else.
* Bad, because sequential decision numbering can collide across parallel
  branches; solo/small-team use accepts this.
