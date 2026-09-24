import { err, ok, type TodoItem, type Tool, type ToolOutput } from './types.js'

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const VALID_PRIORITY = new Set(['high', 'medium', 'low'])

export const todoWriteTool: Tool = {
  name: 'todowrite',
  description:
    'Update the task list for multi-step work. Submit the full list each time. ' +
    'Exactly one task should be in_progress while working. Mark finished tasks completed.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const raw = args['todos']
    if (!Array.isArray(raw)) return err('todowrite: todos must be an array')
    const todos: TodoItem[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') return err('todowrite: each todo must be an object')
      const content = String((item as Record<string, unknown>)['content'] ?? '')
      const status = String((item as Record<string, unknown>)['status'] ?? '')
      const priority = String((item as Record<string, unknown>)['priority'] ?? 'medium')
      if (content === '') return err('todowrite: content is required')
      if (!VALID_STATUS.has(status)) return err(`todowrite: invalid status "${status}"`)
      if (!VALID_PRIORITY.has(priority)) return err(`todowrite: invalid priority "${priority}"`)
      todos.push({ content, status: status as TodoItem['status'], priority: priority as TodoItem['priority'] })
    }
    ctx.onTodos?.(todos)
    const counts = todos.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )
    return ok(
      `task list updated: ${todos.length} items (${counts['completed'] ?? 0} completed, ${counts['in_progress'] ?? 0} in progress, ${counts['pending'] ?? 0} pending)`,
    )
  },
}
