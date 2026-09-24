import { describe, expect, it } from 'vitest'
import { estimateTokens, formatNumber } from '../src/util/tokens.js'
import { sha256, stableStringify } from '../src/util/hash.js'

describe('estimateTokens', () => {
  it('estimates ~4 chars per token for latin text', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('counts CJK closer to 1 token per char', () => {
    const cjk = '你好世界' // 4 chars
    expect(estimateTokens(cjk)).toBe(4)
  })

  it('mixed content is a sum', () => {
    const mixed = 'abcd你好' // 4 latin + 2 cjk
    expect(estimateTokens(mixed)).toBe(1 + 2)
  })
})

describe('formatNumber', () => {
  it('formats thousands and millions', () => {
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(1500)).toBe('1.5k')
    expect(formatNumber(2_400_000)).toBe('2.4M')
  })
})

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ b: 1, a: 2 })).not.toBe(stableStringify({ a: 1, b: 2 }))
  })

  it('handles nested structures and arrays', () => {
    const a = stableStringify({ x: [{ z: 1, y: 2 }] })
    const b = stableStringify({ x: [{ y: 2, z: 1 }] })
    expect(a).toBe(b)
  })

  it('sha256 is stable', () => {
    expect(sha256('hello')).toBe(sha256('hello'))
    expect(sha256('hello')).not.toBe(sha256('world'))
    expect(sha256('hello')).toMatch(/^[a-f0-9]{64}$/)
  })
})
