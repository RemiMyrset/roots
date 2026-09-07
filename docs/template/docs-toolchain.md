# Docs toolchain

How the docs machinery works, and the recipes for everything roots deliberately
does not ship wired.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm verify` | every gate CI runs, in CI order — the done gate; docs gates included |
| `pnpm docs:gen` | automd indexes: decisions and specs (mutates files) |
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

Whether your repository was made with **Use this template** (no shared git
history), forked or cloned from roots (shared history), or predates roots
entirely, the sync works the same way — and there is no bot, cron, or token:

```sh
pnpm sync:template                # URL and ref from .template-sync.json, else the defaults
pnpm sync:template <fork-url>     # or point at your own fork (recorded for next time)
pnpm sync:template --ref v0.1.0   # pin a template tag or branch (recorded for next time)
```

It adds a `template` git remote (tags excluded, so the template's releases never
leak into your changelog), fetches the ref, and stages the template's version of
the mechanics paths: the CI, docs, and labels workflows, the label list, the
issue and PR templates, the docs generators and checkers, the guard and sync
test-suites, the verify gate, the agent hooks, rules, and skills with their Codex
and Gemini registrations, the generated `.agents/skills` mirror, the
template-owned docs under `docs/template/`, and the sync script itself. Files
the template retired inside those paths — or a whole path it retired — are
staged for deletion. Nothing is committed. Review with `git diff --cached`,
keep what applies, and discard the rest with
`git restore --staged --worktree <path>`. Your `package.json`, `src/`,
`packages/`, `apps/`, `docs/internal/`, `docs/public/`, and
`.claude/settings.json` are never touched. The synced scripts are `.mts`, not
`.ts`, on purpose: `.mts` runs as ESM regardless of the target repo's
`package.json` `"type"`, whereas a `.ts` file is read as CommonJS in a repo that
sets `"type": "commonjs"`, which breaks its `import`/`export`.

Then it prints what a file copy cannot carry:

- **Where you branched off.** A first sync infers the baseline and says how on a
  `Baseline:` line: `(shared history)` from `git merge-base` for a fork or clone;
  `(root tree)` when your root commit carries a template commit's tree verbatim,
  which is what "Use this template" produces; `(root time)` for the template
  commit at your root commit's time, checked against the synced paths and
  marked approximate; or `none`, in which case the list starts on the next run.
- **Commits since** — the template's log from that point (later, from the
  recorded sync point), breaking commits marked `!` with their `BREAKING CHANGE`
  paragraph. A template change that needs a hand-edit outside the synced paths
  (a `.claude/settings.json` entry, a new devDependency, an orphan file to
  delete) ships as such a commit; the footer is the instruction.
- **Follow-ups** — the `package.json` scripts that differ from the template's,
  compared three ways (template now, template at the baseline, yours), so a
  script you customized on purpose is listed once as "customized locally"
  rather than nagged about on every run. A script that still references a file
  this sync deletes gets a note. Apply the ones that apply by hand.

The sync point lives in `.template-sync.json` at the repo root — template URL,
the ref it tracks, and the last synced commit — written by the script and staged
with the sync, so commit it together. It is also where you customize the sync:
list a mechanics path under `exclude` to stop pulling it (say
`.gemini/settings.json` once you have local Gemini settings), or an extra path
under `include` (for example `tsconfig.base.json` or `eslint.config.ts`) to
pull it too. Never edit the `MECHANICS` list in the script itself: the script is
synced, and the edit would be staged for revert on the next run.

Pinning: `--ref` takes a template tag or branch and remembers it in the state
file. Tags are fetched into `refs/template-tags/`, never `refs/tags/`, so
`pnpm release` in your repository stays unaffected. `--ref main` unpins.
Pinning to something older than your recorded sync point stages the older
mechanics and says so.

A repo that predates the script, or holds an older copy that never recorded a
sync point, bootstraps with plain git (works for private forks with whatever
auth git already has; overwriting an older tracked copy is fine — the script
exempts itself from its own dirty check):

```sh
mkdir -p scripts && git fetch --no-tags https://github.com/RemiMyrset/roots.git main && git show FETCH_HEAD:scripts/sync-template.mts > scripts/sync-template.mts && node scripts/sync-template.mts
```

The `sync:template` script then shows up as a missing follow-up on that first
run. In Claude Code the `sync-template` skill drives the whole flow: bootstrap,
sync, review, follow-ups, gates, commit proposal.

Two things to know. Sync only stages deletions **inside** the synced paths, so
an artifact the template retired elsewhere (a doc, a config line) stays behind
as an orphan; the breaking-commit footer names it, sweep it by hand. And a file
of your own under a synced directory (say `.claude/skills/my-skill/`) is
staged for deletion on every run because it is not upstream — discard that
hunk, move the skill, or `exclude` the directory. `.claude/settings.json` never
travels: set `PROTECTED_BRANCHES` in its `env` block if `main` is not your
protected branch (every tool's guard reads that block), and drop any old blanket
`Bash(git push:*)` deny so the `deny-push-protected` guard can allow
feature-branch pushes. Add the push-flow allow entries too, so an agent can push
a branch and open a PR without prompts: `Bash(git push:*)`,
`Bash(gh pr create:*)`, `Bash(gh pr view:*)`, `Bash(gh pr list:*)`,
`Bash(gh pr checks:*)`, `Bash(gh pr diff:*)`, `Bash(gh run list:*)`,
`Bash(gh run view:*)`, `Bash(gh run watch:*)`, `Bash(gh issue view:*)`,
`Bash(gh issue list:*)`. Leave `gh pr merge` off the list: merging into a
protected branch stays a human decision. The full contract, exit codes, and
behavior branches: [sync-template](./sync-template.md).

### Deploy the public site

Options: a GitHub Pages workflow running `pnpm docs:public:build` (add
`base` to the public VitePress config for project pages), or a
`repository_dispatch` notification to a central docs-hub repo.

**AI discoverability.** The public build already emits `/llms.txt` — the
[llms.txt](https://llmstxt.org/) standard, the "SEO for AI" file that crawlers
and agents fetch first — plus a clean markdown copy of every page next to its
HTML, via `vitepress-plugin-llms` in `docs/public/.vitepress/config.ts`. Two
settings need the deployed hostname, so set them when you wire the deploy: the
plugin's `domain` option (absolute URLs in `llms.txt`) and VitePress
`sitemap: { hostname }` (a `sitemap.xml`). The public site ships no
`robots.txt`, so AI crawlers are allowed by default. `generateLLMsFullTxt`
stays off: a concatenated corpus is in no version of the standard, which is a
search-the-map-then-follow-links model. The internal site deliberately emits
nothing for machines, and there is no committed repo-wide map either: coding
agents work from `AGENTS.md` and the generated indexes.

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

`.devcontainer/devcontainer.json` ships a minimal environment every tool can run
in: the official TypeScript-and-node image at node 24, the Claude Code and
GitHub CLI Dev Container features, `corepack enable && pnpm install` after
creation (node 24 still bundles corepack; from node 25 install it with
`npm install -g corepack` in the image or pin the feature's pnpm), and the
editor extensions the repo already recommends. Open it with VS Code's "Reopen
in Container", a GitHub Codespace, or the `devcontainer` CLI. Inside it an
unattended agent run cannot reach your keys, your other repos, or anything
outside the mounted workspace.

Egress control is the opt-in second step, because it needs Linux container
privileges: copy Anthropic's reference `init-firewall.sh` (the
`.devcontainer/` folder of the anthropics/claude-code repository) into
`.devcontainer/`, add `"runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"]`
and `"postStartCommand": "sudo /usr/local/bin/init-firewall.sh"` to the JSON,
and install `iptables` and `ipset` in a small Dockerfile. The script allows
only the npm registry, GitHub, and the Anthropic API, so a prompt-injected agent
has nowhere to send data. Claude Code itself does not need the firewall or the
capabilities; leave them out if your own network controls cover it. Never mount
host secrets into the container — pass what an agent needs as environment
variables.

### More agent surfaces

The rulebook is `AGENTS.md`; the guards are the `deny-*` scripts under
`.claude/hooks/`; the skills live under `.claude/skills/`. Three tools read them:

- **Claude Code** reads `CLAUDE.md` (one line: `@AGENTS.md`), registers the
  guard dispatcher as a PreToolUse hook in `.claude/settings.json`, and reads
  skills from `.claude/skills/` only.
- **Codex** reads `AGENTS.md` natively (merged root-down, 32 KiB cap), registers
  the same dispatcher as a PreToolUse hook in `.codex/hooks.json`, and reads
  skills from `.agents/skills/`. Project-level `.codex/` config loads only
  after you trust the folder, and each hook once via `/hooks`.
- **Gemini CLI** is told to load `AGENTS.md` by `context.fileName` in
  `.gemini/settings.json`, which also registers the dispatcher as a BeforeTool
  hook; skills come from the same `.agents/skills/`. Project settings load only
  in a trusted folder.
- `.agents/skills/` is a generated, committed copy of `.claude/skills/` —
  `pnpm docs:gen` rewrites it, the drift gate and `pnpm docs:check` refuse a
  stale or hand-edited copy. A copy rather than a symlink because a symlink
  needs privileges on Windows and silently becomes a text file without them.
- The Codex and Gemini registrations run `pnpm -w --silent run guards`, a
  workspace-root script that resolves from any subdirectory on every platform
  with no shell-specific syntax; Claude Code calls the dispatcher directly.
- The push guard reads `PROTECTED_BRANCHES` from the environment (Claude Code
  exports the `env` block of `.claude/settings.json`) or, when unset, from that
  file itself — so Codex and Gemini honour the same list with nothing to
  configure per tool.
- Codex exec-policy rules and Gemini's allowed-tools settings are those tools'
  counterparts to the Claude Code permission allowlist; roots ships neither, so
  expect their approval prompts on the commands Claude Code runs silently.
- Monorepo packages with their own conventions get a scoped `AGENTS.md` **plus a
  sibling `CLAUDE.md` holding `@AGENTS.md`** — Claude Code walks nested
  `CLAUDE.md`, not nested `AGENTS.md`, so the pair is what makes the scope load.
  Codex merges nested `AGENTS.md` on its own; Gemini loads it when a tool first
  touches the directory. See the Monorepo map in the root `AGENTS.md` for the
  line budget.
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
