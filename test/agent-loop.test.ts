import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentCallbacks } from '../src/agent/loop.js'
import { compactMessages, estimateContextTokens } from '../src/agent/compaction.js'
import { defaultConfig, type ResolvedProfile } from '../src/config.js'
import { MockProvider, mockHandle, text, toolCall, freshHome, trackHome } from './helpers.js'
import type { UMessage } from '../src/providers/types.js'

let cwd: string
let home: string

const PROFILE: ResolvedProfile = {
  profileName: 'mock',
  provider: 'openai',
  baseUrl: 'http://localhost:0/v1',
  model: 'mock-model',
}

function makeAgent(
  provider: MockProvider,
  opts: {
    config?: ReturnType<typeof defaultConfig>
    yolo?: boolean
    nonInteractive?: boolean
    cacheDisabled?: boolean
  } = {},
): Agent {
  const config = opts.config ?? defaultConfig()
  // Keep tests fast and deterministic: no auto-compaction unless testing it.
  config.tokenSaving.autoCompact = false
  return new Agent({
    cwd,
    config,
    profile: PROFILE,
    yolo: opts.yolo,
    nonInteractive: opts.nonInteractive,
    cacheDisabled: opts.cacheDisabled ?? true,
    providerFactory: () => mockHandle(provider),
  })
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'savecli-agent-'))
  home = freshHome()
  trackHome(home)
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('agent loop', () => {
  it('returns plain text without tools', async () => {
    const provider = new MockProvider([{ text: 'hello there' }])
    const agent = makeAgent(provider)
    const chunks: string[] = []
    const result = await agent.send('hi', { onText: (d) => chunks.push(d) })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('hello there')
    expect(result.turns).toBe(1)
    expect(chunks.join('')).toBe('hello there') // streamed
    expect(agent.messages).toHaveLength(2) // user + assistant
  })

  it('executes tool calls and loops to a final answer', async () => {
    writeFileSync(join(cwd, 'note.txt'), 'the answer is 42\n')
    const provider = new MockProvider([
      { blocks: [text('let me check'), toolCall('c1', 'read', { path: 'note.txt' })], stopReason: 'tool_use' },
      { text: 'the answer is 42' },
    ])
    const agent = makeAgent(provider, { yolo: true })
    const toolCalls: Array<{ name: string; isError: boolean }> = []
    const result = await agent.send('what is in note.txt?', {
      onToolEnd: (name, _s, isError) => toolCalls.push({ name, isError }),
    })
    expect(result.ok).toBe(true)
    expect(result.toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ name: 'read', isError: false })
    expect(result.text).toBe('the answer is 42')
    // user, assistant(tool_call), user(tool_result), assistant(final)
    expect(agent.messages).toHaveLength(4)
    expect(provider.calls[1]?.messages[2]?.blocks[0]).toMatchObject({ type: 'tool_result', toolCallId: 'c1' })
  })

  it('reports unknown tools as errors to the model', async () => {
    const provider = new MockProvider([
      { blocks: [toolCall('c1', 'nonexistent_tool', {})], stopReason: 'tool_use' },
      { text: 'recovered' },
    ])
    const agent = makeAgent(provider)
    const result = await agent.send('try weird tool')
    expect(result.ok).toBe(true)
    expect(result.toolCalls[0]?.isError).toBe(true)
    const toolResult = agent.messages[2]?.blocks[0]
    expect((toolResult as { content: string }).content).toContain('unknown tool')
  })

  it('steering injects queued messages between iterations', async () => {
    const provider = new MockProvider([
      { blocks: [toolCall('c1', 'bash', { command: 'echo one' })], stopReason: 'tool_use' },
      { text: 'done' },
    ])
    const agent = makeAgent(provider, { yolo: true })
    let drained = false
    const callbacks: AgentCallbacks = {
      drainQueue: () => {
        if (drained) return []
        drained = true
        return ['actually, use echo two instead']
      },
    }
    await agent.send('run echo one', callbacks)
    // The second request must contain the steering message before tool result.
    const second = provider.calls[1]
    expect(second).toBeDefined()
    const texts = JSON.stringify(second?.messages)
    expect(texts).toContain('actually, use echo two instead')
  })

  it('handles provider errors gracefully', async () => {
    const provider = new MockProvider([new Error('connection refused')])
    const agent = makeAgent(provider)
    const result = await agent.send('hello')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connection refused')
  })

  it('saves session events for resume', async () => {
    const provider = new MockProvider([{ text: 'ok' }])
    const agent = makeAgent(provider)
    await agent.send('remember this')
    const path = join(home, 'sessions', `${agent.session.id}.jsonl`)
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const events = lines.map((l) => JSON.parse(l) as { type: string })
    expect(events.map((e) => e.type)).toEqual(['meta', 'user', 'assistant'])
  })

  it('undo restores files changed in the last turn', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'original\n')
    const provider = new MockProvider([
      { blocks: [toolCall('c1', 'write', { path: 'f.txt', content: 'clobbered\n' })], stopReason: 'tool_use' },
      { text: 'written' },
    ])
    const agent = makeAgent(provider, { yolo: true })
    await agent.send('overwrite f.txt')
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('clobbered\n')
    const undone = agent.undoLastTurn()
    expect(undone).toEqual([join(cwd, 'f.txt')])
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('original\n')
  })

  it('undo removes files created in the turn', async () => {
    const provider = new MockProvider([
      { blocks: [toolCall('c1', 'write', { path: 'created.txt', content: 'new\n' })], stopReason: 'tool_use' },
      { text: 'created' },
    ])
    const agent = makeAgent(provider, { yolo: true })
    await agent.send('create a file')
    expect(existsSync(join(cwd, 'created.txt'))).toBe(true)
    agent.undoLastTurn()
    expect(existsSync(join(cwd, 'created.txt'))).toBe(false)
  })

  it('fork copies conversation but diverges independently', async () => {
    const p1 = new MockProvider([{ text: 'branch a' }])
    const agent = makeAgent(p1)
    await agent.send('shared history')
    const fork = agent.fork()
    expect(fork.messages).toEqual(agent.messages)
    expect(fork.session.id).not.toBe(agent.session.id)
    // Diverge: fork gets its own provider queue.
    const p2 = new MockProvider([{ text: 'branch b' }])
    ;(fork as unknown as { handle: unknown }).handle = mockHandle(p2)
    await fork.send('go a different way')
    expect(fork.messages.length).toBeGreaterThan(agent.messages.length)
  })

  it('notifies and stops at the tool-turn safety limit', async () => {
    // Endless tool loop: every response calls a tool.
    const responses = Array.from({ length: 60 }, (_, i) => ({
      blocks: [toolCall(`c${i}`, 'bash', { command: 'echo loop' })],
      stopReason: 'tool_use' as const,
    }))
    const provider = new MockProvider(responses)
    const agent = makeAgent(provider, { yolo: true })
    const notices: string[] = []
    const result = await agent.send('loop forever', { onNotice: (n) => notices.push(n) })
    expect(result.ok).toBe(true)
    expect(result.toolCalls.length).toBe(40)
    expect(notices.some((n) => n.includes('safety limit'))).toBe(true)
  })

  it('aborts cleanly via AbortSignal', async () => {
    const provider = new MockProvider([new Error('aborted')])
    const agent = makeAgent(provider)
    const controller = new AbortController()
    controller.abort()
    const result = await agent.send('x', {}, controller.signal)
    expect(result.error).toBe('aborted')
  })
})

describe('response cache in the loop', () => {
  it('second identical turn is served from cache with zero billed tokens', async () => {
    const provider = new MockProvider([
      { text: 'cached answer' },
      { text: 'SHOULD NOT BE CALLED' },
    ])
    const agent = makeAgent(provider, { cacheDisabled: false })
    const r1 = await agent.send('what is the magic word?')
    expect(r1.text).toBe('cached answer')

    // Fresh agent, same conversation prefix → same cache key.
    const agent2 = new Agent({
      cwd,
      config: { ...defaultConfig(), tokenSaving: { ...defaultConfig().tokenSaving, autoCompact: false } },
      profile: PROFILE,
      cacheDisabled: false,
      providerFactory: () => mockHandle(provider),
    })
    const r2 = await agent2.send('what is the magic word?')
    expect(r2.text).toBe('cached answer')
    expect(provider.calls).toHaveLength(1) // only the first went to the wire
    expect(r2.usage.input).toBe(0)
    expect(r2.usage.output).toBe(0)
  })
})

describe('compaction', () => {
  function longConversation(n: number): UMessage[] {
    const out: UMessage[] = []
    for (let i = 0; i < n; i++) {
      out.push({ role: 'user', blocks: [{ type: 'text', text: `question number ${i} `.repeat(30) }] })
      out.push({
        role: 'assistant',
        blocks: [
          { type: 'tool_call', id: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: `echo ${i}` }) },
        ],
      })
      out.push({
        role: 'user',
        blocks: [{ type: 'tool_result', toolCallId: `c${i}`, content: `output ${i} `.repeat(200) }],
      })
    }
    return out
  }

  it('summarizes old turns and keeps recent ones verbatim', async () => {
    const messages = longConversation(6)
    const small = new MockProvider([{ text: '- goal: test compaction\n- state: mid-way' }])
    const { messages: compacted, summary } = await compactMessages(small, messages, { keepRecentTurns: 4 })
    expect(summary).toBe('- goal: test compaction\n- state: mid-way')
    expect(compacted[0]?.blocks[0]).toMatchObject({ type: 'text' })
    expect((compacted[0]!.blocks[0] as { text: string }).text).toContain('context-summary')
    // summary + last 4 messages
    expect(compacted).toHaveLength(5)
    expect(compacted.slice(1)).toEqual(messages.slice(-4))
  })

  it('falls back to tool-result pruning when the small model fails', async () => {
    const messages = longConversation(6)
    const hugeIdx = messages.findIndex((m) => m.blocks.some((b) => b.type === 'tool_result' && b.content.length > 600))
    expect(hugeIdx).toBeGreaterThanOrEqual(0)
    const small = new MockProvider([new Error('small model down')])
    const { summary, messages: kept } = await compactMessages(small, messages, { keepRecentTurns: 4 })
    expect(summary).toBeNull()
    // Everything kept, but old tool results pruned to ≤600 chars + marker
    const pruned = kept[hugeIdx]!.blocks[0] as { type: string; content: string }
    expect(pruned.content.length).toBeLessThanOrEqual(630)
    expect(pruned.content).toContain('[pruned by compaction]')
  })

  it('estimateContextTokens grows with content', () => {
    const small = estimateContextTokens('sys', [{ role: 'user', blocks: [{ type: 'text', text: 'short' }] }], [])
    const big = estimateContextTokens(
      'sys',
      [{ role: 'user', blocks: [{ type: 'text', text: 'word '.repeat(5000) }] }],
      [],
    )
    expect(big).toBeGreaterThan(small * 100)
  })

  it('focus instruction reaches the summarizer prompt', async () => {
    const messages = longConversation(4)
    const small = new MockProvider([{ text: 'focused summary' }])
    await compactMessages(small, messages, { keepRecentTurns: 2, focus: 'the flaky test' })
    const req = small.calls[0]
    expect((req?.system as string) ?? '').toContain('the flaky test')
  })

  it('agent.compact() swaps history and emits a notice', async () => {
    const provider = new MockProvider([{ text: 'answer after compact' }])
    const small = new MockProvider([{ text: 'summary of earlier work' }])
    const config = defaultConfig()
    config.tokenSaving.autoCompact = false
    config.tokenSaving.keepRecentTurns = 2
    const agent = new Agent({
      cwd,
      config,
      profile: PROFILE,
      cacheDisabled: true,
      providerFactory: () => mockHandle(provider),
      smallProviderFactory: () => mockHandle(small),
    })
    // Build up history: 3 user/assistant pairs.
    for (let i = 0; i < 3; i++) {
      const p = new MockProvider([{ text: `reply ${i}` }])
      const a = new Agent({
        cwd,
        config,
        profile: PROFILE,
        cacheDisabled: true,
        providerFactory: () => mockHandle(p),
      })
      await a.send(`msg ${i}`)
      agent.messages.push(...a.messages.filter((m) => m.role === 'user' || m.role === 'assistant'))
    }
    const notices: string[] = []
    const ok = await agent.compact({ onNotice: (n) => notices.push(n) })
    expect(ok).toBe(true)
    expect(agent.messages[0]?.blocks[0]).toMatchObject({ type: 'text' })
    expect((agent.messages[0]!.blocks[0] as { text: string }).text).toContain('summary of earlier work')
    expect(notices[0]).toContain('Compacted')
  })
})
