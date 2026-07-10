import { describe, expect, it } from 'vitest'
import { greet } from '../src/index.ts'

describe('greet', () => {
  it('greets by name', () => {
    expect(greet('roots')).toBe('Hello, roots!')
  })
})
