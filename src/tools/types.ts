import type { Config, PermissionsConfig } from '../config.js'
import type { SecurityConfig } from '../security.js'
import type { UBlock } from '../providers/types.js'

export interface ToolOutput {
  content: string
  isError?: boolean
  /** Extra blocks (e.g. todo updates) to surface in the UI. */
  meta?: Record<string, unknown>
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export interface ToolContext {
  cwd: string
  config: Config
  permissions: PermissionsConfig
  security: SecurityConfig
  /** --yolo: skip confirmations (still enforced: deny lists + protected paths). */
  yolo: boolean
  /** Non-interactive mode: confirm() auto-declines unless yolo. */
  nonInteractive: boolean
  /** Ask the user a yes/no question. */
  confirm: (question: string) => Promise<boolean>
  /** Ask with a "remember this pattern" option — returns the decision. */
  confirmWithRemember?: (question: string, pattern: string) => Promise<'yes' | 'always' | 'no'>
  /** Persist a bash allow pattern (from "always" decisions). */
  allowPattern?: (pattern: string) => void
  /** Session-scoped bash allow patterns. */
  sessionAllowPatterns: Set<string>
  /** Files read this session — edit tool requires read-before-edit. */
  readFiles: Set<string>
  /** Record an edit for undo/snapshot. */
  recordEdit?: (path: string) => void
  /** Capture file content before modification (undo support). */
  snapshotBefore?: (path: string) => void
  /** Todo list updates from the todowrite tool. */
  onTodos?: (todos: TodoItem[]) => void
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema for the parameters object. */
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

export function err(content: string): ToolOutput {
  return { content, isError: true }
}

export function ok(content: string): ToolOutput {
  return { content }
}

export type { UBlock }
