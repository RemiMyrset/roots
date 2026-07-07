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

   It prompts for a name, title, and whether to keep TypeScript (add `--defaults`
   to skip the prompts), then renames everything, resets the decision log, prints
   the manual checklist (ruleset, wiki/projects settings), and deletes itself.
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
| `pnpm build` / `pnpm test` / `pnpm typecheck` | Turbo across packages that define each script; `typecheck` also runs root `tsc` over scripts + configs |
| `pnpm lint` / `pnpm lint:fix` | ESLint (antfu flat config) repo-wide |
| `pnpm docs:gen` | Regenerate indexes, `docs/llms.txt`, `docs/llms-full.txt` |
| `pnpm docs:check` / `pnpm docs:portability` | Docs structure + portability gates |
| `pnpm docs:internal:dev` | Internal handbook (VitePress, team-only) |
| `pnpm docs:public:dev` | Public docs site |
| `pnpm release` | changelogen: version, CHANGELOG, tag, push |

## Where things live

- Agent rulebook: [AGENTS.md](./AGENTS.md) — conventions and canonical-source map.
- Decisions (why): [docs/internal/decisions/](./docs/internal/decisions/index.md)
- Specs (what): [docs/internal/specs/](./docs/internal/specs/index.md)
- Docs system, recipes, growth paths:
  [docs-toolchain](./docs/internal/development/docs-toolchain.md)

## License

[MIT](./LICENSE)
