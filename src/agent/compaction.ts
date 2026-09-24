/**
 * Context compaction: when estimated context tokens exceed the threshold,
 * older turns are summarized into a compact context block using the small
 * (cheap) model. One small call saves every subsequent turn from re-sending
 * the full history — the core of SaveCLI's token economy.
 */
import { estimateTokens } from '../util/tokens.js'
import type { ChatResult, LLMProvider, ToolSpec, UBlock, UMessage } from '../providers/types.js'
import { log } from '../util/log.js'

const COMPACT_SYSTEM =
  'Summarize this coding-agent conversation for a successor agent. In under 300 words, keep: ' +
  '(1) the user\'s goal, (2) key decisions and their reasons, (3) files created/edited with paths, ' +
  '(4) commands run and their outcomes, (5) current state and concrete next steps. ' +
  'Use terse bullet points. No preamble.'

export interface CompactionResult {
  compacted: boolean
  summary?: string
  /** Estimated tokens before → after. */
  tokensBefore: number
  tokensAfter: number
}

export function estimateContextTokens(system: string, messages: UMessage[], tools: ToolSpec[]): number {
  let total = estimateTokens(system)
  total += estimateTokens(JSON.stringify(tools))
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'text') total += estimateTokens(block.text)
      else if (block.type === 'tool_call') total += estimateTokens(block.arguments) + 20
      else total += estimateTokens(block.content) + 20
    }
    total += 8 // per-message overhead
  }
  return total
}

/** Render messages into a flat transcript for the summarizer. */
function renderTranscript(messages: UMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'text') {
        parts.push(`[${msg.role}] ${block.text}`)
      } else if (block.type === 'tool_call') {
        parts.push(`[assistant→tool:${block.name}] ${truncate(block.arguments, 400)}`)
      } else {
        parts.push(`[tool:${block.toolCallId}] ${truncate(block.content, 400)}`)
      }
    }
  }
  return parts.join('\n').slice(0, 400_000)
}

/**
 * Compact a message list. Keeps the N most recent messages verbatim and
 * replaces everything older with a summary block. Returns the new list.
 * `focus` adds a Claude Code-style steering instruction to the summarizer.
 */
export async function compactMessages(
  smallProvider: LLMProvider,
  messages: UMessage[],
  opts: { keepRecentTurns: number; signal?: AbortSignal; focus?: string },
): Promise<{ messages: UMessage[]; summary: string | null; result?: ChatResult }> {
  const keep = Math.max(2, opts.keepRecentTurns)
  if (messages.length <= keep) return { messages, summary: null }

  const oldMessages = messages.slice(0, messages.length - keep)
  const recent = messages.slice(messages.length - keep)

  let summary: string | null = null
  let compactionResult: ChatResult | undefined
  try {
    const focusNote =
      opts.focus !== undefined && opts.focus !== ''
        ? `\n\nThe user asked to focus the summary on: ${opts.focus}`
        : ''
    const result = await smallProvider.complete({
      system: COMPACT_SYSTEM + focusNote,
      messages: [{ role: 'user', blocks: [{ type: 'text', text: renderTranscript(oldMessages) }] }],
      tools: [],
      signal: opts.signal,
    })
    compactionResult = result
    const text = result.blocks
      .filter((b): b is Extract<UBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (text !== '') summary = text
  } catch (err) {
    log.warn('compact', `summarization failed, falling back to tool-result pruning: ${err instanceof Error ? err.message : err}`)
  }

  let kept: UMessage[]
  if (summary !== null) {
    kept = [
      {
        role: 'user',
        blocks: [{ type: 'text', text: `<context-summary of earlier conversation>\n${summary}\n</context-summary>` }],
      },
      ...recent,
    ]
  } else {
    // Fallback: shrink old tool results aggressively instead of dropping them silently.
    kept = oldMessages.map(shrinkToolResults).concat(recent)
  }
  return { messages: kept, summary, result: compactionResult }
}

function shrinkToolResults(msg: UMessage): UMessage {
  return {
    role: msg.role,
    blocks: msg.blocks.map((b) =>
      b.type === 'tool_result'
        ? { ...b, content: b.content.length > 600 ? `${b.content.slice(0, 600)}\n[pruned by compaction]` : b.content }
        : b,
    ),
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
