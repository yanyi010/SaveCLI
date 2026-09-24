/**
 * HTTP layer for LLM providers: retry with exponential backoff + jitter,
 * retry-after support, combined abort/timeout signals, and redacted errors.
 * Never retries once streaming output has started (canRetry predicate).
 */
import { redact } from '../util/redact.js'
import { log } from '../util/log.js'

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly provider?: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])

export interface FetchOptions {
  label: string
  signal?: AbortSignal
  retries?: number
  /** Time-to-response-headers per attempt. */
  timeoutMs?: number
  /** Return false to forbid retry (e.g. partial output already streamed). */
  canRetry?: () => boolean
}

export async function fetchWithRetry(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const maxRetries = opts.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    const canRetry = (): boolean => attempt < maxRetries && (opts.canRetry?.() ?? true) && !(opts.signal?.aborted ?? false)
    try {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 120_000)
      let res: Response
      try {
        const signals: AbortSignal[] = [timeout.signal]
        if (opts.signal) signals.push(opts.signal)
        res = await fetch(url, { ...init, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] })
      } finally {
        clearTimeout(timer)
      }
      if (res.ok) return res

      if (RETRYABLE_STATUS.has(res.status) && canRetry()) {
        const waitMs = retryDelayMs(res, attempt)
        log.debug('http', `${opts.label}: HTTP ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`)
        await sleepAbortable(waitMs, opts.signal)
        continue
      }
      throw await providerErrorFromResponse(res, opts.label)
    } catch (err) {
      if (err instanceof ProviderError) throw err
      if (opts.signal?.aborted) {
        throw new ProviderError('request aborted by user', undefined, opts.label)
      }
      if (isRetryableNetworkError(err) && canRetry()) {
        const waitMs = backoffMs(attempt)
        log.debug('http', `${opts.label}: network error (${errName(err)}), retrying in ${waitMs}ms`)
        await sleepAbortable(waitMs, opts.signal)
        continue
      }
      throw new ProviderError(describeNetworkError(err, opts.label), undefined, opts.label, networkHint(err))
    }
  }
}

async function providerErrorFromResponse(res: Response, label: string): Promise<ProviderError> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 2_048)
  } catch {
    /* unreadable body */
  }
  let detail = body
  try {
    const json = JSON.parse(body) as Record<string, unknown>
    const err = json['error']
    if (typeof err === 'string') detail = err
    else if (err && typeof err === 'object' && typeof (err as Record<string, unknown>)['message'] === 'string') {
      detail = (err as Record<string, unknown>)['message'] as string
    } else if (typeof json['message'] === 'string') {
      detail = json['message']
    }
  } catch {
    /* not JSON — use raw body */
  }
  detail = redact(detail).slice(0, 500)
  return new ProviderError(`${label}: HTTP ${res.status} — ${detail || '(no body)'}`, res.status, label, statusHint(res.status))
}

function statusHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return 'check your API key (savecli auth login …) — the key was rejected'
    case 403:
      return 'the key lacks permission for this model/endpoint'
    case 404:
      return 'model id or base URL may be wrong (savecli config profile …)'
    case 413:
      return 'request too large — try /compact'
    case 422:
      return 'request rejected by the provider — check model id and parameters'
    case 429:
      return 'rate limited — retry shortly, or lower request frequency'
    default:
      if (status >= 500) return 'provider-side error — retrying may help'
      return undefined
  }
}

function isRetryableNetworkError(err: unknown): boolean {
  const name = errName(err)
  const msg = err instanceof Error ? err.message : ''
  if (name === 'AbortError') return false
  if (name === 'TimeoutError') return true
  const retryable = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'FETCH_ERROR']
  return retryable.some((code) => name.includes(code) || msg.includes(code)) || name === 'TypeError'
}

function describeNetworkError(err: unknown, label: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${label}: network error — ${redact(msg).slice(0, 300)}`
}

function networkHint(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : ''
  if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) return 'hostname not resolved — check base URL / DNS'
  if (msg.includes('ECONNREFUSED')) return 'connection refused — is the local server running?'
  if (errName(err) === 'TypeError' && msg.includes('fetch failed')) return 'check base URL and network reachability'
  return undefined
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : String(err)
}

function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get('retry-after')
  if (ra !== null) {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000)
    const date = Date.parse(ra)
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000)
  }
  return backoffMs(attempt)
}

function backoffMs(attempt: number): number {
  const base = Math.min(800 * 2 ** attempt, 15_000)
  const jitter = base * (Math.random() * 0.4 - 0.2) // ±20%
  return Math.max(100, Math.round(base + jitter))
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new ProviderError('request aborted by user'))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t)
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
