/**
 * OpenAI-compatible chat/completions provider.
 * Works with OpenAI, DeepSeek, Kimi, GLM, OpenRouter, Ollama, LM Studio and
 * any custom gateway that speaks the /chat/completions dialect.
 */
import { consumeStream, createSseParser } from './sse.js'
import { fetchWithRetry, ProviderError } from './http.js'
import type { ChatRequest, ChatResult, LLMProvider, StopReason, UBlock, UMessage, Usage } from './types.js'

export interface OpenAIProviderOpts {
  baseUrl: string
  apiKey?: string
  model: string
  maxTokens?: number
  temperature?: number
  extraHeaders?: Record<string, string>
}

interface AccumulatedToolCall {
  id: string
  name: string
  args: string
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai'
  readonly model: string

  constructor(private opts: OpenAIProviderOpts) {
    this.model = opts.model
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    // Parameter-compat fallbacks: gpt-5 family wants max_completion_tokens;
    // some gateways reject stream_options. Retry once per incompatibility.
    try {
      return await this.doComplete(req, { useMaxCompletionTokens: false, includeStreamOptions: true })
    } catch (err) {
      if (err instanceof ProviderError && err.status === 400 && this.mentions(err, 'max_tokens')) {
        return await this.doComplete(req, { useMaxCompletionTokens: true, includeStreamOptions: true })
      }
      throw err
    }
  }

  private mentions(err: ProviderError, needle: string): boolean {
    return err.message.includes(needle)
  }

  private async doComplete(
    req: ChatRequest,
    flags: { useMaxCompletionTokens: boolean; includeStreamOptions: boolean },
  ): Promise<ChatResult> {
    try {
      return await this.attempt(req, flags)
    } catch (err) {
      if (
        err instanceof ProviderError &&
        err.status === 400 &&
        this.mentions(err, 'stream_options') &&
        flags.includeStreamOptions
      ) {
        return await this.attempt(req, { ...flags, includeStreamOptions: false })
      }
      throw err
    }
  }

  private async attempt(
    req: ChatRequest,
    flags: { useMaxCompletionTokens: boolean; includeStreamOptions: boolean },
  ): Promise<ChatResult> {
    const url = joinUrl(this.opts.baseUrl, '/chat/completions')
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...toOpenAIMessages(req.messages),
      ],
      stream: true,
    }
    if (req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    if (this.opts.maxTokens !== undefined || req.maxTokens !== undefined) {
      const max = req.maxTokens ?? this.opts.maxTokens
      if (max !== undefined) {
        body[flags.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = max
      }
    }
    const temp = req.temperature ?? this.opts.temperature
    if (temp !== undefined) body['temperature'] = temp
    if (flags.includeStreamOptions) body['stream_options'] = { include_usage: true }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`
    for (const [k, v] of Object.entries(this.opts.extraHeaders ?? {})) {
      headers[k.toLowerCase()] = v
    }

    let streamedText = false
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      {
        label: `${this.id}:${this.model}`,
        signal: req.signal,
        canRetry: () => !streamedText,
      },
    )

    let text = ''
    const toolCalls: Map<number, AccumulatedToolCall> = new Map()
    let finishReason: string | undefined
    let usage: Usage = { input: 0, output: 0 }
    let done = false

    const parser = createSseParser((ev) => {
      if (done) return
      if (ev.data === '[DONE]') {
        done = true
        return
      }
      let json: Record<string, unknown>
      try {
        json = JSON.parse(ev.data) as Record<string, unknown>
      } catch {
        return // keep-alive or non-JSON line
      }
      if (json['error'] !== undefined) {
        const e = json['error'] as Record<string, unknown>
        throw new ProviderError(`${this.id}: stream error — ${String(e['message'] ?? ev.data).slice(0, 300)}`)
      }
      const u = json['usage'] as Record<string, unknown> | undefined
      if (u) usage = mapUsage(u)
      const choices = json['choices'] as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      if (!choice) return
      const delta = choice['delta'] as Record<string, unknown> | undefined
      if (delta) {
        const content = delta['content']
        if (typeof content === 'string' && content !== '') {
          streamedText = true
          text += content
          req.onText?.(content)
        }
        const tcs = delta['tool_calls'] as Array<Record<string, unknown>> | undefined
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = typeof tc['index'] === 'number' ? tc['index'] : 0
            const fn = (tc['function'] ?? {}) as Record<string, unknown>
            const existing = toolCalls.get(idx) ?? { id: '', name: '', args: '' }
            if (typeof tc['id'] === 'string' && tc['id'] !== '') existing.id = tc['id']
            if (typeof fn['name'] === 'string' && fn['name'] !== '') {
              if (existing.name !== fn['name']) req.onToolCallStart?.(fn['name'])
              existing.name = fn['name']
            }
            if (typeof fn['arguments'] === 'string') existing.args += fn['arguments']
            toolCalls.set(idx, existing)
            streamedText = streamedText || existing.args !== ''
          }
        }
      }
      if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason']
    })

    await consumeStream(res, (chunk) => parser.write(chunk), { label: `${this.id}:${this.model}` })
    parser.flush()

    const blocks: UBlock[] = []
    if (text !== '') blocks.push({ type: 'text', text })
    for (const tc of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
      if (tc.name === '' && tc.args === '') continue
      blocks.push({ type: 'tool_call', id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.name, arguments: tc.args === '' ? '{}' : tc.args })
    }

    if (blocks.length === 0 && finishReason !== 'tool_calls') {
      throw new ProviderError(`${this.id}: empty response (finish_reason=${finishReason ?? 'none'})`)
    }

    return {
      blocks,
      stopReason: mapStopReason(finishReason, blocks),
      usage,
      model: this.model,
    }
  }
}

function mapStopReason(finish: string | undefined, blocks: Array<{ type: string }>): StopReason {
  if (blocks.some((b) => b.type === 'tool_call')) return 'tool_use'
  switch (finish) {
    case 'stop':
      return 'end'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end'
  }
}

function mapUsage(u: Record<string, unknown>): Usage {
  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const cacheRead =
    (typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : undefined) ??
    (typeof u['prompt_cache_hit_tokens'] === 'number' ? (u['prompt_cache_hit_tokens'] as number) : undefined)
  return {
    input: typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0,
    output: typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0,
    cacheRead,
  }
}

export function toOpenAIMessages(messages: UMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const textBlocks = msg.blocks.filter((b) => b.type === 'text') as Array<{ type: 'text'; text: string }>
      const calls = msg.blocks.filter((b) => b.type === 'tool_call') as Array<{
        type: 'tool_call'
        id: string
        name: string
        arguments: string
      }>
      const content = textBlocks.map((b) => b.text).join('')
      const entry: Record<string, unknown> = { role: 'assistant', content: content === '' ? null : content }
      if (calls.length > 0) {
        entry['tool_calls'] = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments === '' ? '{}' : c.arguments },
        }))
      }
      out.push(entry)
    } else {
      // user message: tool_results become tool-role messages, then remaining text
      let text = ''
      for (const b of msg.blocks) {
        if (b.type === 'tool_result') {
          if (text !== '') {
            out.push({ role: 'user', content: text })
            text = ''
          }
          out.push({ role: 'tool', tool_call_id: b.toolCallId, content: b.content })
        } else if (b.type === 'text') {
          text += (text === '' ? '' : '\n') + b.text
        }
      }
      if (text !== '') out.push({ role: 'user', content: text })
    }
  }
  return out
}

export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  return `${b}${path}`
}
