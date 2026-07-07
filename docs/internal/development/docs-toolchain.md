# Docs toolchain

How the docs machinery works, and the recipes for everything roots deliberately
does not ship wired.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm docs:gen` | automd indexes + `docs/llms.txt` + `docs/llms-full.txt` (mutates files) |
| `pnpm docs:check` | structural lint: record/spec formats, Source/Tests paths, staleness |
| `pnpm docs:portability` | trifecta lint (GitHub + VitePress + Obsidian), blocking |
| `pnpm docs:internal:dev` / `docs:internal:build` | internal handbook site |
| `pnpm docs:public:dev` / `docs:public:build` | public site |

CI (`.github/workflows/docs.yml`) runs gen (diff-gated), check, portability, and
both site builds — all blocking — plus an advisory spec-discipline nudge on PRs.

## Adding a custom generator

The pattern: a reader in `scripts/docs/generators.mts` parses a source of truth
(a directory, a source file, a schema), and a generator renders it between
automd markers. Both the automd index and the VitePress sidebar consume the same
reader, so they cannot drift. Worked example: `decisionsIndex` reads the
decision files' H1 and Status bullets. Register new generators in
`automd.config.ts` and add the marker pair to the target page. automd built-ins
worth knowing: `file` (inline a file), `dir-tree`, `fetch`.

## Recipes

### Pull template updates (on demand)

A repo made from roots keeps no link back to the template — and there is no bot,
cron, or token. Pull the shared machinery whenever you want it:

```sh
pnpm sync:template            # default template URL
pnpm sync:template <fork-url> # or point at your own fork
```

It adds a `template` git remote, fetches it, and stages the template's version of
the mechanics paths (the shared CI workflows, the label list, issue/PR templates,
the docs generators and guard test-suite, and the agent hooks/rules/skills).
Review with `git diff --cached`, keep what applies, and discard the rest with
`git restore --staged --worktree <path>`. Your `package.json`, `src/`, `packages/`,
docs content, and `.claude/settings.json` are never touched. Because it is plain
git it works from any repo; edit the `MECHANICS` list in
`scripts/sync-template.mts` to change what gets pulled. The synced `scripts/docs/*`
files are `.mts`, not `.ts`, on purpose: `.mts` runs as ESM regardless of the
target repo's `package.json` `"type"`, whereas a `.ts` file is read as CommonJS in a
repo that sets `"type": "commonjs"` (or an older toolchain without module-syntax
detection), which breaks its `import`/`export`.

### Power a docs-QA chatbot (LibreChat + GitHub MCP)

The generated `docs/llms.txt` (map) and `docs/llms-full.txt` (corpus) exist for
this. In LibreChat, add the GitHub MCP server over `streamable-http` with the
PAT supplied per-user via `customUserVars` as the Authorization header; enable
only `get_file_contents` and `get_repository_tree` (code search is unreliable on
private repos: indexing lag and a separate low rate limit). Agent system prompt:
"Read `docs/llms.txt` first, fetch the exact linked paths, cite paths in
answers; `docs/llms-full.txt` holds the whole corpus if you need everything."
Skip LibreChat's RAG API — per-conversation uploads re-ingest and drift; this
corpus is small and structured enough for direct navigation.

### Deploy the public site

Options: a GitHub Pages workflow running `pnpm docs:public:build` (add
`base` to the public VitePress config for project pages), or a
`repository_dispatch` notification to a central docs-hub repo.

### Serve the internal handbook to the team

Local rendering (`pnpm docs:internal:dev`) is the default. For a hosted copy,
build with `pnpm docs:internal:build` and put the site behind access control so
only the team can read it: Cloudflare Access in front of Cloudflare Pages (free
tier covers small teams), Vercel Deployment Protection, or hosting reachable
only over VPN/Tailscale. The shipped noindex meta and `robots.txt` remain as
belt-and-braces guards in case a gate is ever misconfigured.

### Library packages (publish to npm)

Add `tsdown` (Rolldown-based tsup successor) to the package: dual ESM/CJS plus
type declarations, with built-in publint and arethetypeswrong checks
(`tsdown --publint`). Add an exports map and `prepack: pnpm build`. Swap
changelogen for `changesets` the day packages need independent versions.

### Sandbox agents in a devcontainer

Anthropic ships an official Dev Container feature —
`ghcr.io/anthropics/devcontainer-features/claude-code:1.0` — plus a reference
container with an egress-allowlist firewall (anthropics/claude-code
`.devcontainer/`). Add it when the stack lands; never mount host secrets into
the container.

### More agent surfaces

- Gemini CLI reads `GEMINI.md`, not `AGENTS.md` — symlink it if you adopt Gemini.
- Monorepo packages with their own conventions get a scoped `AGENTS.md` — see the
  Monorepo map in the root `AGENTS.md` for how nearest-file-wins and the line budget apply.
- Project-scoped MCP servers go in `.mcp.json` when a real need appears (for
  example a browser-automation server once there is a UI) — native tools plus
  `gh` cover the GitHub workflows already.
- If the built-in spec flow is outgrown, GitHub Spec-Kit and cc-sdd are the
  standard upgrades — but they impose their own spec formats; adopt deliberately.

### Optional CI additions

- **typos** (crate-ci/typos): fast spell-check over docs; add as an advisory
  step in `docs.yml`.
- **lychee**: external-URL link checker; run scheduled (weekly), advisory —
  external links rot on their own schedule.
- **Coverage thresholds**: vitest `coverage.thresholds` plus the `text-summary`
  reporter printed in CI logs; no external service needed. Currently gated —
  `@vitest/coverage-v8` is omitted repo-wide until vitepress moves off vite 5
  (see the `vite` note in `pnpm-workspace.yaml`); re-add the dep + coverage
  block first.
- **Going public checklist**: LICENSE review, SECURITY.md, CodeQL default
  setup, actions/dependency-review, OSSF scorecard — all free only on public
  repos.
- **Issue forms**: GitHub recommends YAML issue forms for validated input;
  the markdown `agent-task` template stays the default because agents author
  markdown trivially.

### Toolchain pinning beyond node

`.node-version` is the portable pin (read by fnm, mise, volta, nvm, Vercel,
Netlify). If you want one file for node + pnpm + other tools, add `mise.toml` —
but keep `.node-version` for maximum compatibility. The `packageManager` field in
`package.json` is an exact hash-pinned pnpm version that never floats — refresh it
periodically with `corepack use pnpm@latest` (or `pnpm self-update` where pnpm is
not corepack-managed); both rewrite the version and its hash.

### Known migration risks

- VitePress 2 is still alpha; when it goes stable, `vitepress-plugin-mermaid`
  (unmaintained) will likely need replacing with `vitepress-mermaid-renderer`.
- Math rendering is off by default: set `markdown: { math: true }` and add
  `markdown-it-mathjax3` if a project needs formulas.
- TypeScript 7 (tsgo) is near GA: `@typescript/native-preview` can serve as a
  fast pre-check (`tsgo --noEmit`), but keep `tsc` as the source-of-truth
  checker until full parity.
