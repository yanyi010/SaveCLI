import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { checkWritePath } from '../security.js'
import { err, ok, type Tool, type ToolContext, type ToolOutput } from './types.js'

function targetOutsideCwd(abs: string, ctx: ToolContext): boolean {
  const rel = relative(ctx.cwd, abs)
  return rel.startsWith('..') || isAbsolute(rel)
}

function guardWrite(abs: string, rawPath: string, ctx: ToolContext): ToolOutput | 'ask' | undefined {
  const verdict = checkWritePath(abs, ctx.cwd, ctx.security, { yolo: ctx.yolo })
  if (verdict === 'deny') {
    return err(
      `write: ${rawPath} is protected (credentials, .git, or SaveCLI state) — refusing to write.`,
    )
  }
  if (verdict === 'ask') {
    return 'ask'
  }
  const outside = targetOutsideCwd(abs, ctx)
  if (outside && ctx.permissions.editOutsideCwd === 'deny') {
    return err(`write: ${rawPath} is outside the working directory and edits there are denied (permissions.editOutsideCwd=deny).`)
  }
  return undefined
}

async function confirmWriteGate(abs: string, rawPath: string, ctx: ToolContext, gate: ToolOutput | 'ask' | undefined): Promise<ToolOutput | undefined> {
  if (gate === 'ask') {
    if (ctx.nonInteractive) {
      return err(`write: ${rawPath} is project instructions/memory — needs interactive approval (or --yolo).`)
    }
    const allowed = await ctx.confirm(`Modify project instructions file?\n  ${abs}`)
    if (!allowed) return ok('User declined. Ask for guidance instead of retrying.')
  }
  if (gate !== undefined && gate !== 'ask') return gate
  if (!targetOutsideCwd(abs, ctx)) return undefined
  if (ctx.permissions.editOutsideCwd === 'allow' || ctx.yolo) return undefined
  if (ctx.nonInteractive) {
    return err(`write: ${rawPath} is outside the working directory — needs approval (use --yolo or permissions.editOutsideCwd=allow).`)
  }
  const allowed = await ctx.confirm(`Edit file outside the working directory?\n  ${abs}`)
  if (!allowed) return ok('User declined. Ask for guidance instead of retrying.')
  return undefined
}

export const writeTool: Tool = {
  name: 'write',
  description:
    'Create or overwrite a file with the given content. Parent directories are created. ' +
    'Prefer edit for small changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative or absolute)' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const rawPath = String(args['path'] ?? '')
    const content = String(args['content'] ?? '')
    if (rawPath === '') return err('write: path is required')
    const abs = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath)

    const gate = guardWrite(abs, rawPath, ctx)
    const declined = await confirmWriteGate(abs, rawPath, ctx, gate)
    if (declined) return declined

    try {
      // Snapshot the previous state BEFORE mutating — enables /undo.
      ctx.snapshotBefore?.(abs)
      mkdirSync(dirname(abs), { recursive: true })
      // Preserve the executable bit when overwriting an existing executable file.
      let mode = 0o644
      try {
        const prevMode = statSync(abs).mode & 0o777
        if ((prevMode & 0o111) !== 0) mode = prevMode
      } catch {
        /* new file */
      }
      const tmp = `${abs}.tmp-savecli-${process.pid}`
      writeFileSync(tmp, content, { mode })
      renameSync(tmp, abs)
      ctx.recordEdit?.(abs)
      const lines = content === '' ? 0 : content.split('\n').length
      return ok(`wrote ${lines} lines to ${rawPath}`)
    } catch (e) {
      return err(`write: failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
