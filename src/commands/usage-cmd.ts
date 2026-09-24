/** `savecli usage` — token spend & cost overview. */
import { summarizeUsage } from '../agent/usage.js'
import { c } from '../ui/colors.js'
import { formatNumber } from '../util/tokens.js'

export function cmdUsage(_args: string[]): number {
  const s = summarizeUsage()
  if (s.allTime.requests === 0 && s.cacheHits === 0) {
    console.log(c.dim('No usage recorded yet. Start a conversation first.'))
    return 0
  }
  console.log(c.bold('SaveCLI token usage\n'))
  console.log('Today:')
  console.log(
    `  requests: ${s.today.requests} · input: ${formatNumber(s.today.input)} · output: ${formatNumber(s.today.output)} · cost: ~$${s.today.costUsd.toFixed(4)}`,
  )
  console.log('\nAll-time:')
  console.log(
    `  requests: ${s.allTime.requests} · input: ${formatNumber(s.allTime.input)} · output: ${formatNumber(s.allTime.output)} · cache-read: ${formatNumber(s.allTime.cacheRead)} · cost: ~$${s.allTime.costUsd.toFixed(4)}`,
  )
  console.log(c.green(`  ⚡ response-cache hits: ${s.cacheHits} (≈${formatNumber(s.cacheSavedTokens)} tokens & $ saved)`))
  if (s.byModel.length > 0) {
    console.log('\nBy model:')
    for (const m of s.byModel) {
      console.log(
        `  ${c.green(m.model.padEnd(36))} ${String(m.requests).padStart(5)} req · ${formatNumber(m.input).padStart(7)} in / ${formatNumber(m.output).padStart(7)} out · ~$${m.costUsd.toFixed(4)}`,
      )
    }
  }
  return 0
}
