import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { ChatRequest, ChatResult, LLMProvider } from '../src/providers/types.js'
import type { ProviderHandle } from '../src/providers/index.js'

/** Fresh SAVECLI_HOME per test file run. */
export function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'savecli-test-'))
  process.env['SAVECLI_HOME'] = dir
  return dir
}

const homes: string[] = []
afterEach(() => {
  while (homes.length > 0) {
    const h = homes.pop()!
    try {
      rmSync(h, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

export function trackHome(dir: string): void {
  homes.push(dir)
}

/** A scripted provider: pops one response per complete() call. */
export class MockProvider implements LLMProvider {
  readonly id = 'mock'
  readonly model: string
  public calls: ChatRequest[] = []
  private queue: Array<ChatResult | Error>

  constructor(responses: Array<Partial<ChatResult> | Error>, model = 'mock-model') {
    this.model = model
    this.queue = responses.map((r) => {
      if (r instanceof Error) return r
      return {
        blocks: r.blocks ?? [{ type: 'text', text: r.text ?? 'ok' }],
        stopReason: r.stopReason ?? 'end',
        usage: r.usage ?? { input: 100, output: 20 },
        model,
      }
    })
  }

  complete(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req)
    const next = this.queue.shift()
    if (next === undefined) {
      return Promise.reject(new Error('MockProvider: no scripted responses left'))
    }
    if (next instanceof Error) return Promise.reject(next)
    // Stream text via callback to exercise the UI path.
    for (const block of next.blocks) {
      if (block.type === 'text' && req.onText) {
        // deliver in two chunks to simulate streaming
        const mid = Math.floor(block.text.length / 2)
        req.onText(block.text.slice(0, mid))
        req.onText(block.text.slice(mid))
      }
    }
    return Promise.resolve(next)
  }
}

export function mockHandle(provider: MockProvider): ProviderHandle {
  return { provider, keySource: 'mock', hasKey: true }
}

/** Text block helper. */
export function text(t: string): { type: 'text'; text: string } {
  return { type: 'text', text: t }
}

/** Tool call block helper. */
export function toolCall(id: string, name: string, args: unknown): { type: 'tool_call'; id: string; name: string; arguments: string } {
  return { type: 'tool_call', id, name, arguments: JSON.stringify(args) }
}
