import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { globToRegex } from '../util/glob.js'
import { err, ok, type Tool, type ToolOutput } from './types.js'
import { IGNORED_DIRS, isBinaryContent, truncateOutput } from './util.js'

const MAX_FILE_SIZE = 1024 * 1024
const MAX_MATCHES = 200
const MAX_LINE = 500

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regex (RE2/JS syntax). Returns matching lines as path:line: text. ' +
    'Searches recursively from path (default: project root); skips .git/node_modules/dist and binary files. ' +
    'Use include (glob, e.g. "*.ts") to filter files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
      include: { type: 'string', description: 'Glob filter for file names, e.g. "*.ts"' },
      maxResults: { type: 'number', description: 'Maximum matches to return (default 200)' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const pattern = String(args['pattern'] ?? '')
    if (pattern === '') return err('grep: pattern is required')
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return err(`grep: invalid regex: ${e instanceof Error ? e.message : String(e)}`)
    }
    const searchPath = String(args['path'] ?? ctx.cwd)
    const root = isAbsolute(searchPath) ? searchPath : resolve(ctx.cwd, searchPath)
    const includeRaw = args['include'] !== undefined ? String(args['include']) : undefined
    const includeRe = includeRaw ? globToRegex(includeRaw) : undefined
    const maxResults = Math.min(Math.max(1, Number(args['maxResults'] ?? MAX_MATCHES)), 1000)

    let matches = 0
    const lines: string[] = []

    function searchFile(abs: string): void {
      if (matches >= maxResults) return
      let stat
      try {
        stat = statSync(abs)
      } catch {
        return
      }
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return
      if (includeRe && !includeRe.test(abs.split('/').pop() ?? '')) return
      let content: string
      try {
        const buf = readFileSync(abs)
        if (isBinaryContent(buf)) return
        content = buf.toString('utf8')
      } catch {
        return
      }
      const fileLines = content.split('\n')
      for (let i = 0; i < fileLines.length && matches < maxResults; i++) {
        const line = fileLines[i] ?? ''
        if (line.length > 2000) continue
        if (re.test(line)) {
          matches++
          const rel = relative(ctx.cwd, abs)
          const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line.trim()
          lines.push(`${rel}:${i + 1}: ${text}`)
        }
      }
    }

    function walk(dir: string, depth: number): void {
      if (matches >= maxResults || depth > 12) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (matches >= maxResults) return
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.savecli') {
          if (entry.name !== '.github') continue
        }
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          walk(abs, depth + 1)
        } else if (entry.isFile()) {
          searchFile(abs)
        }
      }
    }

    try {
      const stat = statSync(root)
      if (stat.isFile()) searchFile(root)
      else walk(root, 0)
    } catch {
      return err(`grep: cannot access ${searchPath}`)
    }

    if (matches === 0) return ok(`no matches for /${pattern}/`)
    const body = lines.join('\n') + `\n[${matches} match${matches > 1 ? 'es' : ''}${matches >= maxResults ? ' — result cap reached, refine pattern' : ''}]`
    const { text } = truncateOutput(body, ctx.config.tokenSaving.toolOutputLimit)
    return ok(text)
  },
}
