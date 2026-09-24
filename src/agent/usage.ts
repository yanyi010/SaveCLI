/**
 * Token usage accounting and cost estimation.
 * usage.jsonl is append-only, lives in the private SaveCLI dir, and never
 * contains prompt content — only counters and model ids.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { PATHS } from '../constants.js'
import { ensureDir, savecliChmod } from '../util/fsx.js'
import { log } from '../util/log.js'

export interface UsageRecord {
  ts: number
  profile: string
  provider: string
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  /** Served from the local response cache — zero new tokens billed. */
  fromCache?: boolean
  /** Purpose: 'chat' | 'compaction' */
  purpose?: 'chat' | 'compaction'
  costUsd?: number
}

interface ModelCost {
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
}

/**
 * Rough public list prices (USD per million tokens) for cost ESTIMATION only.
 * Patterns are matched case-insensitively against the model id.
 */
const COST_TABLE: Array<{ re: RegExp; cost: ModelCost }> = [
  { re: /claude-opus-4/i, cost: { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5 } },
  { re: /claude-sonnet-4/i, cost: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 } },
  { re: /claude-haiku-4/i, cost: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 } },
  { re: /gpt-5\.1-codex/i, cost: { inputPerM: 1.25, outputPerM: 10 } },
  { re: /gpt-5\.1/i, cost: { inputPerM: 1.25, outputPerM: 10 } },
  { re: /gpt-5-mini/i, cost: { inputPerM: 0.25, outputPerM: 2 } },
  { re: /gpt-4o\b/i, cost: { inputPerM: 2.5, outputPerM: 10 } },
  { re: /deepseek-chat|deepseek-v3/i, cost: { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07 } },
  { re: /kimi-k2/i, cost: { inputPerM: 0.6, outputPerM: 2.5 } },
  { re: /glm-4\.6/i, cost: { inputPerM: 0.6, outputPerM: 2.2 } },
  { re: /glm-4\.5-air/i, cost: { inputPerM: 0.2, outputPerM: 1.1 } },
  { re: /qwen2\.5-coder/i, cost: { inputPerM: 0, outputPerM: 0 } }, // local models
]

export function estimateCostUsd(model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number | undefined {
  const entry = COST_TABLE.find((e) => e.re.test(model))
  if (!entry) return undefined
  const { inputPerM, outputPerM, cacheReadPerM } = entry.cost
  let cost = (usage.input / 1e6) * inputPerM + (usage.output / 1e6) * outputPerM
  if (cacheReadPerM && usage.cacheRead) cost += (usage.cacheRead / 1e6) * cacheReadPerM
  if (usage.cacheWrite) cost += (usage.cacheWrite / 1e6) * (inputPerM * 1.25)
  return Math.round(cost * 1e6) / 1e6
}

export function recordUsage(rec: UsageRecord): void {
  try {
    ensureDir(PATHS.usageFile.slice(0, PATHS.usageFile.lastIndexOf('/')))
    const line = JSON.stringify(rec) + '\n'
    appendFileSync(PATHS.usageFile, line, { mode: 0o600 })
    savecliChmod(PATHS.usageFile, 0o600)
  } catch (err) {
    log.warn('usage', 'failed to record usage', err instanceof Error ? err.message : err)
  }
}

export interface UsageSummary {
  today: Totals
  allTime: Totals
  byModel: Array<{ model: string } & Totals>
  cacheHits: number
  cacheSavedTokens: number
}

export interface Totals {
  input: number
  output: number
  cacheRead: number
  requests: number
  costUsd: number
}

export function summarizeUsage(): UsageSummary {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const todayMs = startOfDay.getTime()
  const today = emptyTotals()
  const allTime = emptyTotals()
  const models = new Map<string, Totals>()
  let cacheHits = 0
  let cacheSavedTokens = 0

  if (existsSync(PATHS.usageFile)) {
    let content = ''
    try {
      content = readFileSync(PATHS.usageFile, 'utf8')
    } catch {
      content = ''
    }
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      let rec: UsageRecord
      try {
        rec = JSON.parse(line) as UsageRecord
      } catch {
        continue
      }
      const isToday = rec.ts >= todayMs
      const totals: Totals = {
        input: rec.input,
        output: rec.output,
        cacheRead: rec.cacheRead ?? 0,
        requests: 1,
        costUsd: rec.costUsd ?? 0,
      }
      if (rec.fromCache) {
        cacheHits++
        // A cache hit replays a previous response: nothing was billed again.
        cacheSavedTokens += rec.input + rec.output
      }
      addInto(allTime, totals)
      if (isToday) addInto(today, totals)
      const m = models.get(rec.model) ?? emptyTotals()
      addInto(m, totals)
      models.set(rec.model, m)
    }
  }

  return {
    today,
    allTime,
    byModel: [...models.entries()]
      .map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => b.input + b.output - (a.input + a.output)),
    cacheHits,
    cacheSavedTokens,
  }
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, requests: 0, costUsd: 0 }
}

function addInto(target: Totals, add: Totals): void {
  target.input += add.input
  target.output += add.output
  target.cacheRead += add.cacheRead
  target.requests += add.requests
  target.costUsd = Math.round((target.costUsd + add.costUsd) * 1e6) / 1e6
}
