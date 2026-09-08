# Docs toolchain

How the docs mechanics work, and recipes for what roots leaves unwired on
purpose.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm docs:gen` | automd indexes: decisions and specs (mutates files) |
| `pnpm docs:check` | structural lint: record/spec formats, Source/Tests paths, staleness |
| `pnpm docs:portability` | trifecta lint (GitHub + VitePress + Obsidian), blocking |
| `pnpm docs:internal:dev` / `docs:internal:build` | internal handbook site |
| `pnpm docs:public:dev` / `docs:public:build` | public site |

All of them run inside the done gate, `pnpm verify`. CI
(`.github/workflows/docs.yml`) runs gen (diff-gated), check, portability, and
both site builds, all blocking, plus an advisory spec-discipline nudge on PRs.

## Adding a custom generator

A reader in `scripts/docs/generators.mts` parses a source of truth (a
directory, a source file, a schema) and a generator renders it between automd
markers. The automd index and the VitePress sidebar consume the same reader,
so they cannot drift. `decisionsIndex` is the worked example: it reads the
decision files' H1 and Status bullets.

Register a new generator in `automd.config.ts` and add the marker pair to the
target page. automd also ships the built-ins `file` (inline a file),
`dir-tree`, and `fetch`.

## Recipes

### Pull template updates (on demand)

The sync works the same for a repository made with **Use this template** (no
shared git history), forked or cloned from roots (shared history), or older
than roots. There is no bot, cron, or token:

```sh
pnpm sync:template                # URL and ref from .template-sync.json, else the defaults
pnpm sync:template <fork-url>     # or point at your own fork (recorded for next time)
pnpm sync:template --ref <name>   # pin a template branch or tag (recorded for next time)
```

It adds a `template` git remote (tags excluded, so template tags never leak
into your changelog), fetches the ref, and stages the template's version of
the mechanics paths. Those are the CI, docs, labels, and pages workflows,
the label list, the agent-task issue template and the PR template, the docs
generators and checkers, the guard, sync, docs, and gate test-suites, the
verify gate, the agent hooks, rules, skills, and output styles with their
Codex and Gemini registrations, the generated `.agents/skills` mirror, the
template-owned docs under `docs/template/`, and the sync script itself. A file
the template retired inside those paths, or a whole path it retired, is staged
for deletion.

Nothing is committed. Review with `git diff --cached`, keep what applies, and
discard the rest with `git restore --staged --worktree <path>`. Your
`package.json`, `src/`, `packages/`, `apps/`, `docs/internal/`,
`docs/public/`, and `.claude/settings.json` are never touched.

The synced scripts are `.mts` on purpose. `.mts` runs as ESM whatever the
target repo's `package.json` `"type"` says, whereas a `.ts` file is read as
CommonJS in a repo that sets `"type": "commonjs"`, which breaks its
`import`/`export`.

Then it prints what a file copy cannot carry: where you branched off, the
template commits since, and the follow-ups.

A first sync infers the baseline and says how on a `Baseline:` line:
`(shared history)` from `git merge-base` for a fork or clone; `(root tree)`
when your root commit carries a template commit's tree verbatim, which is what
"Use this template" produces; `(root time)` for the template commit at your
root commit's time, checked against the synced paths and marked approximate;
or `none`, in which case the list starts on the next run.

The commits since are the template's log from that point (later, from the
recorded sync point), with breaking commits marked `!` and their
`BREAKING CHANGE` paragraph printed. A template change that needs a hand-edit
outside the synced paths (a `.claude/settings.json` entry, a new devDependency,
an orphan file to delete) ships as such a commit; the footer is the
instruction.

The follow-ups are the `package.json` scripts that differ from the template's,
compared three ways (template now, template at the baseline, yours), so a
script you customized on purpose is listed once, as "customized locally". A
script that still references a file this sync deletes gets a note. Apply the
ones that apply by hand.

The sync point lives in `.template-sync.json` at the repo root: the template
URL, the ref it tracks, and the last synced commit. The script writes it and
stages it with the sync, so commit them together.

The same file customizes the sync. List a mechanics path under `exclude` to
stop pulling it (say `.gemini/settings.json` once you have local Gemini
settings), or an extra path under `include` (for example `tsconfig.base.json`
or `eslint.config.ts`) to pull it too. Never edit the `MECHANICS` list in the
script itself: the script is synced, and the edit would be staged for revert
on the next run.

`--ref` pins a template tag or branch and remembers it in the state file. Tags
are fetched into `refs/template-tags/`, never `refs/tags/`, so `pnpm release`
in your repository stays unaffected. `--ref main` unpins, and pinning to
something older than your recorded sync point stages the older mechanics and
says so.

A repo that predates the script, or holds an older copy that never recorded a
sync point, bootstraps with plain git. This works for private forks with
whatever auth git already has, and overwriting an older tracked copy is fine
because the script exempts itself from its own dirty check:

```sh
mkdir -p scripts && git fetch --no-tags https://github.com/RemiMyrset/roots.git main && git show FETCH_HEAD:scripts/sync-template.mts > scripts/sync-template.mts && node scripts/sync-template.mts
```

The `sync:template` script then shows up as a missing follow-up on that first
run. In Claude Code the `sync-template` skill drives the whole flow: bootstrap,
sync, review, follow-ups, gates, commit proposal.

Sync stages deletions only inside the synced paths. An artifact the template
retired elsewhere (a doc, a config line) stays behind as an orphan; the
breaking-commit footer names it, so sweep it by hand. A file of your own under
a synced directory (say `.claude/skills/my-skill/`) is staged for deletion on
every run because it is not upstream: discard that hunk, move the skill, or
`exclude` the directory.

`.claude/settings.json` never travels. Set `PROTECTED_BRANCHES` in its `env`
block if `main` is not your protected branch (every tool's guard reads that
block), and drop any old blanket `Bash(git push:*)` deny so the
`deny-push-protected` guard can allow feature-branch pushes. Add the push-flow
allow entries too, so an agent can push a branch and open a PR without
prompts: `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr view:*)`,
`Bash(gh pr list:*)`, `Bash(gh pr checks:*)`, `Bash(gh pr diff:*)`,
`Bash(gh run list:*)`, `Bash(gh run view:*)`, `Bash(gh run watch:*)`,
`Bash(gh issue view:*)`, `Bash(gh issue list:*)`.

Leave `gh pr merge` off the list: merging into a protected branch stays a
human decision. The full contract, exit codes, and behavior branches are in
[sync-template](./sync-template.md).

### Publish the public site on GitHub Pages

`.github/workflows/pages.yml` is the standard, and it is synced. On every push
to `main` that touches `docs/public/`, the shared VitePress fragment, or the
lockfile (and on manual dispatch) it builds the public site, and when GitHub
Pages is enabled for the repository it also deploys it. Until then the run is
green and says "built, not deployed", so a repository that never wants a
public site pays nothing and sees no red.

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
every page next to its HTML, via `vitepress-plugin-llms`. Published through
the workflow, its links are absolute and a sitemap sits beside it. The public
site ships no `robots.txt`, so AI crawlers are allowed by default.

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

### Library packages (publish to npm)

Add `tsdown` (the Rolldown-based tsup successor) to the package: dual ESM/CJS
plus type declarations, with built-in publint and arethetypeswrong checks
(`tsdown --publint`). Add an exports map and `prepack: pnpm build`. Swap
changelogen for `changesets` the day packages need independent versions.

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

### More agent surfaces

The rulebook is `AGENTS.md`, the guards are the `deny-*` scripts under
`.claude/hooks/`, the skills live under `.claude/skills/`, and the writing
rules for all prose are `.claude/output-styles/writing.md`. Three tools read
them.

Claude Code reads `CLAUDE.md` (one line: `@AGENTS.md`), registers the guard
dispatcher as a PreToolUse hook in `.claude/settings.json`, reads skills from
`.claude/skills/` only, and applies the writing rules as its output style
(`outputStyle` in the same file). `/config` overrides the style per machine in
the gitignored `settings.local.json`, and restores it.

Codex reads `AGENTS.md` natively (merged root-down, 32 KiB cap), registers the
same dispatcher as a PreToolUse hook and the session hook as a SessionStart
hook in `.codex/hooks.json`, and reads skills from `.agents/skills/`.
Project-level `.codex/` config loads only after you trust the folder, and each
hook once via `/hooks`.

Gemini CLI is told to load `AGENTS.md` by `context.fileName` in
`.gemini/settings.json`, which also registers the dispatcher as a BeforeTool
hook and the session hook as a SessionStart hook; skills come from the same
`.agents/skills/`. Project settings load only in a trusted folder.

`.agents/skills/` is a generated, committed copy of `.claude/skills/`:
`pnpm docs:gen` rewrites it, and the drift gate and `pnpm docs:check` refuse a
stale or hand-edited copy. It is a copy because a symlink needs privileges on
Windows and silently becomes a text file without them.

The Codex and Gemini registrations run `pnpm -w --silent run guards`, a
workspace-root script that resolves from any subdirectory on every platform
with no shell-specific syntax. Claude Code calls the dispatcher directly.

The writing rules load at every session start in all three tools from one
file. Claude Code carries them in its output style, part of the system prompt
and re-reminded during the session. Codex and Gemini run
`pnpm -w --silent run session` at SessionStart, and `session-start.mts` prints
the file, frontmatter stripped, as `additionalContext` (`--silent` matters:
Gemini reads stdout as JSON).

The session hook ignores its payload, always exits 0, and prints nothing when
the file is missing, so it can never block a session. Claude Code does not
register it: that would inject the text twice. Neither surface reaches Claude
Code subagents.

Codex caps injected context near 2,500 tokens, so `pnpm test:hooks` keeps the
file under 4,000 characters. Gemini fingerprints project hooks and asks once
after any change to `.gemini/settings.json`, a sync included.

The push guard reads `PROTECTED_BRANCHES` from the environment (Claude Code
exports the `env` block of `.claude/settings.json`) or, when unset, from that
file itself, so Codex and Gemini honour the same list with nothing to
configure per tool.

Codex exec-policy rules and Gemini's allowed-tools settings are those tools'
counterparts to the Claude Code permission allowlist. roots ships neither, so
expect their approval prompts on the commands Claude Code runs silently.

Monorepo packages with their own conventions get a scoped `AGENTS.md` (line
budget in the Monorepo map of the root `AGENTS.md`) plus a sibling `CLAUDE.md`
holding `@AGENTS.md`. Claude Code walks nested `CLAUDE.md`, never nested
`AGENTS.md`, so the pair is what makes the scope load. Codex merges nested
`AGENTS.md` on its own; Gemini loads it when a tool first touches the
directory.

Project-scoped MCP servers go in `.mcp.json` when a real need appears, for
example a browser-automation server once there is a UI. Native tools plus `gh`
cover the GitHub workflows already.

If the built-in spec flow is outgrown, GitHub Spec-Kit and cc-sdd are the
standard upgrades. Both impose their own spec formats; adopt deliberately.

### Optional CI additions

- typos (crate-ci/typos) spell-checks docs; add it as an advisory step in
  `docs.yml`.
- lychee checks external URLs; run it scheduled (weekly) and advisory, since
  external links rot on their own schedule.
- Coverage thresholds are vitest `coverage.thresholds` plus the `text-summary`
  reporter printed in CI logs, with no external service. They are gated for
  now: `@vitest/coverage-v8` is omitted repo-wide until vitepress moves off
  vite 5 (see the `vite` note in `pnpm-workspace.yaml`), so re-add the dep and
  the coverage block first.
- Going public means a LICENSE review, SECURITY.md, CodeQL default setup,
  actions/dependency-review, and the OSSF scorecard, all free only on public
  repos.
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

- VitePress 2 is still alpha; when it goes stable, the unmaintained
  `vitepress-plugin-mermaid` will likely need replacing with
  `vitepress-mermaid-renderer`.
- Math rendering is off by default; set `markdown: { math: true }` and add
  `markdown-it-mathjax3` if a project needs formulas.
- TypeScript 7 (tsgo) is near GA; `@typescript/native-preview` can serve as a
  fast pre-check (`tsgo --noEmit`), but keep `tsc` as the source-of-truth
  checker until full parity.
