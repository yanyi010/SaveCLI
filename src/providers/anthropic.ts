/**
 * Anthropic Messages API provider (also used for Claude logins).
 * Supports tool use, streaming, and prompt caching via cache_control breakpoints.
 */
import { consumeStream, createSseParser } from './sse.js'
import { fetchWithRetry, ProviderError } from './http.js'
import type { ChatRequest, ChatResult, LLMProvider, StopReason, UBlock, UMessage, Usage } from './types.js'
import { joinUrl } from './openai.js'

export interface AnthropicProviderOpts {
  baseUrl: string
  apiKey?: string
  /** oauth → Authorization: Bearer; api_key → x-api-key header. */
  authScheme: 'api_key' | 'bearer' | 'none'
  model: string
  maxTokens?: number
  temperature?: number
  promptCaching?: boolean
  extraHeaders?: Record<string, string>
}

interface StreamBlockAcc {
  kind: 'text' | 'tool'
  text: string
  id?: string
  name?: string
  json: string
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic'
  readonly model: string

  constructor(private opts: AnthropicProviderOpts) {
    this.model = opts.model
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const url = anthropicMessagesUrl(this.opts.baseUrl)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (this.opts.apiKey) {
      if (this.opts.authScheme === 'bearer') headers['authorization'] = `Bearer ${this.opts.apiKey}`
      else headers['x-api-key'] = this.opts.apiKey
    }
    for (const [k, v] of Object.entries(this.opts.extraHeaders ?? {})) {
      headers[k.toLowerCase()] = v
    }

    const useCache = this.opts.promptCaching === true && req.tools.length + req.messages.length > 0
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 8_192,
      stream: true,
      messages: toAnthropicMessages(req.messages, useCache),
    }
    if (useCache) {
      body['system'] = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
    } else {
      body['system'] = req.system
    }
    if (req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }
    const temp = req.temperature ?? this.opts.temperature
    if (temp !== undefined) body['temperature'] = temp

    let streamed = false
    const res = await fetchWithRetry(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      { label: `${this.id}:${this.model}`, signal: req.signal, canRetry: () => !streamed },
    )

    let usage: Usage = { input: 0, output: 0 }
    let stopReason: StopReason = 'end'
    const acc = new Map<number, StreamBlockAcc>()
    const finished: Array<{ index: number; block: StreamBlockAcc }> = []

    const parser = createSseParser((ev) => {
      let json: Record<string, unknown>
      try {
        json = JSON.parse(ev.data) as Record<string, unknown>
      } catch {
        return
      }
      const type = json['type'] as string | undefined
      if (type === undefined) return
      switch (type) {
        case 'message_start': {
          const msg = (json['message'] ?? {}) as Record<string, unknown>
          const u = (msg['usage'] ?? {}) as Record<string, unknown>
          usage = {
            input: typeof u['input_tokens'] === 'number' ? (u['input_tokens'] as number) : 0,
            output: typeof u['output_tokens'] === 'number' ? (u['output_tokens'] as number) : 0,
            cacheRead: typeof u['cache_read_input_tokens'] === 'number' ? (u['cache_read_input_tokens'] as number) : undefined,
            cacheWrite: typeof u['cache_creation_input_tokens'] === 'number' ? (u['cache_creation_input_tokens'] as number) : undefined,
          }
          break
        }
        case 'content_block_start': {
          const index = typeof json['index'] === 'number' ? json['index'] : 0
          const cb = (json['content_block'] ?? {}) as Record<string, unknown>
          if (cb['type'] === 'tool_use') {
            acc.set(index, {
              kind: 'tool',
              text: '',
              id: typeof cb['id'] === 'string' ? cb['id'] : '',
              name: typeof cb['name'] === 'string' ? cb['name'] : '',
              json: '',
            })
            if (typeof cb['name'] === 'string') req.onToolCallStart?.(cb['name'])
          } else {
            acc.set(index, { kind: 'text', text: '', json: '' })
          }
          break
        }
        case 'content_block_delta': {
          const index = typeof json['index'] === 'number' ? json['index'] : 0
          const delta = (json['delta'] ?? {}) as Record<string, unknown>
          const block = acc.get(index)
          if (!block) break
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            block.text += delta['text']
            streamed = true
            req.onText?.(delta['text'])
          } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
            block.json += delta['partial_json']
            streamed = streamed || block.json !== ''
          } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            // extended thinking — shown dimly, not part of the reply text
            req.onText?.('')
          }
          break
        }
        case 'content_block_stop': {
          const index = typeof json['index'] === 'number' ? json['index'] : 0
          const block = acc.get(index)
          if (block) {
            finished.push({ index, block })
            acc.delete(index)
          }
          break
        }
        case 'message_delta': {
          const delta = (json['delta'] ?? {}) as Record<string, unknown>
          if (delta['stop_reason'] === 'tool_use') stopReason = 'tool_use'
          else if (delta['stop_reason'] === 'max_tokens') stopReason = 'max_tokens'
          else if (delta['stop_reason'] === 'refusal') stopReason = 'refusal'
          const u = (json['usage'] ?? {}) as Record<string, unknown>
          if (typeof u['output_tokens'] === 'number') usage.output = u['output_tokens'] as number
          break
        }
        case 'message_stop':
          break
        case 'ping':
          break
        case 'error': {
          const e = (json['error'] ?? {}) as Record<string, unknown>
          throw new ProviderError(`${this.id}: stream error — ${String(e['message'] ?? ev.data).slice(0, 300)}`)
        }
        default:
          break
      }
    })

    await consumeStream(res, (chunk) => parser.write(chunk), { label: `${this.id}:${this.model}` })
    parser.flush()
    // Any blocks still open (stream cut before content_block_stop) are salvaged.
    for (const [index, block] of acc) finished.push({ index, block })
    finished.sort((a, b) => a.index - b.index)

    const blocks: UBlock[] = []
    for (const { block } of finished) {
      if (block.kind === 'text') {
        if (block.text !== '') blocks.push({ type: 'text', text: block.text })
      } else {
        blocks.push({
          type: 'tool_call',
          id: block.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: block.name || 'unknown',
          arguments: block.json === '' ? '{}' : block.json,
        })
      }
    }

    const hasToolCall = blocks.some((b) => b.type === 'tool_call')
    if (blocks.length === 0) {
      throw new ProviderError(`${this.id}: empty response (stop_reason=${stopReason})`)
    }
    if (hasToolCall) stopReason = 'tool_use'

    return { blocks, stopReason, usage, model: this.model }
  }
}

/** Build the /v1/messages URL, tolerating base URLs that already end in /v1. */
export function anthropicMessagesUrl(baseUrl: string): string {
  const b = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (b.endsWith('/v1')) return `${b}/messages`
  return joinUrl(b, '/v1/messages')
}

export function toAnthropicMessages(messages: UMessage[], markFinalCacheBreakpoint: boolean): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = messages.map((msg, i) => {
    const content = msg.blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text }
      if (b.type === 'tool_call') {
        return { type: 'tool_use', id: b.id, name: b.name, input: safeParseJson(b.arguments) }
      }
      return {
        type: 'tool_result',
        tool_use_id: b.toolCallId,
        content: [{ type: 'text', text: b.content }],
        ...(b.isError ? { is_error: true } : {}),
      }
    })
    // Second prompt-cache breakpoint on the very last message's final block.
    const isLast = i === messages.length - 1
    if (markFinalCacheBreakpoint && isLast && content.length > 0) {
      const last = content[content.length - 1] as Record<string, unknown>
      last['cache_control'] = { type: 'ephemeral' }
    }
    return { role: msg.role, content }
  })
  return out
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
