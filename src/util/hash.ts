import { createHash } from 'node:crypto'

/** SHA-256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Stable JSON stringify with sorted object keys — used for cache keys and hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
