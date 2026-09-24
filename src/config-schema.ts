/**
 * Typed, validated dotted-key access to config.
 * Every settable key is declared here — `savecli config set` refuses unknown
 * keys and suggests the closest match, so users never fight typos.
 */
import { SavecliError, type Config } from './config.js'

export interface ConfigKeyInfo {
  path: string
  type: 'boolean' | 'number' | 'string' | 'enum' | 'string[]'
  description: string
  enumValues?: readonly string[]
}

export const CONFIG_KEYS: readonly ConfigKeyInfo[] = [
  {
    path: 'defaultProfile',
    type: 'string',
    description: 'Profile used when no --model is given (see `savecli config profiles`)',
  },
  {
    path: 'tokenSaving.responseCache',
    type: 'boolean',
    description: 'Replay identical requests from the on-disk cache (0 tokens)',
  },
  {
    path: 'tokenSaving.autoCompact',
    type: 'boolean',
    description: 'Summarize old turns when context grows past the threshold',
  },
  {
    path: 'tokenSaving.compactThresholdTokens',
    type: 'number',
    description: 'Estimated-token threshold that triggers auto-compaction',
  },
  {
    path: 'tokenSaving.keepRecentTurns',
    type: 'number',
    description: 'Turns kept verbatim during compaction',
  },
  {
    path: 'tokenSaving.toolOutputLimit',
    type: 'number',
    description: 'Max bytes of a tool result before truncation (0 = unlimited)',
  },
  {
    path: 'tokenSaving.promptCaching',
    type: 'boolean',
    description: 'Use provider-side prompt caching (Anthropic cache_control)',
  },
  {
    path: 'permissions.bashAsk',
    type: 'boolean',
    description: 'Ask before running bash commands not matched by allow/deny lists',
  },
  {
    path: 'permissions.editOutsideCwd',
    type: 'enum',
    enumValues: ['ask', 'deny', 'allow'],
    description: 'Editing files outside the working directory',
  },
  { path: 'permissions.bashAllow', type: 'string[]', description: 'Glob patterns auto-allowed for bash' },
  { path: 'permissions.bashDeny', type: 'string[]', description: 'Glob patterns always denied for bash' },
  {
    path: 'security.allowProtectedReads',
    type: 'boolean',
    description: 'Let the agent read protected credential paths (NOT recommended)',
  },
  {
    path: 'security.sanitizeContext',
    type: 'boolean',
    description: 'Scrub secret-shaped strings from tool outputs before sending to the LLM',
  },
  { path: 'security.protectedPaths', type: 'string[]', description: 'Absolute glob patterns the agent may never touch' },
  { path: 'security.warnPaths', type: 'string[]', description: 'Glob patterns that trigger a sensitivity warning' },
]

const KEY_MAP = new Map(CONFIG_KEYS.map((k) => [k.path, k]))

export function findConfigKey(path: string): { info?: ConfigKeyInfo; suggestions: string[] } {
  const info = KEY_MAP.get(path)
  if (info) return { info, suggestions: [] }
  return { suggestions: closestKeys(path, 3) }
}

function closestKeys(path: string, n: number): string[] {
  const scored = CONFIG_KEYS.map((k) => ({ path: k.path, d: levenshtein(path, k.path) }))
  scored.sort((a, b) => a.d - b.d)
  return scored
    .filter((s) => s.d <= Math.max(3, Math.floor(path.length / 2)))
    .slice(0, n)
    .map((s) => s.path)
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const nn = b.length
  if (m === 0) return nn
  if (nn === 0) return m
  let prev = Array.from({ length: nn + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= nn; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[nn]!
}

/** Parse and validate a raw string into the key's expected type. */
export function coerceConfigValue(info: ConfigKeyInfo, raw: string): unknown {
  switch (info.type) {
    case 'boolean': {
      const v = raw.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(v)) return true
      if (['false', '0', 'no', 'off'].includes(v)) return false
      throw new SavecliError(`expected true/false for ${info.path}, got "${raw}"`)
    }
    case 'number': {
      const v = Number(raw)
      if (!Number.isFinite(v)) throw new SavecliError(`expected a number for ${info.path}, got "${raw}"`)
      return v
    }
    case 'enum': {
      const vals = info.enumValues ?? []
      if (!vals.includes(raw)) {
        throw new SavecliError(`expected one of ${vals.join('|')} for ${info.path}, got "${raw}"`)
      }
      return raw
    }
    case 'string[]':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    case 'string':
      return raw
  }
}

/** Read a value from a fully-merged config by dotted path. */
export function getConfigValue(config: Config, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = config
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Set a value on a (possibly partial) config object by dotted path. */
export function setConfigValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = target
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

/** Remove a key from a partial config object (falling back to defaults). */
export function unsetConfigValue(target: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let cur: unknown = target
  for (const p of parts.slice(0, -1)) {
    if (typeof cur !== 'object' || cur === null) return
    cur = (cur as Record<string, unknown>)[p]
    if (cur === undefined) return
  }
  if (typeof cur === 'object' && cur !== null) {
    delete (cur as Record<string, unknown>)[parts[parts.length - 1]!]
  }
}
