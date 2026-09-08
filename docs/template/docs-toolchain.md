# Docs toolchain

How the docs mechanics work, the recipes for what ships unwired on purpose,
and the growth paths roots leaves open.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm docs:gen` | automd indexes (decisions and specs) and the `.agents/skills` mirror (mutates files) |
| `pnpm docs:check` | structural lint: record/spec formats, Source/Tests paths, staleness |
| `pnpm docs:portability` | portability lint (GitHub, VitePress, Obsidian), blocking |
| `pnpm docs:internal:dev` / `docs:internal:build` | internal handbook site: preview / build |
| `pnpm docs:public:dev` / `docs:public:build` | public site: preview / build |

All but the two `dev` previews run inside the done gate, `pnpm verify`. CI
(`.github/workflows/docs.yml`) runs gen behind the drift gate, check,
portability, and both site builds, all blocking, plus an advisory
spec-discipline nudge on PRs.

## Adding a custom generator

A reader in `scripts/docs/readers.mts` parses a source of truth (a directory,
a source file, a schema) and a generator in `scripts/docs/generators.mts`
renders it between automd markers. The automd index and the VitePress sidebar
consume the same reader, so they cannot drift. `decisionsIndex` is the worked
example: it reads the decision files' H1 and Status bullets.

Register a new generator in `automd.config.ts` and add the marker pair to the
target page. automd also ships the built-ins `file` (inline a file),
`dir-tree`, and `fetch`.

## Recipes

Template sync has its own recipe in [sync-template](./sync-template.md#recipe).

### Publish the public site on GitHub Pages

`.github/workflows/pages.yml` is the standard, and it is synced. On a push to
`main` that touches `docs/public/`, `docs/.shared/`, `package.json`, the
lockfile, or the workflow file itself (and on manual dispatch) it builds the
public site, and when GitHub Pages is enabled for the repository it also
deploys it. Until then the run is green and says "the site was built but not
deployed", so a repository that never wants a public site pays nothing and
sees no red.

Enable it once, either under Settings → Pages → Build and deployment → Source:
GitHub Actions, or:

```sh
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
gh workflow run pages.yml                       # first deploy without waiting for a push
gh repo edit OWNER/REPO --homepage https://OWNER.github.io/REPO/
```

The site lands at `https://OWNER.github.io/REPO/` (a project site) or at the
root of `OWNER.github.io` (a user site). A custom domain set under Settings →
Pages is honoured too; add `docs/public/public/CNAME` holding the domain so the
build keeps it.

The workflow asks `actions/configure-pages` for the base path and URL and hands
them to the build as `DOCS_BASE` and `DOCS_URL`, which
`docs/public/.vitepress/config.ts` turns into VitePress `base`, a
`sitemap.xml`, and absolute links in `llms.txt`. Local builds leave both unset
and keep relative links.

The public build emits `/llms.txt`, the [llms.txt](https://llmstxt.org/)
standard that crawlers and agents fetch first, plus a clean markdown copy of
every page but the index next to its HTML, via `vitepress-plugin-llms`; the
template's own `dist/` holds `llms.txt` and `getting-started.md`. Published
through the workflow, its links are absolute and a sitemap sits beside it. The
public site ships no `robots.txt`, so AI crawlers are allowed by default.

`generateLLMsFullTxt` stays off: a concatenated corpus is in no version of the
standard, which is a search-the-map-then-follow-links model. The internal site
emits nothing for machines on purpose, and there is no committed repo-wide map
either: coding agents work from `AGENTS.md` and the generated indexes.

To opt out, list `.github/workflows/pages.yml` under `exclude` in
`.template-sync.json` and delete the file. The internal handbook is never
published this way and is access-gated when hosted at all (next recipe).

### Serve the internal handbook to the team

Local rendering (`pnpm docs:internal:dev`) is the default. For a hosted copy,
build with `pnpm docs:internal:build` and put the site behind access control
so only the team can read it: Cloudflare Access in front of Cloudflare Pages
(the free tier covers small teams), Vercel Deployment Protection, or hosting
reachable only over VPN/Tailscale. The shipped noindex meta and `robots.txt`
stay as a second guard in case a gate is ever misconfigured.

### Sandbox agents in a devcontainer

`.devcontainer/devcontainer.json` ships an environment every tool can run in:
the official TypeScript-and-node image at node 24, the Claude Code and GitHub
CLI Dev Container features, `corepack enable && pnpm install` after creation,
and the editor extensions the repo already recommends. Node 24 still bundles
corepack; from node 25, install it with `npm install -g corepack` in the image
or pin the feature's pnpm.

Open it with VS Code's "Reopen in Container", a GitHub Codespace, or the
`devcontainer` CLI. Inside it an unattended agent run cannot reach your keys,
your other repos, or anything outside the mounted workspace.

Egress control is the opt-in second step because it needs Linux container
privileges. Copy Anthropic's reference `init-firewall.sh` (the
`.devcontainer/` folder of the anthropics/claude-code repository) into
`.devcontainer/`, add `"runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"]`
and `"postStartCommand": "sudo /usr/local/bin/init-firewall.sh"` to the JSON,
and install `iptables` and `ipset` in a small Dockerfile. The script allows
only the npm registry, GitHub, and the Anthropic API, so a prompt-injected
agent has nowhere to send data.

Claude Code itself does not need the firewall or the capabilities; leave them
out if your own network controls cover it. Never mount host secrets into the
container; pass what an agent needs as environment variables.

## Growth paths

### Library packages (publish to npm)

Add `tsdown` (the Rolldown-based tsup successor) to the package: dual ESM/CJS
plus type declarations, with built-in publint and arethetypeswrong checks
(`tsdown --publint`). Add an exports map and `prepack: pnpm build`. Swap
changelogen for `changesets` the day packages need independent versions.

### Optional CI additions

- typos (crate-ci/typos) spell-checks docs; add it as an advisory step in
  `docs.yml`.
- lychee checks external URLs; run it scheduled (weekly) and advisory, since
  external links rot on their own schedule.
- Coverage thresholds are vitest `coverage.thresholds` plus the `text-summary`
  reporter printed in CI logs, with no external service. They wait on one
  thing: `@vitest/coverage-v8` is omitted repo-wide until vitepress moves off
  vite 5 (see the `vite` note in `pnpm-workspace.yaml`), so re-add the dep and
  the coverage block first.
- Going public means CodeQL default setup, actions/dependency-review, and the
  OSSF scorecard, all free only on public repos.
- Issue forms in YAML are what GitHub recommends for validated input; the
  markdown `agent-task` template stays the default because agents author
  markdown trivially.

### Toolchain pinning beyond node

`.node-version` is the portable pin, read by fnm, mise, volta, nvm, Vercel,
and Netlify. For one file covering node, pnpm, and other tools, add
`mise.toml` and keep `.node-version` for compatibility. The `packageManager`
field in `package.json` is an exact hash-pinned pnpm version that never
floats; refresh it periodically with `corepack use pnpm@latest` (or
`pnpm self-update` where pnpm is not corepack-managed), and both rewrite the
version and its hash.

### Known migration risks

- VitePress 2 is still alpha. `vitepress-plugin-mermaid` is unmaintained;
  `vitepress-mermaid-renderer` replaces it once VitePress 2 is stable.
- Math rendering is off by default; set `markdown: { math: true }` and add
  `markdown-it-mathjax3` if a project needs formulas.
- TypeScript 7 (tsgo) is near GA; `@typescript/native-preview` can serve as a
  fast pre-check (`tsgo --noEmit`), but keep `tsc` as the source-of-truth
  checker until full parity.

### MCP servers and spec frameworks

Project-scoped MCP servers go in `.mcp.json` when a real need appears, for
example a browser-automation server once there is a UI. Native tools plus `gh`
cover the GitHub workflows already.

If the built-in spec flow is outgrown, GitHub Spec-Kit and cc-sdd are the
standard upgrades. Both impose their own spec formats; adopt deliberately.
