import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { globToRegex } from '../util/glob.js'
import { err, ok, type Tool, type ToolOutput } from './types.js'
import { IGNORED_DIRS } from './util.js'

const MAX_RESULTS = 500

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "*.{json,md}"). Returns paths relative to the ' +
    'project root, most recently modified first. Skips .git/node_modules/dist.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search from (default: cwd)' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const pattern = String(args['pattern'] ?? '')
    if (pattern === '') return err('glob: pattern is required')
    const searchPath = String(args['path'] ?? ctx.cwd)
    const root = isAbsolute(searchPath) ? searchPath : resolve(ctx.cwd, searchPath)
    const re = globToRegex(pattern)

    const results: Array<{ path: string; mtime: number }> = []

    function walk(dir: string, depth: number): void {
      if (results.length >= MAX_RESULTS || depth > 16) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return
        if (IGNORED_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.github' && entry.name !== '.savecli') continue
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(abs, depth + 1)
        } else if (entry.isFile()) {
          const rel = relative(ctx.cwd, abs)
          if (re.test(rel) || re.test(abs)) {
            try {
              results.push({ path: rel, mtime: statSync(abs).mtimeMs })
            } catch {
              results.push({ path: rel, mtime: 0 })
            }
          }
        }
      }
    }

    try {
      const stat = statSync(root)
      if (!stat.isDirectory()) return err(`glob: ${searchPath} is not a directory`)
      walk(root, 0)
    } catch {
      return err(`glob: cannot access ${searchPath}`)
    }

    if (results.length === 0) return ok(`no files match ${pattern}`)
    results.sort((a, b) => b.mtime - a.mtime)
    const shown = results.slice(0, MAX_RESULTS).map((r) => r.path)
    return ok(shown.join('\n') + `\n[${shown.length} file${shown.length > 1 ? 's' : ''}]`)
  },
}
