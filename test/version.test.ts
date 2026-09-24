import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/constants.js'

describe('version consistency', () => {
  it('constants.VERSION matches package.json (prevents drift)', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
