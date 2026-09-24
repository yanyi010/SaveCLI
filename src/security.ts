/**
 * Security policy engine.
 *
 * Layers:
 *  1. Protected paths — credential/key material is denied to the agent (read & write)
 *     unless the user explicitly opts in. Covers SaveCLI's own stores.
 *  2. Warn paths — commonly sensitive project files (.env, *.pem): allowed, but the
 *     user is warned that contents will travel to their configured LLM provider.
 *  3. Context sanitizer — tool outputs are scrubbed of secret-shaped strings and
 *     private key blocks before they enter the conversation (and thus any network).
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { PATHS, savecliHome } from './constants.js'
import { globMatchList } from './util/glob.js'
import { redact } from './util/redact.js'

export type PathVerdict = 'ok' | 'warn' | 'deny' | 'ask'

export interface SecurityConfig {
  /** Absolute glob patterns the agent may never read or write. */
  protectedPaths: string[]
  /** Glob patterns that trigger a user warning before contents enter the context. */
  warnPaths: string[]
  /** Opt out of protected-path enforcement (not recommended). */
  allowProtectedReads: boolean
  /** Scrub secret-shaped strings from tool outputs before they reach the LLM. */
  sanitizeContext: boolean
}

export function defaultSecurityConfig(): SecurityConfig {
  const home = homedir()
  const cli = savecliHome()
  return {
    protectedPaths: [
      `${home}/.ssh/**`,
      `${home}/.aws/**`,
      `${home}/.gcloud/**`,
      `${home}/.config/gcloud/**`,
      `${home}/.kube/**`,
      `${home}/.gnupg/**`,
      `${home}/.docker/config.json`,
      `${home}/.netrc`,
      PATHS.credentials,
      `${cli}/cache/**`,
      `${cli}/sessions/**`,
      `${cli}/usage.jsonl`,
    ],
    warnPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/secrets.*'],
    allowProtectedReads: false,
    sanitizeContext: true,
  }
}

/** Check a (possibly relative) path against the security policy. */
export function checkPath(rawPath: string, cwd: string, security: SecurityConfig): PathVerdict {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  if (security.allowProtectedReads) {
    // Still warn on obviously sensitive material.
    if (globMatchList(security.warnPaths, abs)) return 'warn'
    return 'ok'
  }
  if (globMatchList(security.protectedPaths, abs)) return 'deny'
  if (globMatchList(security.warnPaths, abs)) return 'warn'
  return 'ok'
}

/**
 * Write-path policy (Codex-inspired): besides the protected list, project
 * metadata is shielded from agent writes — the agent must not rewrite its own
 * instructions or repository history.
 *   .git/**            → deny (always)
 *   .savecli/**        → deny (agent config/session state)
 *   AGENTS.md/CLAUDE.md at project root → ask (user's own instructions)
 */
export function checkWritePath(rawPath: string, cwd: string, security: SecurityConfig, opts: { yolo: boolean }): PathVerdict {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  const rel = resolve(cwd, abs).slice(cwd.length + 1)

  if (rel === '.git' || rel.startsWith('.git/')) return 'deny'
  if (rel === '.savecli' || rel.startsWith('.savecli/')) return 'deny'
  if (opts.yolo) {
    return checkPath(abs, cwd, security) === 'deny' ? 'deny' : 'ok'
  }
  if (rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel === 'SAVECLI.md') {
    return security.allowProtectedReads ? 'ok' : 'ask'
  }
  const base = checkPath(abs, cwd, security)
  if (base === 'deny') return 'deny'
  return base
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * Sanitize text before it enters the LLM context: removes private key blocks and
 * secret-shaped strings. Returns the scrubbed text and a count of redactions.
 */
export function sanitizeForContext(
  text: string,
  security: SecurityConfig,
): { text: string; redactions: number } {
  if (!security.sanitizeContext) return { text, redactions: 0 }
  let count = 0
  let out = text.replace(PRIVATE_KEY_BLOCK, () => {
    count++
    return '-----BEGIN PRIVATE KEY----- [REDACTED BY SAVECLI] -----END PRIVATE KEY-----'
  })
  const before = out
  out = redact(out)
  count += countOccurrences(before, out)
  return { text: out, redactions: count }
}

/** Heuristic: how many '[REDACTED]' markers appeared (approximates removed secrets). */
function countOccurrences(before: string, after: string): number {
  const markers = (after.match(/\[REDACTED\]/g) ?? []).length
  const beforeMarkers = (before.match(/\[REDACTED\]/g) ?? []).length
  return Math.max(0, markers - beforeMarkers)
}
