# Docs toolchain

How the docs mechanics work, the recipes for what ships unwired on purpose,
and the growth paths roots leaves open.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm docs:gen` | the `.agents/skills` mirror and any automd region a page keeps (mutates files) |
| `pnpm docs:check` | structural lint: record/spec formats, Source/Tests paths, staleness, skill frontmatter |
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
gh workflow run pages.yml -R OWNER/REPO         # first deploy without waiting for a push
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
forwarded, and the pnpm home on a volume of its own.

The volume is named `pnpm-home-${devcontainerId}`, and the id is derived from
the checkout's path. So the volume belongs to this checkout's container alone
and survives a rebuild, which then copies packages from it instead of
downloading them again. For a clean slate, find the volume's name under
`Mounts` in `docker inspect <container>`, remove the container, then delete
the volume with `docker volume rm <name>`.

The pnpm home holds the store and the pnpm binary that `packageManager`
switches to. Docker shares a named volume with every container that names it,
so a fixed name would let an agent in one repository plant code that another
repository's container runs. `pnpm test:gates` fails a devcontainer config
whose `mounts` names a volume without `${devcontainerId}` in its name; it does
not read `runArgs` or a compose file.

The container runs as the non-root `node` user, and Docker creates the
volume's mount point owned by root, so the post-create step first hands it to
`node` with `sudo`. `pnpm_config_store_dir` then points pnpm at the volume:
the checkout is a separate mount, and without the variable pnpm keeps its
store inside the checkout.

The `pnpm` on the container's path is the image's own. It switches to the
version `packageManager` pins but, unlike corepack, does not check the
download against the pin's hash. Corepack's shims would land in a root-owned
directory behind it on the path, so the container does not enable corepack.

How you open the container decides which of your credentials it carries in.
Start an unattended agent run with the `devcontainer` CLI:

```sh
pnpm dlx @devcontainers/cli up --workspace-folder .
pnpm dlx @devcontainers/cli exec --workspace-folder . claude
```

- The `devcontainer` CLI forwards no host credentials: no SSH agent, no git
  or Docker credential helper, and no `~/.gitconfig`.
- VS Code's "Reopen in Container" forwards your SSH agent through a socket
  under `/tmp`, answers git and Docker credential requests from your host's
  helpers, and copies `~/.gitconfig`, so an agent in it can push anywhere you
  can. The `dev.containers.*` user settings only skip writing that setup into
  the container's config, and `"remoteEnv": { "SSH_AUTH_SOCK": "" }` hides the
  variable but not the socket. Keep VS Code for interactive work.
- A GitHub Codespace carries a `GITHUB_TOKEN` that can push to the
  repository, plus every Codespaces secret you have given it.

The CLI keeps your credentials out, not your checkout: it mounts your host
folder writable, as VS Code does. Code an agent writes there runs on your host
the next time a host tool loads it:

- git runs the commands `.git/config` names and the hooks in `.git/hooks`: a
  `core.fsmonitor` or a `post-index-change` hook at your next `git status`,
  and at your next commit the commit hooks with the lint-staged, ESLint, and
  commitlint configs they load.
- `devcontainer up` runs the `initializeCommand` in
  `.devcontainer/devcontainer.json` every time, and a mount or `runArgs` entry
  added there takes effect at the next rebuild.
- pnpm runs the package scripts, and the files under `node_modules` they call,
  the next time you run it outside the container.

So after an unattended run, read `.git/config`, and every file in `.git/hooks`
that lacks a `.sample` suffix, with `cat` before any git command. Then review
everything the run changed, its commits included, before you commit, run pnpm,
or run `devcontainer up` in that folder on your host. `git status` does not
show `node_modules`, so delete it before your first pnpm command there.

Egress control is the opt-in second step because it needs Linux container
privileges. Anthropic's reference `init-firewall.sh` (the `.devcontainer/`
folder of the anthropics/claude-code repository) narrows egress without
closing it: DNS and SSH stay open to any host, the Docker host's network stays
reachable, and GitHub and the npm registry accept writes, so a token an
attacker plants in a prompt still gets data out. Read your copy of the script
before relying on it.

To add it:

1. Copy `init-firewall.sh` into `.devcontainer/`.
2. Add `.devcontainer/Dockerfile`, built from the image the JSON names now. It
   installs the tools the script calls, puts the script on the path, and
   creates the pnpm home owned by `node`. The image gives `node` passwordless
   sudo for every command, and with `NET_ADMIN` that is enough to flush the
   rules, so the Dockerfile narrows sudo to the script:

   ```dockerfile
   FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm
   RUN apt-get update \
     && apt-get install -y --no-install-recommends iptables ipset dnsutils aggregate \
     && rm -rf /var/lib/apt/lists/*
   COPY init-firewall.sh /usr/local/bin/init-firewall.sh
   RUN chmod +x /usr/local/bin/init-firewall.sh \
     && mkdir -p /home/node/.local/share/pnpm \
     && chown -R node:node /home/node/.local \
     && echo 'node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/node \
     && chmod 0440 /etc/sudoers.d/node
   ```

3. In `devcontainer.json`, replace the `"image"` line with a build of that
   file, and add the two capabilities, the post-start step, and a wait for it.
   The post-create step drops its `sudo chown`, which the narrowed sudo
   refuses: a new volume takes its owner from the folder it mounts over, and
   the Dockerfile made that folder `node`'s.

   ```jsonc
   {
     "build": { "dockerfile": "Dockerfile" },
     "postCreateCommand": "pnpm install",
     "runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"],
     "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
     "waitFor": "postStartCommand"
     // The other keys stay as they are.
   }
   ```

4. Rebuild the container and check that the post-start output ends with a
   `Firewall verification passed` line. The script flushes every rule before
   it adds its own, so a run that stops partway, on a missing tool or a failed
   lookup, leaves the container running with egress wide open.

Claude Code itself does not need the firewall or the capabilities; leave them
out if your own network controls cover it. Never mount host secrets into the
container, and never start an unattended run through VS Code or a Codespace,
which forward them for you. Pass only what an agent needs, such as an API key,
as an environment variable.

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
