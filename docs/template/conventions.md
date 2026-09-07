# roots conventions

What roots is, why it is shaped this way, and what that costs. This is the
template's own rationale, kept as a living page rather than a decision record:
it ships with every child under `docs/template/` and is updated by
`pnpm sync:template`, while the child's decision log starts empty and holds only
the child's own decisions.

## Why roots exists

roots exists because a 19-repo fleet survey found the same failures repeated
everywhere: two or three overlapping agent-instruction files drifting apart,
hand-maintained doc indexes going stale ("24 decisions" prose beside 48 actual
records), no committed decision or spec templates, docs that rendered in one
tool but broke in others, and every new repo hand-assembling the same TypeScript
scaffold slightly differently. The question was which single set of conventions
every project seeded from one template should start with, and how they are kept
true.

## Options that were considered

* A convention document that contributors are asked to follow
* CI-enforced conventions with generated mechanical sections (roots)
* Adopting an external framework wholesale (Spec-Kit, log4brains, docs generators)

## What roots chose

CI-enforced conventions with generated mechanical sections, because rules that
only live in prose drift, and external frameworks impose their own formats over
the portability requirement. Concretely:

* **One agent rulebook**: `AGENTS.md` (the cross-tool standard) is canonical;
  `CLAUDE.md` contains only an import of it, because Claude Code reads
  `CLAUDE.md`, not `AGENTS.md`.
* **Template-owned docs**: `docs/template/` holds the rules and agent material
  the template owns — this page, spec discipline, markdown portability, the docs
  toolchain and its recipes. It is synced into children, never rendered by
  either site, and never edited in a child. `docs/internal/` and `docs/public/`
  are the child's own and start clean: the decisions and specs folders hold only
  their index and template files.
* **Decisions**: MADR 4 minimal (the maintained published standard) in
  `docs/internal/decisions/NNNN-kebab-title.md`, append-only, with metadata as
  visible bold bullets rather than YAML frontmatter — frontmatter is invisible
  in VitePress and noisy on GitHub.
* **Specs**: externally observable behavior under `docs/internal/specs/`, in two
  kinds — capability specs and entity specs — with three-place sync (source,
  tests, spec change in the same PR).
* **Portability**: every doc renders in GitHub, VitePress, and Obsidian;
  machine-checked by `pnpm docs:portability` (blocking).
* **Generation**: automd + repo generators produce the indexes and `docs/llms.txt`;
  CI diff-gates the output so generated sections can never drift. `docs/llms.txt`
  follows [llms.txt v2](https://llmstxt.org/) — agents search the map and follow the
  links. No concatenated corpus is generated: `llms-full.txt` appears in no version
  of that spec, and a whole-corpus artifact grows with the child repo rather than
  with the template. Paths are repo-relative rather than URLs, a deliberate
  deviation, because the consumer fetches by exact path out of a private repo.
* **Stack**: TypeScript-first pnpm + Turborepo monorepo, node 24 minimum, no
  JavaScript files (erasable-syntax TypeScript runs natively), and no `class` or
  `enum` — functions and plain objects/union types only, enforced by ESLint
  `no-restricted-syntax` (enums also by `erasableSyntaxOnly`). Unit tests live in
  a sibling `test/` directory beside `src/`, never colocated — the unjs and antfu
  house layout.
* **Agent guards**: one PreToolUse dispatcher runs node-only `deny-*` guards
  (no shell shims, no npm dependencies) that block non-pnpm package managers,
  dependency build scripts, shell reads of secrets, and pushes to protected
  branches (`PROTECTED_BRANCHES`, default `main`; feature-branch pushes are
  allowed). Threat model and scope live in `SECURITY.md`; the fixture suite
  (`pnpm test:hooks`) pins every covered case.

## Consequences

* Good, because conventions are enforced by `pnpm docs:check`,
  `pnpm docs:portability`, and the CI diff-gate — not by memory.
* Good, because the generated `docs/llms.txt` map lets a docs-QA agent (for
  example LibreChat with the GitHub MCP server) start from one deterministic fetch
  and follow exact paths from there, instead of relying on code search.
* Bad, because the docs toolchain requires node 24 and pnpm even in repos whose
  product stack is something else.
* Bad, because sequential decision numbering can collide across parallel
  branches; solo/small-team use accepts this.
