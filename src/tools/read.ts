import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { checkPath, sanitizeForContext } from '../security.js'
import { err, ok, type Tool, type ToolOutput } from './types.js'
import { isBinaryContent, truncateOutput } from './util.js'

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a text file. Returns lines prefixed with their line number (1-indexed). ' +
    'Supports offset (line to start from) and limit (max lines, default 2000). ' +
    'Use read before edit for exact content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
      limit: { type: 'number', description: 'Maximum number of lines to return' },
    },
    required: ['path'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const rawPath = String(args['path'] ?? '')
    if (rawPath === '') return err('read: path is required')
    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath)

    // Security verdict first — never leak whether a protected file exists.
    const verdict = checkPath(abs, ctx.cwd, ctx.security)
    if (verdict === 'deny') {
      return err(
        `read: ${rawPath} matches a protected path (credentials/keys). ` +
          'This is a security guardrail; adjust security.protectedPaths only if you fully trust this task.',
      )
    }

    let stat
    try {
      stat = statSync(abs)
    } catch {
      return err(`read: file not found: ${rawPath}`)
    }
    if (stat.isDirectory()) return err(`read: ${rawPath} is a directory — use tree or glob`)

    let buf: Buffer
    try {
      buf = readFileSync(abs)
    } catch (e) {
      return err(`read: cannot read ${rawPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (isBinaryContent(buf)) {
      return err(`read: ${rawPath} appears to be a binary file (${buf.length} bytes)`)
    }

    ctx.readFiles.add(abs)

    const offset = Math.max(1, Number(args['offset'] ?? 1))
    const limit = Math.min(Math.max(1, Number(args['limit'] ?? DEFAULT_LIMIT)), 5000)
    const allLines = buf.toString('utf8').split('\n')
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
    const total = allLines.length

    const start = Math.min(offset, total + 1)
    const end = Math.min(start + limit - 1, total)
    const selected: string[] = []
    for (let i = start; i <= end; i++) {
      const raw = allLines[i - 1] ?? ''
      selected.push(`${i}: ${raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : raw}`)
    }

    let header = ''
    if (start > 1 || end < total) header = `[lines ${start}-${end} of ${total}]\n`
    const note = verdict === 'warn' ? '\n[note: sensitive-looking file — contents were sanitized before entering context]' : ''

    const body = header + selected.join('\n') + note
    const sanitized = sanitizeForContext(body, ctx.security).text
    const { text } = truncateOutput(sanitized, ctx.config.tokenSaving.toolOutputLimit)
    if (start > total) return ok(`[file has ${total} lines; offset ${start} is past EOF]`)
    return ok(text)
  },
}
