import { describe, expect, it, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAIProvider, toOpenAIMessages, joinUrl } from '../src/providers/openai.js'
import { AnthropicProvider, anthropicMessagesUrl, toAnthropicMessages } from '../src/providers/anthropic.js'
import { ProviderError } from '../src/providers/http.js'
import type { ChatRequest } from '../src/providers/types.js'

interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown, record: Recorded) => void

class MockServer {
  server: Server
  port = 0
  requests: Recorded[] = []
  private handler: Handler

  constructor(handler: MockServer['handler']) {
    this.handler = handler
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
          /* keep raw */
        }
        const record: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
        this.requests.push(record)
        this.handler(req, res, body, record)
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }
}

const servers: MockServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

function sse(res: ServerResponse, events: Array<Record<string, unknown>>, opts: { chunkDelayMs?: number } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const sender = (i: number): void => {
    if (i >= events.length) {
      res.end()
      return
    }
    res.write(`data: ${JSON.stringify(events[i])}\n\n`)
    if (opts.chunkDelayMs) setTimeout(() => sender(i + 1), opts.chunkDelayMs)
    else sender(i + 1)
  }
  sender(0)
}

function baseReq(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: 'you are a test',
    messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    ...overrides,
  }
}

describe('openai provider (real HTTP)', () => {
  it('streams text, maps usage including deepseek cache tokens', async () => {
    const s = new MockServer((_req, res, _body) => {
      sse(res, [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_cache_hit_tokens: 5 } },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, apiKey: 'sk-test', model: 'gpt-test' })
    const streamed: string[] = []
    const result = await p.complete({ ...baseReq({ onText: (d) => streamed.push(d) }) })
    expect(result.blocks).toEqual([{ type: 'text', text: 'Hello' }])
    expect(result.stopReason).toBe('end')
    expect(result.usage).toEqual({ input: 11, output: 7, cacheRead: 5 })
    expect(streamed.join('')).toBe('Hello')
    // auth + body shape
    expect(s.requests[0]!.headers['authorization']).toBe('Bearer sk-test')
    expect(s.requests[0]!.body['model']).toBe('gpt-test')
    expect(s.requests[0]!.body['stream']).toBe(true)
    expect(s.requests[0]!.body['stream_options']).toEqual({ include_usage: true })
    expect(((s.requests[0]!.body as { messages: Array<{ role: string }> }).messages)[0]!['role']).toBe('system')
  })

  it('accumulates streamed tool calls across fragments', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"f.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, model: 'm' })
    const started: string[] = []
    const result = await p.complete(baseReq({ onToolCallStart: (n) => started.push(n) }))
    expect(result.stopReason).toBe('tool_use')
    expect(result.blocks).toEqual([{ type: 'tool_call', id: 'call_1', name: 'read', arguments: '{"path":"f.txt"}' }])
    expect(started).toContain('read')
  })

  it('falls back to max_completion_tokens on gpt-5-style 400s', async () => {
    const s = new MockServer((_req, res, body) => {
      if (body && typeof body === 'object' && 'max_tokens' in (body as object)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }))
        return
      }
      sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, model: 'gpt-5.1', maxTokens: 1024 })
    const result = await p.complete(baseReq())
    expect(result.blocks[0]).toMatchObject({ type: 'text', text: 'ok' })
    expect(s.requests).toHaveLength(2)
    expect('max_completion_tokens' in (s.requests[1]!.body as object)).toBe(true)
    expect('max_tokens' in (s.requests[1]!.body as object)).toBe(false)
  })

  it('falls back when stream_options is rejected', async () => {
    const s = new MockServer((_req, res, body) => {
      if (body && typeof body === 'object' && 'stream_options' in (body as object)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'stream_options is not supported' } }))
        return
      }
      sse(res, [{ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] }])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, model: 'm' })
    const result = await p.complete(baseReq())
    expect(result.blocks[0]).toMatchObject({ type: 'text', text: 'fine' })
    expect('stream_options' in (s.requests[1]!.body as object)).toBe(false)
  })

  it('retries on 429 with retry-after and succeeds', async () => {
    let hits = 0
    const s = new MockServer((_req, res) => {
      hits++
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited' } }))
        return
      }
      sse(res, [{ choices: [{ delta: { content: 'second try' }, finish_reason: 'stop' }] }])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, model: 'm' })
    const result = await p.complete(baseReq())
    expect(result.blocks[0]).toMatchObject({ text: 'second try' })
    expect(hits).toBe(2)
  })

  it('surfaces 401 as ProviderError with a key hint', async () => {
    const s = new MockServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key sk-secret-do-not-show' } }))
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({ baseUrl: s.url, apiKey: 'sk-secret-do-not-show', model: 'm' })
    await expect(p.complete(baseReq())).rejects.toThrow(ProviderError)
    try {
      await p.complete(baseReq())
    } catch (err) {
      const pe = err as ProviderError
      expect(pe.status).toBe(401)
      expect(pe.hint).toContain('API key')
      expect(pe.message).not.toContain('sk-secret-do-not-show') // secret redacted
      expect(pe.message).not.toMatch(/sk-[a-z]{6,}/i) // no residual key material
    }
  })

  it('merges extra headers case-insensitively', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }])
    })
    servers.push(s)
    await s.start()
    const p = new OpenAIProvider({
      baseUrl: s.url,
      apiKey: 'k',
      model: 'm',
      extraHeaders: { 'X-Custom': 'yes', 'AUTHORIZATION': 'Bearer overridden' },
    })
    await p.complete(baseReq())
    expect(s.requests[0]!.headers['x-custom']).toBe('yes')
    expect(s.requests[0]!.headers['authorization']).toBe('Bearer overridden')
  })
})

describe('anthropic provider (real HTTP)', () => {
  it('streams text with usage and cache tokens', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wor' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ks' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new AnthropicProvider({ baseUrl: s.url, apiKey: 'sk-ant', authScheme: 'api_key', model: 'claude-x' })
    const streamed: string[] = []
    const result = await p.complete({ ...baseReq({ onText: (d) => streamed.push(d) }) })
    expect(result.blocks).toEqual([{ type: 'text', text: 'works' }])
    expect(result.stopReason).toBe('end')
    expect(result.usage).toEqual({ input: 100, output: 5, cacheRead: 60, cacheWrite: 20 })
    expect(streamed.join('')).toBe('works')
    expect(s.requests[0]!.headers['x-api-key']).toBe('sk-ant')
    expect(s.requests[0]!.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('uses bearer auth when the scheme says oauth', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new AnthropicProvider({ baseUrl: s.url, apiKey: 'oauth-tok', authScheme: 'bearer', model: 'claude-x' })
    await p.complete(baseReq())
    expect(s.requests[0]!.headers['authorization']).toBe('Bearer oauth-tok')
    expect(s.requests[0]!.headers['x-api-key']).toBeUndefined()
  })

  it('reassembles tool_use input_json_delta fragments', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new AnthropicProvider({ baseUrl: s.url, authScheme: 'none', model: 'claude-x' })
    const result = await p.complete(baseReq())
    expect(result.blocks).toEqual([{ type: 'tool_call', id: 'toolu_1', name: 'bash', arguments: '{"command":"ls"}' }])
    expect(result.stopReason).toBe('tool_use')
  })

  it('adds cache_control breakpoints when prompt caching is on', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cached' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
    })
    servers.push(s)
    await s.start()
    const p = new AnthropicProvider({ baseUrl: s.url, authScheme: 'none', model: 'claude-x', promptCaching: true })
    await p.complete(baseReq({ messages: [
      { role: 'user', blocks: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'two' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'three' }] },
    ] }))
    const body = s.requests[0]!.body as { system: unknown; messages: Array<{ content: Array<Record<string, unknown>> }> }
    const sys = body.system as Array<Record<string, unknown>>
    expect(sys[0]!['cache_control']).toEqual({ type: 'ephemeral' })
    const lastMsg = body.messages[body.messages.length - 1]!
    const lastBlock = lastMsg.content[lastMsg.content.length - 1]!
    expect(lastBlock['cache_control']).toEqual({ type: 'ephemeral' })
  })

  it('propagates mid-stream errors as ProviderError', async () => {
    const s = new MockServer((_req, res) => {
      sse(res, [{ type: 'error', error: { message: 'overloaded' } }])
    })
    servers.push(s)
    await s.start()
    const p = new AnthropicProvider({ baseUrl: s.url, authScheme: 'none', model: 'claude-x' })
    await expect(p.complete(baseReq())).rejects.toThrow(/overloaded/)
  })
})

describe('message conversion units', () => {
  it('toOpenAIMessages: tool results become tool-role entries in order', () => {
    const out = toOpenAIMessages([
      { role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
      { role: 'user', blocks: [{ type: 'tool_result', toolCallId: 'c1', content: 'a b' }, { type: 'text', text: 'and then' }] },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a b' },
      { role: 'user', content: 'and then' },
    ])
  })

  it('toAnthropicMessages: tool_use/tool_result shapes and error flag', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 't1', name: 'read', arguments: '{"path":"x"}' }] },
      { role: 'user', blocks: [{ type: 'tool_result', toolCallId: 't1', content: 'boom', isError: true }] },
    ], false)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
    })
    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'boom' }], is_error: true }],
    })
  })

  it('anthropicMessagesUrl tolerates bases with and without /v1', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicMessagesUrl('https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicMessagesUrl('http://gw.local/v1')).toBe('http://gw.local/v1/messages')
    expect(anthropicMessagesUrl('http://gw.local/v1/')).toBe('http://gw.local/v1/messages')
  })

  it('joinUrl avoids double slashes', () => {
    expect(joinUrl('http://x/v1/', '/chat/completions')).toBe('http://x/v1/chat/completions')
    expect(joinUrl('http://x/v1', '/chat/completions')).toBe('http://x/v1/chat/completions')
  })
})
