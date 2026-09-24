import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { PATHS } from './constants.js'
import type { ResolvedProfile } from './config.js'
import {
  deleteCredential,
  describeCredential,
  getCredential,
  loadCredentialStore,
  setCredential,
  type CredentialEntry,
} from './credentials.js'
import { log } from './util/log.js'
import { redact } from './util/redact.js'
import { promptHidden, promptText } from './ui/prompt.js'

const DEFAULT_DEVICE_ENDPOINTS = {
  claude: {
    device: 'https://claude.ai/api/oauth/device',
    token: 'https://claude.ai/api/oauth/token',
    verify: 'https://claude.ai/oauth/device',
  },
  codex: {
    device: 'https://auth.openai.com/oauth/device',
    token: 'https://auth.openai.com/oauth/token',
    verify: 'https://auth.openai.com/device',
  },
} as const

export type AuthProviderName = 'claude' | 'codex' | 'openai' | 'anthropic' | 'custom'

/** Standard env var names checked per provider kind (lowest priority). */
const STANDARD_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
}

export interface ApiKeyResolution {
  apiKey?: string
  /** Where the key came from — for diagnostics. Never includes the key itself. */
  source: string
  /** How the credential should be presented on the wire. */
  scheme: 'api_key' | 'bearer' | 'none'
}

/**
 * Resolve the API key for a profile. Precedence (high → low):
 *   1. inline key / SAVECLI_API_KEY (already folded into inlineApiKey)
 *   2. credentials entry named by profile.authRef
 *   3. credentials entry named after the profile
 *   4. profile.apiKeyEnv environment variable
 *   5. provider-standard environment variables
 */
export function resolveApiKey(profile: ResolvedProfile, env: NodeJS.ProcessEnv = process.env): ApiKeyResolution {
  if (profile.inlineApiKey) return { apiKey: profile.inlineApiKey, source: 'inline/env override', scheme: 'api_key' }

  const refNames: Array<[string, string]> = []
  if (profile.authRef) refNames.push([profile.authRef, `credentials:${profile.authRef}`])
  refNames.push([profile.profileName, `credentials:${profile.profileName}`])
  for (const [name, source] of refNames) {
    const entry = getCredential(name)
    if (!entry) continue
    const key = entry.apiKey ?? entry.accessToken
    if (key) {
      return {
        apiKey: key,
        source,
        scheme: entry.kind === 'oauth' ? 'bearer' : 'api_key',
      }
    }
    if (entry.refreshToken && !isExpired(entry)) {
      // No validator requirement: refresh tokens are stored but never auto-refreshed silently.
      return { apiKey: entry.refreshToken, source: `${source}(refresh)`, scheme: 'bearer' }
    }
  }

  if (profile.apiKeyEnv && env[profile.apiKeyEnv]) {
    return { apiKey: env[profile.apiKeyEnv], source: `env:${profile.apiKeyEnv}`, scheme: 'api_key' }
  }

  for (const envName of STANDARD_ENV_KEYS[profile.profileName] ?? STANDARD_ENV_KEYS[profile.provider] ?? []) {
    if (env[envName]) return { apiKey: env[envName], source: `env:${envName}`, scheme: 'api_key' }
  }

  return { source: 'none', scheme: 'none' }
}

function isExpired(entry: CredentialEntry): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt < Date.now()
}

async function fetchJson(url: string, body: unknown, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SaveCLI' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

export function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      /* browser is best-effort */
    })
    child.unref()
  } catch {
    /* ignore */
  }
}

export interface DeviceFlowResult {
  ok: boolean
  message: string
}

/**
 * OAuth device-code login for Claude / Codex.
 *
 * Attempts the real device endpoints; when unreachable (offline, endpoint changed,
 * or stubbed environment) falls back to manual paste mode so the flow always
 * completes and the credential is stored locally.
 */
export async function deviceLogin(provider: 'claude' | 'codex'): Promise<DeviceFlowResult> {
  const endpoints = DEFAULT_DEVICE_ENDPOINTS[provider]
  const deviceUrl = process.env[`SAVECLI_${provider.toUpperCase()}_DEVICE_URL`] ?? endpoints.device
  const tokenUrl = process.env[`SAVECLI_${provider.toUpperCase()}_TOKEN_URL`] ?? endpoints.token
  const fallbackVerifyUrl = process.env[`SAVECLI_${provider.toUpperCase()}_VERIFY_URL`] ?? endpoints.verify

  let device: { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
  try {
    const res = await fetchJson(deviceUrl, {
      client_name: 'SaveCLI',
      client_version: '0.1.0',
      scopes: ['agent'],
    })
    const deviceCode = typeof res['device_code'] === 'string' ? res['device_code'] : undefined
    const userCode = typeof res['user_code'] === 'string' ? res['user_code'] : undefined
    if (!deviceCode || !userCode) throw new Error('malformed device response')
    device = {
      deviceCode,
      userCode,
      verificationUri: typeof res['verification_uri'] === 'string' ? res['verification_uri'] : fallbackVerifyUrl,
      interval: typeof res['interval'] === 'number' ? res['interval'] : 3,
      expiresIn: typeof res['expires_in'] === 'number' ? res['expires_in'] : 600,
    }
  } catch (err) {
    log.debug('auth', `device endpoint unavailable (${err instanceof Error ? err.message : err}), falling back to manual paste`)
    return manualLogin(provider, fallbackVerifyUrl)
  }

  console.log(`\nOpening ${device.verificationUri}`)
  console.log(`Confirm the code: ${device.userCode}\n`)
  openBrowser(device.verificationUri)

  const deadline = Date.now() + device.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(Math.max(1, device.interval) * 1000)
    try {
      const res = await fetchJson(tokenUrl, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.deviceCode,
      })
      if (res['error'] === 'authorization_pending') continue
      const accessToken = typeof res['access_token'] === 'string' ? res['access_token'] : undefined
      if (!accessToken) throw new Error(`token response: ${String(res['error'] ?? 'no access_token')}`)
      setCredential(provider, {
        kind: 'oauth',
        accessToken,
        refreshToken: typeof res['refresh_token'] === 'string' ? res['refresh_token'] : undefined,
        expiresAt: typeof res['expires_in'] === 'number' ? Date.now() + res['expires_in'] * 1000 : undefined,
        label: `${provider} device login`,
      })
      return { ok: true, message: `Logged in to ${provider}. Credential stored in ${PATHS.credentials} (0600).` }
    } catch (err) {
      if (err instanceof Error && /authorization_pending/.test(err.message)) continue
      log.debug('auth', `token poll failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return { ok: false, message: 'Device login timed out. Try again or use --api-key.' }
}

/** Manual fallback: user authorizes in browser and pastes the resulting code. */
async function manualLogin(provider: 'claude' | 'codex', verifyUrl: string): Promise<DeviceFlowResult> {
  const nonce = randomBytes(8).toString('hex')
  const url = `${verifyUrl}?code=${nonce}`
  console.log(`\nDevice endpoint unreachable — manual login mode.`)
  console.log(`1. Open ${url}`)
  console.log(`2. Approve the request for SaveCLI`)
  console.log(`3. Paste the authorization code below\n`)
  openBrowser(url)
  const code = await promptText('Authorization code')
  if (code === '') return { ok: false, message: 'No code provided; aborted.' }
  setCredential(provider, {
    kind: 'oauth',
    accessToken: code,
    label: `${provider} manual login`,
  })
  return { ok: true, message: `Logged in to ${provider} (manual mode). Credential stored in ${PATHS.credentials} (0600).` }
}

/** Interactive API-key login for a named provider/profile. */
export async function apiKeyLogin(
  name: string,
  opts: { baseUrl?: string; apiKey?: string; label?: string } = {},
): Promise<DeviceFlowResult> {
  const baseUrl =
    opts.baseUrl ?? (await promptText('Base URL (empty = provider default)'))
  let apiKey = opts.apiKey
  if (!apiKey) {
    apiKey = await promptHidden('API key (input hidden)')
    if (apiKey === '') return { ok: false, message: 'No key provided; aborted.' }
  } else {
    console.log('Note: passing keys via --api-key is visible in `ps`; prefer the hidden prompt.')
  }
  setCredential(name, {
    kind: 'api_key',
    apiKey,
    baseUrl: baseUrl === '' ? undefined : baseUrl,
    label: opts.label ?? `${name} API key`,
  })
  return {
    ok: true,
    message: `Saved ${name} credential to ${PATHS.credentials} (0600). Base URL: ${redact(baseUrl === '' ? '(default)' : baseUrl)}`,
  }
}

export function authStatus(): Array<{ name: string; detail: string }> {
  const store = loadCredentialStore()
  return Object.entries(store.entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, detail: describeCredential(entry) }))
}

export function logout(name: string): DeviceFlowResult {
  const ok = deleteCredential(name)
  return ok
    ? { ok: true, message: `Removed credential "${name}".` }
    : { ok: false, message: `No credential named "${name}".` }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export { resolvePath }
