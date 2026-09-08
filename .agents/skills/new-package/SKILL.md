---
name: new-package
description: Scaffold a new workspace package under packages/ or apps/ with the house shape (catalog deps, base tsconfig, source-direct exports, vitest) and add it to the AGENTS.md monorepo map. Use when the user says "new package", "add a package", "create an app", or "scaffold a package". Also use unprompted when code you are adding belongs in no existing workspace package.
---

# New workspace package

Scaffold under `packages/<name>` (shared library) or `apps/<name>` (deployable
app or service). Placement alone registers it; the workspace globs cover both.

1. Directory is kebab-case; the package name takes the scope the existing
   workspace packages use (`@repo/` out of the box): `@repo/<name>`.
2. Create `package.json` in this exact shape, every version `catalog:`:

   ```json
   {
     "name": "@<scope>/<name>",
     "type": "module",
     "version": "0.0.0",
     "private": true,
     "exports": { ".": "./src/index.ts" },
     "scripts": {
       "test": "vitest run",
       "test:watch": "vitest",
       "typecheck": "tsc --noEmit"
     },
     "devDependencies": {
       "@types/node": "catalog:",
       "typescript": "catalog:",
       "vite": "catalog:",
       "vitest": "catalog:"
     }
   }
   ```

   Keep `vite`: vitest 4 peers on vite >= 6 and fails at startup without an
   explicit entry. `@vitest/coverage-v8` is omitted repo-wide because its
   transitive vite peer dedupes to vitepress's vite 5 and crashes
   `vitest --coverage`; re-add it once vitepress moves off vite 5 (see the
   `vite` note in `pnpm-workspace.yaml`).

   Exports stay source-direct; add a `build` script only when the package must
   emit `dist/` (turbo discovers it). No per-package `lint`; lint runs
   repo-wide. Internal cross-package deps use `"workspace:*"`, and a new
   dependency first gets a version entry in the `catalog:` block of
   `pnpm-workspace.yaml`, a load-bearing choice to record (new-adr skill).

   An app under `apps/` drops `exports`, adds `"start": "node src/main.ts"`, and
   lists the workspace packages it uses under `dependencies` as `"workspace:*"`;
   see `apps/example-app`.
3. Create `tsconfig.json`, exactly:
   `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }`
4. Create `vitest.config.ts`: copy `packages/example-package/vitest.config.ts`
   if it still exists, else a minimal `defineConfig({ test: {} })`. Coverage is
   omitted until vitepress leaves vite 5 (the note in that file says why).
5. Create `src/index.ts` plus a sibling `test/index.test.ts` with at least one
   real test, so the gates are green. Tests live in `test/`, never in `src/`:
   Vitest's default glob finds them with no config, and a colocated test is an
   ESLint error. Relative imports carry explicit `.ts` extensions, so the test
   imports `../src/index.ts`. If this replaces `packages/example-package` or
   `apps/example-app` (which depends on the package), delete or rename the
   sample in the same change and fix the other's dependency.
6. Add one line to the AGENTS.md "Monorepo map": path — purpose. Update the
   map line of anything you replaced. If the package needs its own conventions,
   write `<package>/AGENTS.md` and `<package>/CLAUDE.md` containing only
   `@AGENTS.md`; Claude Code discovers nested `CLAUDE.md`, not nested
   `AGENTS.md`, so a lone scoped `AGENTS.md` never loads.
7. Run `pnpm install` (CI installs with a frozen lockfile and fails if it misses
   the new member), then `pnpm typecheck && pnpm test && pnpm lint`, then
   `pnpm docs:portability` (AGENTS.md changed); all must pass. If the package
   adds externally observable behavior, spec it (new-spec skill).

$ARGUMENTS is the package name and placement if provided.
