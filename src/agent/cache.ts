/**
 * On-disk response cache — the biggest token saver.
 * Identical (provider, model, system, messages, tools) requests are replayed
 * locally: zero latency, zero tokens, zero cost.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../constants.js'
import { sha256, stableStringify } from '../util/hash.js'
import { ensureDir, writePrivateFile } from '../util/fsx.js'
import { log } from '../util/log.js'
import type { ChatResult, ToolSpec, UMessage } from '../providers/types.js'

const CACHE_VERSION = 2
const MAX_ENTRIES = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024

interface CacheEnvelope {
  version: number
  key: string
  model: string
  provider: string
  createdAt: number
  result: ChatResult
}

export function computeCacheKey(
  providerId: string,
  model: string,
  system: string,
  messages: UMessage[],
  tools: ToolSpec[],
  temperature?: number,
): string {
  return sha256(
    stableStringify({
      v: CACHE_VERSION,
      provider: providerId,
      model,
      system,
      messages,
      tools,
      temperature: temperature ?? null,
    }),
  )
}

export function cacheGet(key: string): CacheEnvelope | undefined {
  const path = entryPath(key)
  try {
    const raw = readFileSync(path, 'utf8')
    const env = JSON.parse(raw) as CacheEnvelope
    if (env.version !== CACHE_VERSION) {
      rmSync(path, { force: true })
      return undefined
    }
    return env
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug('cache', `read failed for ${key.slice(0, 8)}: ${err instanceof Error ? err.message : err}`)
    }
    return undefined
  }
}

export function cachePut(env: Omit<CacheEnvelope, 'version' | 'createdAt'>): void {
  try {
    ensureDir(PATHS.responseCacheDir)
    evictIfNeeded()
    const full: CacheEnvelope = { ...env, version: CACHE_VERSION, createdAt: Date.now() }
    const path = entryPath(env.key)
    if (existsSync(path)) return
    const data = JSON.stringify(full)
    if (data.length > MAX_FILE_BYTES) return // don't cache monster payloads
    writePrivateFile(path, data)
  } catch (err) {
    log.debug('cache', `put failed: ${err instanceof Error ? err.message : err}`)
  }
}

export function clearResponseCache(): number {
  let removed = 0
  try {
    if (!existsSync(PATHS.responseCacheDir)) return 0
    for (const f of readdirSync(PATHS.responseCacheDir)) {
      rmSync(join(PATHS.responseCacheDir, f), { force: true })
      removed++
    }
  } catch {
    /* ignore */
  }
  return removed
}

function entryPath(key: string): string {
  return join(PATHS.responseCacheDir, `${key}.json`)
}

function evictIfNeeded(): void {
  try {
    if (!existsSync(PATHS.responseCacheDir)) return
    const files = readdirSync(PATHS.responseCacheDir)
    if (files.length < MAX_ENTRIES) return
    const stats = files
      .map((f) => {
        const p = join(PATHS.responseCacheDir, f)
        try {
          return { p, mtime: statSync(p).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((s): s is { p: string; mtime: number } => s !== undefined)
      .sort((a, b) => a.mtime - b.mtime)
    const excess = stats.length - MAX_ENTRIES + 1
    for (let i = 0; i < excess; i++) {
      rmSync(stats[i]!.p, { force: true })
    }
  } catch {
    /* ignore */
  }
}
