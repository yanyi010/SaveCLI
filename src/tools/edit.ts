import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { checkWritePath } from '../security.js'
import { err, ok, type Tool, type ToolOutput } from './types.js'

export const editTool: Tool = {
  name: 'edit',
  description:
    'Edit a file by exact string replacement. You MUST read the file first in this session. ' +
    'oldString must match the file content exactly (including whitespace/indentation) and occur ' +
    'exactly once, unless replaceAll=true. Keep oldString anchored with surrounding lines to be unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      oldString: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
      newString: { type: 'string', description: 'Replacement text' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const rawPath = String(args['path'] ?? '')
    const oldString = String(args['oldString'] ?? '')
    const newString = String(args['newString'] ?? '')
    const replaceAll = args['replaceAll'] === true
    if (rawPath === '') return err('edit: path is required')
    if (oldString === '') return err('edit: oldString is required')

    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath)

    const writeVerdict = checkWritePath(abs, ctx.cwd, ctx.security, { yolo: ctx.yolo })
    if (writeVerdict === 'deny') {
      return err(`edit: ${rawPath} is protected (credentials, .git, or SaveCLI state) — refusing.`)
    }
    if (writeVerdict === 'ask') {
      if (ctx.nonInteractive) {
        return err(`edit: ${rawPath} is project instructions/memory — needs interactive approval (or --yolo).`)
      }
      const allowed = await ctx.confirm(`Modify project instructions file?\n  ${abs}`)
      if (!allowed) return ok('User declined. Ask for guidance instead of retrying.')
    }
    if (!ctx.readFiles.has(abs)) {
      return err(
        `edit: you must read ${rawPath} with the read tool before editing it (read the exact lines you will change).`,
      )
    }

    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch (e) {
      return err(`edit: cannot read ${rawPath}: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (!content.includes(oldString)) {
      return err(
        `edit: oldString not found in ${rawPath}. The file may have changed — read it again and copy the text exactly (mind whitespace).`,
      )
    }

    const count = countOccurrences(content, oldString)
    if (count > 1 && !replaceAll) {
      return err(
        `edit: oldString occurs ${count} times in ${rawPath}. Add surrounding lines to make it unique, or pass replaceAll=true to replace all ${count} occurrences.`,
      )
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    try {
      // Snapshot the previous state BEFORE mutating — enables /undo.
      ctx.snapshotBefore?.(abs)
      const tmp = `${abs}.tmp-savecli-${process.pid}`
      let mode = 0o644
      try {
        const prevMode = statSync(abs).mode & 0o777
        if ((prevMode & 0o111) !== 0) mode = prevMode
      } catch {
        /* new file */
      }
      writeFileSync(tmp, updated, { mode })
      renameSync(tmp, abs)
      ctx.recordEdit?.(abs)
      const replaced = replaceAll ? count : 1
      return ok(`edited ${rawPath}: replaced ${replaced} occurrence${replaced > 1 ? 's' : ''}`)
    } catch (e) {
      return err(`edit: failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}
