import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PATHS } from '../constants.js'
import { truncateOutput } from '../tools/util.js'

/** Max bytes of project memory injected into the system prompt. */
const MEMORY_LIMIT = 8_192

/**
 * Build the system prompt. Sent on every request — kept deliberately lean;
 * every token here is a recurring cost, so guidance is dense, not chatty.
 */
export function buildSystemPrompt(cwd: string, gitBranch?: string): string {
  const lines: string[] = []
  lines.push(
    'You are SaveCLI, an expert coding agent operating in a real repository via tools. Be effective, precise, and token-efficient.',
  )
  lines.push('')
  lines.push('# Environment')
  lines.push(`- Working directory: ${cwd}`)
  lines.push(`- Platform: ${process.platform} (${process.arch})`)
  lines.push(`- Date: ${new Date().toISOString().slice(0, 10)}`)
  if (gitBranch) lines.push(`- Git branch: ${gitBranch}`)
  lines.push('')
  lines.push('# Core rules')
  lines.push('1. Read before edit: read the exact lines you will change; never guess file contents.')
  lines.push('2. Keep edits minimal and surgical; follow the file\'s existing style and conventions.')
  lines.push('3. Explore cheaply: tree/glob/grep to locate code before reading whole files.')
  lines.push('4. Multi-step work (3+ steps): maintain todos with todowrite; one task in_progress at a time.')
  lines.push('5. After changes, verify: run the repo\'s tests/lint/typecheck if configured.')
  lines.push('6. Ambiguous or destructive actions (force-push, mass deletes): ask first.')
  lines.push('7. Never echo secrets (API keys, tokens, credentials).')
  lines.push('8. Be terse in prose: no preamble, no restating file contents, no postambles.')
  lines.push('9. Reference code as path:line so the user can jump to it.')
  const memory = loadProjectMemory(cwd)
  if (memory !== '') {
    lines.push('')
    lines.push('# Project instructions')
    lines.push(memory)
  }
  return lines.join('\n')
}

/**
 * Project memory, in priority order (first match wins per scope):
 *   project: .savecli/AGENTS.md | AGENTS.md | CLAUDE.md
 *   global:  ~/.savecli/AGENTS.md
 */
export function loadProjectMemory(cwd: string): string {
  const projectCandidates = [
    join(cwd, '.savecli', 'AGENTS.md'),
    join(cwd, 'AGENTS.md'),
    join(cwd, 'CLAUDE.md'),
  ]
  const parts: string[] = []
  for (const p of projectCandidates) {
    if (existsSync(p)) {
      parts.push(readCapped(p))
      break
    }
  }
  const global = join(homedir(), '.savecli', 'AGENTS.md')
  if (existsSync(global) && PATHS.config.startsWith(homedir())) {
    const g = readCapped(global)
    if (g !== '') parts.push(g)
  }
  return parts.join('\n\n').trim()
}

function readCapped(path: string): string {
  try {
    const content = readFileSync(path, 'utf8').trim()
    if (content === '') return ''
    const { text, truncated } = truncateOutput(content, MEMORY_LIMIT)
    return truncated ? `${text}\n[memory truncated at ${MEMORY_LIMIT} bytes]` : text
  } catch {
    return ''
  }
}

/** Detect the current git branch (cached by caller; cheap enough per session). */
export function detectGitBranch(cwd: string): string | undefined {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = head.match(/ref: refs\/heads\/(.+)/)
    if (m?.[1]) return m[1]
    return head.slice(0, 12) // detached HEAD
  } catch {
    // .git may be a file (worktree) or missing — fall back to git command
    try {
      return (
        execSync('git rev-parse --abbrev-ref HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined
      )
    } catch {
      return undefined
    }
  }
}
