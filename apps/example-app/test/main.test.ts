import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))

describe('example-app', () => {
  it('greets the name given on the command line', () => {
    // Spawned, not imported: this pins the real runtime path — node running the
    // TypeScript source and resolving the workspace package through pnpm's link.
    const r = spawnSync(process.execPath, [MAIN, 'Ada'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('Hello, Ada!\n')
  })
})
