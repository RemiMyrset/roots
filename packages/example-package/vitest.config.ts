import { defineConfig } from 'vitest/config'

// Coverage (v8) is intentionally omitted: `@vitest/coverage-v8` can dedupe its
// `vite` peer onto the vite 5 that vitepress pins, which breaks `vitest --coverage`.
// Full rationale + re-add steps: the `vite` catalog note in pnpm-workspace.yaml.
export default defineConfig({
  test: {},
})
