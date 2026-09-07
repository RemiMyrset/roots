# roots

Rapid Opinionated Onboarding — TypeScript. A GitHub template that seeds an
AI-agent-ready pnpm + Turborepo monorepo.

Out of the box: portable docs (GitHub + VitePress + Obsidian), decisions and specs
as single sources of truth, generated indexes that cannot drift, and a Claude Code /
AGENTS.md agent layer wired from day one.

## First run

> [!IMPORTANT]
> You are reading a repository just created from the roots template. Nothing in
> the tree depends on the template's name, so there is no rename script: work
> through this list once, then delete the section (last step). In Claude Code
> the `first-run` skill does every step marked **(skill)** and hands you the rest.

1. **Prove the gates.** `pnpm install && pnpm verify` — green before you touch
   anything. **(skill)**
2. **Name it.** **(skill — it asks you for the one-line pitch)**
   - `package.json`: `name` (your repo slug) and `description`.
   - This file: the H1 and the pitch paragraph above. Keep the provenance line
     under "Where things live".
   - `LICENSE`: the copyright holder and year (the template ships MIT).
   - `.github/CODEOWNERS`: `@OWNER` becomes your GitHub user or team.
   - `.github/ISSUE_TEMPLATE/config.yml`: `OWNER/REPO` in both links.
   - `CODE_OF_CONDUCT.md`: the `[INSERT CONTACT METHOD]` placeholder.
   - Optional: a package scope other than `@repo/` — in any POSIX shell (Git
     Bash on Windows), `grep -rl '@repo/' --exclude-dir=node_modules .` lists
     every file.
3. **Agent tools.** The first time you open the folder, Codex and Gemini CLI ask
   you to trust it (Codex also trusts each hook once via `/hooks`); say yes or
   the guards stay off. If `main` is not your only protected branch, set
   `PROTECTED_BRANCHES` in the `env` block of `.claude/settings.json`
   (comma-separated globs). **(skill — the branch list only)**
4. **Samples and stubs.** `packages/example-package` and `apps/example-app`
   keep the gates honest; replace them when real code lands (the `new-package`
   skill scaffolds the house shape). Same for the pages under `docs/public/`.
   Not today.
5. **GitHub settings.** Needs `gh auth login`; `OWNER/REPO` is your repository.
   **(skill)**

   ```sh
   gh repo edit OWNER/REPO --description "your pitch" --add-topic typescript --enable-wiki=false --enable-projects=false
   gh workflow run labels.yml   # seeds the labels from .github/labels.yml
   ```

6. **Commit and push.** Delete this section, then
   `git commit -am "chore: initialize from roots"` and push `main` — the one
   direct push; everything after lands through a PR. **(skill proposes the
   commit; it never pushes)**
7. **Branch ruleset.** After `ci` and `docs` have reported on `main` at least
   once (a required check that never reports blocks every PR), run the ruleset
   command under "Push protection" in [guards](./docs/template/guards.md). Free
   on public repositories, GitHub Pro on private ones.

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
| `pnpm --filter @repo/example-app start` | Runs the sample CLI (`node src/main.ts`) against the sample package |
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
`.gemini/settings.json`. The first time you open the folder, Codex and Gemini ask you
to trust it (Codex also asks to trust each hook once via `/hooks`); say yes, or the
guards and project settings stay off.

- **Guards.** A shared set of pre-tool hooks denies the common mistakes in all
  three tools: a non-pnpm package manager, enabling a dependency build script,
  reading a secret file, pushing to a protected branch, and bypassing a git
  hook. Threat model and scope: [guards](./docs/template/guards.md).
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
- Template provenance: created from [roots](https://github.com/RemiMyrset/roots);
  pull updates with `pnpm sync:template`.

## License

[MIT](./LICENSE)
