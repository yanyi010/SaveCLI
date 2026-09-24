import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { err, ok, type Tool, type ToolOutput } from './types.js'
import { humanSize, IGNORED_DIRS } from './util.js'

const MAX_ENTRIES = 400
const DEFAULT_DEPTH = 3

export const treeTool: Tool = {
  name: 'tree',
  description:
    'Show a directory tree with file sizes — the cheapest way to understand project structure. ' +
    'maxDepth default 3. Skips .git/node_modules/dist and hidden dirs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to show (default: cwd)' },
      maxDepth: { type: 'number', description: 'Maximum depth (default 3)' },
    },
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const searchPath = String(args['path'] ?? ctx.cwd)
    const root = isAbsolute(searchPath) ? searchPath : resolve(ctx.cwd, searchPath)
    const maxDepth = Math.min(Math.max(1, Number(args['maxDepth'] ?? DEFAULT_DEPTH)), 8)

    let entryCount = 0
    const lines: string[] = []

    function walk(dir: string, prefix: string, depth: number): void {
      if (entryCount >= MAX_ENTRIES || depth > maxDepth) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        lines.push(`${prefix}[unreadable]`)
        return
      }
      const visible = entries.filter((e) => {
        if (IGNORED_DIRS.has(e.name)) return false
        if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.savecli') return false
        return true
      })
      // dirs first, then files, both alphabetical — stable and compact
      visible.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (let i = 0; i < visible.length; i++) {
        if (entryCount >= MAX_ENTRIES) {
          lines.push(`${prefix}… [entry cap reached]`)
          return
        }
        const entry = visible[i]!
        const isLast = i === visible.length - 1
        const branch = isLast ? '└─ ' : '├─ '
        const childPrefix = prefix + (isLast ? '   ' : '│  ')
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          entryCount++
          let sub = 0
          try {
            sub = readdirSync(abs).length
          } catch {
            /* ignore */
          }
          lines.push(`${prefix}${branch}${entry.name}/ (${sub} entries)`)
          walk(abs, childPrefix, depth + 1)
        } else {
          entryCount++
          let size = ''
          try {
            size = humanSize(statSync(abs).size)
          } catch {
            /* ignore */
          }
          lines.push(`${prefix}${branch}${entry.name} ${size}`)
        }
      }
    }

    try {
      const stat = statSync(root)
      if (!stat.isDirectory()) return err(`tree: ${searchPath} is not a directory`)
    } catch {
      return err(`tree: cannot access ${searchPath}`)
    }
    lines.push(`${searchPath}/`)
    walk(root, '', 1)
    return ok(lines.join('\n'))
  },
}
