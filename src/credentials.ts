import { PATHS, savecliHome } from './constants.js'
import { ensureDir, hasPermissiveBits, readJsonFile, savecliChmod, writePrivateFile } from './util/fsx.js'
import { log } from './util/log.js'

export type CredentialKind = 'api_key' | 'oauth'

export interface CredentialEntry {
  kind: CredentialKind
  /** API key (kind=api_key). */
  apiKey?: string
  /** Base URL associated with this credential (custom gateways). */
  baseUrl?: string
  /** OAuth fields (kind=oauth). */
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  /** Human label shown in `auth status`. */
  label?: string
  createdAt: number
  updatedAt: number
}

export interface CredentialStore {
  version: number
  entries: Record<string, CredentialEntry>
}

function emptyStore(): CredentialStore {
  return { version: 1, entries: {} }
}

export function loadCredentialStore(): CredentialStore {
  const store = readJsonFile<CredentialStore>(PATHS.credentials)
  if (!store || typeof store !== 'object' || typeof store.entries !== 'object') {
    return emptyStore()
  }
  // Security: tighten permissions if they drifted open.
  if (hasPermissiveBits(PATHS.credentials)) {
    log.warn('auth', 'credentials.json has permissive bits — tightening to 0600')
    savecliChmod(PATHS.credentials, 0o600)
  }
  return { version: store.version ?? 1, entries: store.entries }
}

export function saveCredentialStore(store: CredentialStore): void {
  ensureDir(savecliHome())
  writePrivateFile(PATHS.credentials, JSON.stringify(store, null, 2) + '\n')
  if (hasPermissiveBits(PATHS.credentials)) {
    savecliChmod(PATHS.credentials, 0o600)
  }
}

export function getCredential(name: string): CredentialEntry | undefined {
  return loadCredentialStore().entries[name]
}

export function setCredential(name: string, entry: Partial<CredentialEntry> & { kind: CredentialKind }): void {
  const store = loadCredentialStore()
  const now = Date.now()
  const existing = store.entries[name]
  store.entries[name] = {
    ...existing,
    ...entry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  saveCredentialStore(store)
}

export function deleteCredential(name: string): boolean {
  const store = loadCredentialStore()
  if (!store.entries[name]) return false
  delete store.entries[name]
  saveCredentialStore(store)
  return true
}

/** Safe view of a credential for display: never exposes the full secret. */
export function describeCredential(entry: CredentialEntry): string {
  const parts: string[] = [entry.kind]
  const secret = entry.apiKey ?? entry.accessToken
  if (secret) parts.push(`key=…${secret.slice(-4)} (${secret.length} chars)`)
  if (entry.baseUrl) parts.push(`baseUrl=${entry.baseUrl}`)
  if (entry.refreshToken) parts.push('refreshToken=…present')
  if (entry.expiresAt) {
    const state = entry.expiresAt > Date.now() ? 'valid' : 'expired'
    parts.push(`expires=${new Date(entry.expiresAt).toISOString()} (${state})`)
  }
  return parts.join(' ')
}
