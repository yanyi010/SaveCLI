import { describe, expect, it } from 'vitest'
import { createSseParser } from '../src/providers/sse.js'

function collect(): { events: Array<{ event: string; data: string }>; push: (chunk: string) => void } {
  const events: Array<{ event: string; data: string }> = []
  const parser = createSseParser((ev) => events.push(ev))
  return { events, push: (c: string) => parser.write(c) }
}

describe('sse parser', () => {
  it('parses simple data events', () => {
    const { events, push } = collect()
    push('data: hello\n\n')
    expect(events).toEqual([{ event: '', data: 'hello' }])
  })

  it('parses event names', () => {
    const { events, push } = collect()
    push('event: message_start\ndata: {"a":1}\n\n')
    expect(events[0]).toEqual({ event: 'message_start', data: '{"a":1}' })
  })

  it('handles CRLF line endings', () => {
    const { events, push } = collect()
    push('event: x\r\ndata: y\r\n\r\n')
    expect(events[0]).toEqual({ event: 'x', data: 'y' })
  })

  it('joins multi-line data with newlines', () => {
    const { events, push } = collect()
    push('data: line1\ndata: line2\n\n')
    expect(events[0]!.data).toBe('line1\nline2')
  })

  it('ignores comments and keep-alives', () => {
    const { events, push } = collect()
    push(': ping\n\n')
    push('data: real\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toBe('real')
  })

  it('handles chunks split mid-line', () => {
    const { events, push } = collect()
    push('data: {"par')
    push('tial":1}\n')
    push('\n')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toBe('{"partial":1}')
  })

  it('handles openai-style streams', () => {
    const { events, push } = collect()
    push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    push('data: [DONE]\n\n')
    expect(events).toHaveLength(2)
    expect(events[1]!.data).toBe('[DONE]')
  })

  it('flushes a trailing event without a blank line at EOF', () => {
    const events: Array<{ event: string; data: string }> = []
    const parser = createSseParser((ev) => events.push(ev))
    parser.write('data: tail')
    parser.flush()
    expect(events).toEqual([{ event: '', data: 'tail' }])
  })

  it('strips only the first space after the field colon', () => {
    const { events, push } = collect()
    push('data:  two spaces\n\n')
    expect(events[0]!.data).toBe(' two spaces')
  })
})
