/**
 * Incremental Server-Sent Events parser.
 * Handles CRLF, multi-line `data:`, `event:` fields, comment lines, and
 * dispatch on blank line per the SSE spec.
 */
export interface SseEvent {
  event: string
  data: string
}

export interface SseParser {
  write(chunk: string): void
  /** Dispatch any buffered event at EOF (stream ended without trailing newline). */
  flush(): void
}

export function createSseParser(onEvent: (ev: SseEvent) => void): SseParser {
  let buffer = ''
  let dataLines: string[] = []
  let eventName = ''

  function processLine(line: string): void {
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return // comment / keep-alive
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).replace(/^ /, '')
    } else if (line.startsWith('id:') || line.startsWith('retry:')) {
      // ignored fields
    } else {
      // unknown field — ignore per spec
    }
  }

  function dispatch(): void {
    if (dataLines.length === 0) {
      eventName = ''
      return
    }
    const data = dataLines.join('\n')
    const ev = { event: eventName, data }
    dataLines = []
    eventName = ''
    onEvent(ev)
  }

  return {
    write(chunk: string): void {
      buffer += chunk
       
      while (true) {
        const lf = buffer.indexOf('\n')
        const cr = buffer.indexOf('\r')
        let cut = -1
        let skip = 0
        if (lf === -1 && cr === -1) break
        if (cr !== -1 && (lf === -1 || cr < lf)) {
          cut = cr
          skip = buffer[cr + 1] === '\n' ? 2 : 1
        } else {
          cut = lf
          skip = 1
        }
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + skip)
        processLine(line)
      }
    },
    flush(): void {
      if (buffer !== '') {
        processLine(buffer)
        buffer = ''
      }
      dispatch()
    },
  }
}

/**
 * Consume a streaming response body with an idle watchdog.
 * Throws ProviderError-style Error if no bytes arrive within idleTimeoutMs.
 */
export async function consumeStream(
  res: Response,
  onChunk: (chunk: string) => void,
  opts: { idleTimeoutMs?: number; label?: string } = {},
): Promise<void> {
  if (!res.body) {
    // No body (shouldn't happen with SSE) — nothing to consume.
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const idleMs = opts.idleTimeoutMs ?? 180_000
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = (): void => {
    timer = setTimeout(() => {
      timedOut = true
      void reader.cancel().catch(() => {})
    }, idleMs)
  }

  try {
     
    while (true) {
      arm()
      const { done, value } = await reader.read()
      if (timer) clearTimeout(timer)
      if (done) break
      if (value && value.length > 0) onChunk(decoder.decode(value, { stream: true }))
    }
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
  if (timedOut) {
    throw new Error(`stream idle timeout (${idleMs}ms without data) from ${opts.label ?? 'provider'}`)
  }
  const tail = decoder.decode()
  if (tail !== '') onChunk(tail)
}
