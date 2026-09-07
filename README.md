# roots

Rapid Opinionated Onboarding — TypeScript. A GitHub template that seeds an
AI-agent-ready pnpm + Turborepo monorepo.

Out of the box: portable docs (GitHub + VitePress + Obsidian), decisions and specs
as single sources of truth, generated indexes that cannot drift, and a Claude Code /
AGENTS.md agent layer wired from day one.

<!-- roots:template-only -->
## First run (removed by init)

1. Create your repo with **Use this template**, clone it, then run:

   ```sh
   node scripts/init.mts
   ```

   It prompts for a slug, title, and description (add `--defaults` to skip the
   prompts), then renames everything, clears the decision log, prints the manual
   checklist (ruleset, wiki/projects settings), and deletes itself.
2. `pnpm install && pnpm docs:gen && pnpm docs:check && pnpm docs:portability`
3. Commit. CI is green on the first push.

> [!NOTE]
> If you are working on the roots template itself (this repo is
> `RemiMyrset/roots`), do not run init — the template banners and
> `scripts/init.mts` are the product, not scaffolding to remove.
<!-- /roots:template-only -->

## Setup

**Requires** Node 24 (pinned in `.node-version`) and pnpm — run `corepack enable`
if you don't have it. Then:

```sh
pnpm install
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm verify` | The done gate: every check CI runs, in CI order, stopping at the first failure |
| `pnpm build` / `pnpm test` / `pnpm typecheck` | Turbo across packages that define each script; `typecheck` also runs root `tsc` over scripts + configs |
| `pnpm lint` / `pnpm lint:fix` | ESLint (antfu flat config) repo-wide |
| `pnpm lint:secrets` | secretlint over every tracked file (also runs on staged files at commit) |
| `pnpm test:hooks` | PreToolUse guard fixtures (allow/deny cases, node only) |
| `pnpm test:sync` | Template-sync fixtures (throwaway template + child repos, node only) |
| `pnpm docs:gen` | Regenerate the decisions and specs indexes |
| `pnpm docs:check` / `pnpm docs:portability` | Docs structure + portability gates |
| `pnpm docs:internal:build` / `pnpm docs:public:build` | Site builds (CI-blocking) |
| `pnpm docs:internal:dev` | Internal handbook (VitePress, team-only) |
| `pnpm docs:public:dev` | Public docs site |
| `pnpm sync:template` | Pull the template's mechanics: stages them, records the sync point, prints commits since and `package.json` follow-ups (`--ref` pins a template tag or branch) |
| `pnpm release` | changelogen: version, CHANGELOG, tag, push — human-run (agents are blocked) |

## Working with AI agents

The rulebook is [AGENTS.md](./AGENTS.md). Claude Code reads it through the
one-line `CLAUDE.md`, Codex reads it natively, and Gemini CLI is pointed at it by
`.gemini/settings.json`. On first run, Codex and Gemini ask you to trust the folder
(Codex also asks to trust each hook once via `/hooks`); say yes, or the guards and
project settings stay off.

- **Guards.** A shared set of pre-tool hooks denies the common mistakes in all
  three tools: a non-pnpm package manager, enabling a dependency build script,
  reading a secret file, pushing to a protected branch, and bypassing a git
  hook. Threat model and scope: [SECURITY.md](./SECURITY.md).
- **Push flow.** Feature-branch pushes and PR creation run without prompts;
  `main` (or `PROTECTED_BRANCHES`) is only reachable through a PR a human
  merges. The `pr` skill does the whole thing the house way.
- **Done gate.** `pnpm verify` is what "done" means — every CI check, in order.
- **Template updates.** `pnpm sync:template` pulls the shared mechanics; the
  `sync-template` skill drives it end to end. Recipe and contract in
  [docs/template/](./docs/template/README.md).
- **Sandbox.** `.devcontainer/` gives every tool the same node 24 + pnpm
  environment inside a container, for unattended runs and Codespaces. The
  egress firewall is an opt-in recipe in
  [docs-toolchain](./docs/template/docs-toolchain.md).

## Where things live

- Agent rulebook: [AGENTS.md](./AGENTS.md) — conventions and canonical-source map.
- Decisions (why): [docs/internal/decisions/](./docs/internal/decisions/index.md)
- Specs (what): [docs/internal/specs/](./docs/internal/specs/index.md)
- Template-owned rules and agent material (synced, never rendered):
  [docs/template/](./docs/template/README.md)
- Docs system, recipes, growth paths:
  [docs-toolchain](./docs/template/docs-toolchain.md)

## License

[MIT](./LICENSE)
