import type { Tool } from './types.js'
import { bashTool } from './bash.js'
import { editTool } from './edit.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { readTool } from './read.js'
import { todoWriteTool } from './todowrite.js'
import { treeTool } from './tree.js'
import { writeTool } from './write.js'

/** The default tool set. Order matters — most-used first for prompt stability. */
export const DEFAULT_TOOLS: Tool[] = [
  readTool,
  editTool,
  writeTool,
  bashTool,
  grepTool,
  globTool,
  treeTool,
  todoWriteTool,
]

export function toolSpecs(tools: Tool[]): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

export type { Tool } from './types.js'
export { bashTool } from './bash.js'
export { editTool } from './edit.js'
export { globTool } from './glob.js'
export { grepTool } from './grep.js'
export { readTool } from './read.js'
export { todoWriteTool } from './todowrite.js'
export { treeTool } from './tree.js'
export { writeTool } from './write.js'
