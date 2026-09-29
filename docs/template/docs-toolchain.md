# Docs toolchain

How the docs mechanics work, the recipes for what ships unwired on purpose,
and the growth paths roots leaves open.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm docs:gen` | the `.agents/skills` mirror and any automd region a page keeps (mutates files) |
| `pnpm docs:check` | structural lint: record/spec formats, Source/Tests paths, staleness |
| `pnpm docs:list` | the decisions table and the spec list, read from the files (read-only; `decisions` or `specs` prints one) |
| `pnpm docs:portability` | portability lint (GitHub, VitePress, Obsidian), blocking |
| `pnpm docs:internal:dev` / `docs:internal:build` | internal handbook site: preview / build |
| `pnpm docs:public:dev` / `docs:public:build` | public site: preview / build |

All but `docs:list` and the two `dev` previews run inside the done gate,
`pnpm verify`. CI (`.github/workflows/docs.yml`) runs gen behind the drift
gate, check, portability, and both site builds, all blocking, plus an advisory
spec-discipline nudge on PRs.

## Adding a custom generator

A generator renders a source of truth (a directory, a source file, a schema)
between automd markers. `decisionsIndex` in `scripts/docs/generators.mts` is
the worked example: its reader in `scripts/docs/readers.mts` parses the
decision files' H1 and Status bullets, and the VitePress sidebar consumes the
same reader, so the two cannot drift.

Both files are synced: an edit to either is staged for revert on every sync.
Write your generator in a file of your own under `scripts/docs/` that the
template does not ship, such as `scripts/docs/project-generators.mts`; the
sync leaves such a file alone, and it may import the readers.

Register it in `automd.config.ts`, which is yours unless you list it under
`include`, and add the marker pair to a page under `docs/`, the only place
automd looks. automd also ships the built-ins `file` (inline a file),
`dir-tree`, and `fetch`. The drift gate in `pnpm verify` and CI keeps such a
region current; `pnpm docs:check` checks only its shape.

A region is opt-in, and the template's own index pages carry none;
[conventions](./conventions.md) says why. A page may keep the
`decisionsIndex` or `specIndex` region, and `pnpm docs:check` still holds it
current.

A kept region conflicts whenever two branches each add an entry.
`pnpm docs:gen` fixes the conflict by rewriting the whole region, so never
merge one by hand. Deleting the region stops the conflicts, since the sidebar
and `pnpm docs:list` read the lists from the files.

## Recipes

Template sync has its own recipe in [sync-template](./sync-template.md#recipe).

### Publish the public site on GitHub Pages

`.github/workflows/pages.yml` is the standard, and it is synced. On a pull
request or a push to `main` that touches `docs/public/`, `docs/.shared/`,
`package.json`, the lockfile, or the workflow file itself (and on manual
dispatch) it builds the public site. On `main`, when GitHub Pages is enabled
for the repository, it also deploys it; a pull request only builds, so a
broken build or action pin shows before merge. Until Pages is enabled the run
is green and says "the site was built but not deployed", so a repository that
never wants a public site pays nothing and sees no red.

Enable it once, after `main` holds your own pages rather than the template's,
either under Settings → Pages → Build and deployment → Source: GitHub Actions,
or with the commands below. Pages is free on public repositories; a private
one needs GitHub Pro, Team, or Enterprise.

```sh
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
gh workflow run pages.yml                       # first deploy without waiting for a push
gh repo edit OWNER/REPO --homepage https://OWNER.github.io/REPO/
```

The site lands at `https://OWNER.github.io/REPO/` (a project site) or at the
root of `OWNER.github.io` (a user site). A custom domain set under Settings →
Pages is honoured too, and an Actions deployment needs no `CNAME` file.

The workflow asks `actions/configure-pages` for the base path and URL and hands
them to the build as `DOCS_BASE` and `DOCS_URL`, which
`docs/public/.vitepress/config.ts` turns into VitePress `base`, a
`sitemap.xml`, and absolute links in `llms.txt`. Local builds leave both unset
and keep relative links. The build checks out full history, because each
page's "Last updated" date and its sitemap `lastmod` come from `git log`; a
shallow clone stamps every page with the deploy commit's date, and
`pnpm test:gates` refuses one.

The public build emits `/llms.txt`, the [llms.txt](https://llmstxt.org/)
standard that crawlers and agents fetch first, plus a clean markdown copy of
every page but the index next to its HTML, via `vitepress-plugin-llms`; the
template's own `dist/` holds `llms.txt` and `getting-started.md`. Published
through the workflow, its links are absolute and a sitemap sits beside it. The
public site ships no `robots.txt`, so AI crawlers are allowed by default.

`generateLLMsFullTxt` stays off: a concatenated corpus is in no version of the
standard, which is a search-the-map-then-follow-links model. The internal site
emits nothing for machines on purpose, and there is no committed repo-wide map
either: coding agents work from `AGENTS.md` and `pnpm docs:list`.

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

### Keep dependencies current

Nothing updates dependencies on a schedule. Ask an agent to run the
`update-deps` skill: it lists what is outdated, raises the catalog ranges in
`pnpm-workspace.yaml`, audits, refreshes the action SHA pins and their version
comments, runs the done gate, and opens a pull request, with each major in its
own commit. pnpm refuses any version published in the last 48 hours
(`minimumReleaseAge`), at install and during an update alike, unless a
`minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` names it.
`pnpm audit --fix` writes such entries for every patched version, and the
skill keeps only the ones a fix still needs, each named in the pull request.
Why roots ships no update bot is in [conventions](./conventions.md).

First run turns on required SHA pinning for actions, which makes GitHub refuse
a workflow that references an action by a mutable tag. The check reaches
inside a pinned composite action too, so an action bump waits until the new
release's own `action.yml` has no tag-only `uses:`; the skill checks it.

```sh
gh api -X PUT repos/OWNER/REPO/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
```

### Sandbox agents in a devcontainer

`.devcontainer/devcontainer.json` ships an environment every tool can run in:
the official TypeScript-and-node image at node 24, the Claude Code and GitHub
CLI Dev Container features, `pnpm install` after creation, the editor
extensions the repo already recommends, the two VitePress dev-server ports
forwarded, and the pnpm store on a named volume, so a rebuild copies packages
from it instead of downloading them again.

The container runs as the non-root `node` user, and Docker creates the
volume's mount point owned by root, so the post-create step first hands it to
`node` with `sudo`. `pnpm_config_store_dir` then points pnpm at the volume:
the checkout is a separate mount, and without the variable pnpm keeps its
store inside the checkout.

The `pnpm` on the container's path is the image's own. It switches to the
version `packageManager` pins but, unlike corepack, does not check the
download against the pin's hash. Corepack's shims would land in a root-owned
directory behind it on the path, so the container does not enable corepack.

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

`ci.yml`, `docs.yml`, and `scripts/verify.mts` are synced, and each sync stages
the template's version over an edit to them. Your additions go in files of
your own:

- A test of your own goes in a package's `test` script. `pnpm test` runs every
  package's through turbo, so it is in the done gate and in CI with no workflow
  edit. A variable the test reads is declared under the task's `env` in
  `turbo.json`, which is yours.
- A step that needs what the synced workflows lack goes in a workflow of your
  own, such as `.github/workflows/project.yml`: a service such as Postgres, a
  secret, a schedule, or typos (crate-ci/typos) spell-checking the docs. Pin
  its actions by full commit SHA, since first run turns on required SHA
  pinning. The done gate has no extension point, so such a step checks in CI
  only.
- A step of your own that runs `pnpm <script>` but is not a gate, such as an
  e2e or deploy step, ends its line with `# not a gate`. Otherwise
  `pnpm test:gates`, which keeps `pnpm verify` and the workflows running the
  same steps, fails on it.
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

`.node-version` is the portable pin, read by fnm and Netlify, and by mise once
its `idiomatic_version_file_enable_tools` setting includes node. nvm reads
only `.nvmrc` and Volta only the `volta` field in `package.json`, so a team on
either adds that beside it. For one file covering node, pnpm, and other tools,
add `mise.toml` and keep `.node-version` for compatibility. The `packageManager`
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
