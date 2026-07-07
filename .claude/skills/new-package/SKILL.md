---
name: new-package
description: Scaffold a new workspace package under packages/ or apps/ with the house shape (catalog deps, base tsconfig, source-direct exports, vitest) and add it to the AGENTS.md monorepo map. Use when the user says "new package", "add a package", "create an app", or "scaffold a package". Also use unprompted when code you are adding belongs in no existing workspace package.
---

# New workspace package

Scaffold under `packages/<name>` (shared library) or `apps/<name>` (deployable
app or service). Placement alone registers it — the workspace globs cover both,
and `apps/` may not exist yet; just create it.

1. Directory is kebab-case; the package name takes the scope the existing
   workspace packages use: `@<root package.json name>/<name>`.
2. Create `package.json` — this exact shape, every version `catalog:`:

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

   Keep `vite` — vitest 4 peers on vite >= 6 and fails at startup without an
   explicit entry. `@vitest/coverage-v8` is intentionally omitted repo-wide:
   its transitive vite peer dedupes to vitepress's vite 5 and crashes
   `vitest --coverage` — re-add it once vitepress moves off vite 5 (see the
   `vite` note in `pnpm-workspace.yaml`). Exports stay source-direct; add a
   `build` script only when
   the package must emit `dist/` (turbo discovers it). No per-package `lint` —
   lint runs repo-wide. Internal cross-package deps use `"workspace:*"`. A
   genuinely new dependency first gets a version entry in the `catalog:` block
   of `pnpm-workspace.yaml` — a load-bearing choice; record it (new-adr skill).
3. Create `tsconfig.json`, exactly (TypeScript path only — the no-TypeScript init
   deletes `tsconfig.base.json`, so a no-TS repo skips this and the vitest step):
   `{ "extends": "../../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }`
4. Create `vitest.config.ts` — copy `packages/core/vitest.config.ts` if it
   still exists (a minimal `defineConfig({ test: {} })`; coverage is omitted
   repo-wide until vitepress leaves vite 5, see the note in that file).
5. Create `src/index.ts` plus a colocated `src/index.test.ts` with at least one
   real test (relative imports carry explicit `.ts` extensions), so the gates
   are honestly green. If this replaces the sample `packages/core`, delete or
   rename it in the same change.
6. Add one line to the AGENTS.md "Monorepo map": path — purpose. Update the
   map line of anything you replaced.
7. Run `pnpm install` (CI installs with a frozen lockfile — it fails if the
   lockfile misses the new member), then `pnpm typecheck && pnpm test &&
   pnpm lint`, then `pnpm docs:portability` (AGENTS.md changed) — all must
   pass before you are done. If the package adds externally observable
   behavior, spec it: new-spec skill.

$ARGUMENTS is the package name and placement if provided.
