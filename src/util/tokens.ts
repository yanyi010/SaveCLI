/**
 * Fast heuristic token estimation without a tokenizer dependency.
 * ~4 chars/token for Latin text; CJK ideographs count closer to 1 token each.
 * Used for compaction thresholds and cost display — never billed.
 */

const CJK_RE = /[\u3000-\u9fff\uff00-\uffef]/g

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.length - cjk
  return Math.ceil(rest / 4) + cjk
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
