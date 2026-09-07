/**
 * Sample CLI: `node src/main.ts [name]`, or `pnpm --filter @repo/example-app start`.
 * Consumes the workspace package over `workspace:*` with no bundler — node 24 runs
 * the TypeScript source directly. Replace it with the real app.
 */
import process from 'node:process'
import { greet } from '@repo/example-package'

process.stdout.write(`${greet(process.argv[2] ?? 'world')}\n`)
