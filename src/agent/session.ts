/**
 * Session persistence: append-only JSONL under ~/.savecli/sessions (0600).
 * Enables crash recovery and /resume without re-reading files.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PATHS } from '../constants.js'
import { ensureDir, savecliChmod } from '../util/fsx.js'
import type { UBlock, UMessage } from '../providers/types.js'

export type SessionEvent =
  | { type: 'meta'; ts: number; cwd: string; profile: string; model: string; savecliVersion: string }
  | { type: 'user'; ts: number; text: string }
  | { type: 'assistant'; ts: number; blocks: UBlock[] }
  | { type: 'tool'; ts: number; name: string; argsSummary: string; isError?: boolean; durationMs?: number }
  | { type: 'tool_result'; ts: number; toolCallId: string; content: string; isError?: boolean }
  | { type: 'summary'; ts: number; text: string }
  | { type: 'usage'; ts: number; input: number; output: number; cacheRead?: number; cacheWrite?: number; fromCache?: boolean; purpose?: string }

export interface SessionInfo {
  id: string
  startedAt: number
  cwd: string
  profile: string
  model: string
  turns: number
  firstUserText: string
}

export class Session {
  readonly id: string
  readonly path: string

  constructor(id?: string) {
    this.id = id ?? newSessionId()
    this.path = join(PATHS.sessionsDir, `${this.id}.jsonl`)
  }

  append(event: SessionEvent): void {
    try {
      ensureDir(PATHS.sessionsDir)
      appendFileSync(this.path, JSON.stringify(event) + '\n', { mode: 0o600 })
      savecliChmod(this.path, 0o600)
    } catch {
      /* sessions are best-effort */
    }
  }

  static load(id: string): SessionEvent[] {
    const path = join(PATHS.sessionsDir, `${id}.jsonl`)
    try {
      const content = readFileSync(path, 'utf8')
      return content
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as SessionEvent)
    } catch {
      return []
    }
  }

  static listRecent(limit = 20): SessionInfo[] {
    const infos: SessionInfo[] = []
    try {
      if (!existsSync(PATHS.sessionsDir)) return []
      const files = readdirSync(PATHS.sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse()
        .slice(0, limit * 2)
      for (const f of files) {
        if (infos.length >= limit) break
        const id = f.replace(/\.jsonl$/, '')
        const events = Session.load(id)
        if (events.length === 0) continue
        const meta = events.find((e): e is Extract<SessionEvent, { type: 'meta' }> => e.type === 'meta')
        if (!meta) continue
        const firstUser = events.find((e): e is Extract<SessionEvent, { type: 'user' }> => e.type === 'user')
        const turns = events.filter((e) => e.type === 'user').length
        infos.push({
          id,
          startedAt: meta.ts,
          cwd: meta.cwd,
          profile: meta.profile,
          model: meta.model,
          turns,
          firstUserText: firstUser ? firstUser.text.slice(0, 80) : '(empty)',
        })
      }
    } catch {
      /* ignore */
    }
    return infos
  }
}

/** Rebuild conversation messages from session events. */
export function eventsToMessages(events: SessionEvent[]): UMessage[] {
  const messages: UMessage[] = []
  let pendingResults: UBlock[] = []

  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      messages.push({ role: 'user', blocks: pendingResults })
      pendingResults = []
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'user':
        flushResults()
        if (ev.text !== '') messages.push({ role: 'user', blocks: [{ type: 'text', text: ev.text }] })
        break
      case 'summary':
        flushResults()
        messages.push({
          role: 'user',
          blocks: [{ type: 'text', text: `<context-summary of earlier conversation>\n${ev.text}\n</context-summary>` }],
        })
        break
      case 'assistant': {
        flushResults()
        const blocks: UBlock[] = ev.blocks.filter((b) => b.type === 'text' || b.type === 'tool_call')
        if (blocks.length > 0) messages.push({ role: 'assistant', blocks })
        break
      }
      case 'tool_result':
        pendingResults.push({ type: 'tool_result', toolCallId: ev.toolCallId, content: ev.content, isError: ev.isError })
        break
      default:
        break
    }
  }
  flushResults()
  return messages
}

export function newSessionId(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}
