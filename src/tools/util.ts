/** Shared helpers for tools: output truncation and path safety. */

export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.savecli',
  'coverage',
  '.next',
  'target',
  '.idea',
  '.vscode',
])

/**
 * Truncate long tool output with a head+tail strategy: errors usually live at
 * the end of logs, so we keep more of the head but always some of the tail.
 */
export function truncateOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false }
  const head = Math.floor(limit * 0.6)
  const tail = Math.floor(limit * 0.35)
  const omitted = text.length - head - tail
  return {
    text: `${text.slice(0, head)}\n… [${omitted} bytes truncated by SaveCLI] …\n${text.slice(-tail)}`,
    truncated: true,
  }
}

export function isBinaryContent(buf: Buffer): boolean {
  const probe = buf.subarray(0, 1024)
  return probe.includes(0)
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`
}
