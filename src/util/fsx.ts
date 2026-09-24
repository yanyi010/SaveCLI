import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from './log.js'

/** Ensure a directory exists with restrictive permissions (0700 default). */
export function ensureDir(path: string, mode = 0o700): void {
  if (existsSync(path)) return
  mkdirSync(path, { mode, recursive: true })
  // mkdirSync mode is masked by umask; enforce explicitly.
  try {
    chmodSync(path, mode)
  } catch (err) {
    log.warn('fs', `could not chmod ${path}`, err instanceof Error ? err.message : err)
  }
}

/**
 * Write a file that may contain secrets: 0600 permissions, atomic (tmp + rename).
 */
export function writePrivateFile(path: string, data: string): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export function writeFileAtomic(path: string, data: string): void {
  ensureDir(dirname(path), 0o755)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, { mode: 0o644 })
  renameSync(tmp, path)
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    log.warn('fs', `failed to parse ${path}`, err instanceof Error ? err.message : err)
    return undefined
  }
}

export function writeJsonFile(path: string, value: unknown, privateFile = false): void {
  const data = JSON.stringify(value, null, 2) + '\n'
  if (privateFile) writePrivateFile(path, data)
  else writeFileAtomic(path, data)
}

/** Check a file's permission bits are not more permissive than wanted. */
export function hasPermissiveBits(path: string): boolean {
  try {
    const mode = statSync(path).mode & 0o777
    return (mode & 0o077) !== 0 // group/other has any access
  } catch {
    return false
  }
}

/** Best-effort chmod that logs failures instead of throwing. */
export function savecliChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (err) {
    log.warn('fs', `could not chmod ${path}`, err instanceof Error ? err.message : err)
  }
}

export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (err) {
    log.warn('fs', `failed to remove ${path}`, err instanceof Error ? err.message : err)
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
