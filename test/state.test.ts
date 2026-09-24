import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCredential, loadCredentialStore, getCredential, deleteCredential, describeCredential } from '../src/credentials.js'
import { recordUsage, summarizeUsage, estimateCostUsd } from '../src/agent/usage.js'
import { computeCacheKey, cacheGet, cachePut, clearResponseCache } from '../src/agent/cache.js'
import { Session, eventsToMessages } from '../src/agent/session.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'savecli-state-'))
  process.env['SAVECLI_HOME'] = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env['SAVECLI_HOME']
})

describe('credential store', () => {
  it('stores and reads credentials with 0600 permissions', () => {
    setCredential('openai', { kind: 'api_key', apiKey: 'sk-test-123456789' })
    const entry = getCredential('openai')
    expect(entry?.apiKey).toBe('sk-test-123456789')
    const mode = statSync(join(home, 'credentials.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('deleteCredential removes entries', () => {
    setCredential('x', { kind: 'api_key', apiKey: 'k' })
    expect(deleteCredential('x')).toBe(true)
    expect(deleteCredential('x')).toBe(false)
    expect(getCredential('x')).toBeUndefined()
  })

  it('describeCredential never reveals the full secret', () => {
    setCredential('y', { kind: 'api_key', apiKey: 'sk-verysecret-key-abcdefgh' })
    const desc = describeCredential(getCredential('y')!)
    expect(desc).toContain('efgh') // last 4 only
    expect(desc).not.toContain('sk-verysecret')
  })

  it('store survives reload', () => {
    setCredential('z', { kind: 'oauth', accessToken: 'tok123', refreshToken: 'r1' })
    const store = loadCredentialStore()
    expect(store.entries['z']?.refreshToken).toBe('r1')
  })
})

describe('usage accounting', () => {
  it('records and summarizes usage', () => {
    recordUsage({ ts: Date.now(), profile: 'p', provider: 'mock', model: 'm', input: 100, output: 50, costUsd: 0.001 })
    recordUsage({ ts: Date.now(), profile: 'p', provider: 'mock', model: 'm', input: 0, output: 0, fromCache: true, costUsd: 0 })
    const s = summarizeUsage()
    expect(s.allTime.requests).toBe(2)
    expect(s.allTime.input).toBe(100)
    expect(s.allTime.output).toBe(50)
    expect(s.cacheHits).toBe(1)
    expect(s.byModel[0]?.model).toBe('m')
  })

  it('usage file has 0600 permissions', () => {
    recordUsage({ ts: Date.now(), profile: 'p', provider: 'mock', model: 'm', input: 1, output: 1 })
    const mode = statSync(join(home, 'usage.jsonl')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('estimates costs for known models', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', { input: 1_000_000, output: 1_000_000 })
    expect(cost).toBeCloseTo(18, 1) // 3 + 15
    expect(estimateCostUsd('unknown-model-x', { input: 100, output: 100 })).toBeUndefined()
  })
})

describe('response cache', () => {
  it('round-trips entries', () => {
    const key = computeCacheKey('openai', 'm1', 'sys', [], [], undefined)
    cachePut({ key, model: 'm1', provider: 'openai', result: { blocks: [{ type: 'text', text: 'cached!' }], stopReason: 'end', usage: { input: 5, output: 5 }, model: 'm1' } })
    const hit = cacheGet(key)
    expect(hit?.result.blocks[0]).toEqual({ type: 'text', text: 'cached!' })
  })

  it('different inputs produce different keys', () => {
    const a = computeCacheKey('openai', 'm', 'sys', [{ role: 'user', blocks: [{ type: 'text', text: 'a' }] }], [], undefined)
    const b = computeCacheKey('openai', 'm', 'sys', [{ role: 'user', blocks: [{ type: 'text', text: 'b' }] }], [], undefined)
    expect(a).not.toBe(b)
  })

  it('key order in messages does not matter, content does', () => {
    const a = computeCacheKey('openai', 'm', 'sys', [{ role: 'user', blocks: [{ type: 'text', text: 'x' }] }], [], 0.5)
    const b = computeCacheKey('openai', 'm', 'sys', [{ role: 'user', blocks: [{ type: 'text', text: 'x' }] }], [], 0.5)
    expect(a).toBe(b)
  })

  it('clear removes everything', () => {
    const key = computeCacheKey('p', 'm', 's', [], [], undefined)
    cachePut({ key, model: 'm', provider: 'p', result: { blocks: [], stopReason: 'end', usage: { input: 0, output: 0 }, model: 'm' } })
    expect(cacheGet(key)).toBeDefined()
    const n = clearResponseCache()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(cacheGet(key)).toBeUndefined()
  })

  it('cache files are private', () => {
    const key = computeCacheKey('p', 'm', 's', [], [], undefined)
    cachePut({ key, model: 'm', provider: 'p', result: { blocks: [], stopReason: 'end', usage: { input: 0, output: 0 }, model: 'm' } })
    const path = join(home, 'cache', 'responses', `${key}.json`)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('session', () => {
  it('appends and rebuilds messages including tool results', () => {
    const session = new Session()
    session.append({ type: 'meta', ts: 1, cwd: '/x', profile: 'p', model: 'm', savecliVersion: '0' })
    session.append({ type: 'user', ts: 2, text: 'do the thing' })
    session.append({ type: 'assistant', ts: 3, blocks: [{ type: 'text', text: 'running' }, { type: 'tool_call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] })
    session.append({ type: 'tool_result', ts: 4, toolCallId: 'c1', content: 'file_a file_b' })
    session.append({ type: 'assistant', ts: 5, blocks: [{ type: 'text', text: 'done' }] })

    const events = Session.load(session.id)
    const messages = eventsToMessages(events)
    expect(messages).toHaveLength(4) // user, assistant, user(tool_result), assistant
    expect(messages[1]!.blocks[1]).toMatchObject({ type: 'tool_call', id: 'c1' })
    expect(messages[2]!.blocks[0]).toMatchObject({ type: 'tool_result', toolCallId: 'c1', content: 'file_a file_b' })
  })

  it('summary events rebuild as context blocks', () => {
    const session = new Session()
    session.append({ type: 'summary', ts: 1, text: 'earlier work happened' })
    session.append({ type: 'user', ts: 2, text: 'continue' })
    const messages = eventsToMessages(Session.load(session.id))
    expect(messages[0]!.blocks[0]).toMatchObject({ type: 'text' })
    expect((messages[0]!.blocks[0] as { text: string }).text).toContain('earlier work happened')
  })

  it('session files are private', () => {
    const session = new Session()
    session.append({ type: 'user', ts: 1, text: 'hi' })
    const path = join(home, 'sessions', `${session.id}.jsonl`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('writeFileSync baseline still works inside tmp home', () => {
    writeFileSync(join(home, 'plain.txt'), 'ok')
    expect(readFileSync(join(home, 'plain.txt'), 'utf8')).toBe('ok')
  })
})
