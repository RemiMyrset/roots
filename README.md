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
| `pnpm test:hooks` | PreToolUse guard fixtures (allow/deny cases, node only) |
| `pnpm test:sync` | Template-sync fixtures (throwaway template + child repos, node only) |
| `pnpm docs:gen` | Regenerate the decisions and specs indexes |
| `pnpm docs:check` / `pnpm docs:portability` | Docs structure + portability gates |
| `pnpm docs:internal:build` / `pnpm docs:public:build` | Site builds (CI-blocking) |
| `pnpm docs:internal:dev` | Internal handbook (VitePress, team-only) |
| `pnpm docs:public:dev` | Public docs site |
| `pnpm sync:template` | Pull the template's mechanics: stages them, records the sync point, prints commits since and `package.json` follow-ups |
| `pnpm release` | changelogen: version, CHANGELOG, tag, push — human-run (agents are blocked) |

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
