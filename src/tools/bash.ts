import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { sanitizeForContext } from '../security.js'
import { redact } from '../util/redact.js'
import { err, ok, type Tool, type ToolContext, type ToolOutput } from './types.js'
import { truncateOutput } from './util.js'

/**
 * Loose matcher for bash command patterns: `*` matches ANY characters
 * including slashes (unlike file globs), because commands contain paths.
 */
function commandMatch(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(command)
}

function commandMatchList(patterns: readonly string[], command: string): string | undefined {
  for (const p of patterns) {
    if (commandMatch(p, command)) return p
  }
  return undefined
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a bash command and return its output. Working directory is the project root. ' +
    'stdout is returned; stderr is included only when non-empty. Default timeout 120s. ' +
    'Prefer non-interactive commands. Avoid paging (less/more) and editors.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (max 600)' },
    },
    required: ['command'],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const command = String(args['command'] ?? '')
    if (command.trim() === '') return err('bash: command is required')
    const timeoutSec = Number(args['timeout'] ?? DEFAULT_TIMEOUT_MS / 1000)
    const timeoutMs = Math.min(
      Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    const verdict = assessCommand(command, ctx)
    if (verdict === 'deny') {
      return err(`bash: command denied by security policy:\n  ${command}\nAdjust permissions.bashDeny or security.protectedPaths in config if this is a mistake.`)
    }
    if (verdict === 'ask') {
      if (ctx.nonInteractive && !ctx.yolo) {
        return err(
          `bash: command needs approval in non-interactive mode:\n  ${command}\n` +
            'Run with --yolo to allow, or add an allow pattern: savecli config set permissions.bashAllow "…"',
        )
      }
      if (!ctx.yolo) {
        const pattern = deriveAllowPattern(command)
        if (ctx.confirmWithRemember) {
          const decision = await ctx.confirmWithRemember(`Run command?`, pattern)
          if (decision === 'no') return ok('User declined to run the command. Ask what to do differently instead of retrying.')
          if (decision === 'always') ctx.allowPattern?.(pattern)
        } else {
          const allowed = await ctx.confirm(`Run command?\n  ${command}`)
          if (!allowed) return ok('User declined to run the command. Ask what to do differently instead of retrying.')
        }
      }
    }

    const result = await runBash(command, ctx.cwd, timeoutMs)
    let output = formatBashResult(command, result)
    output = sanitizeForContext(output, ctx.security).text
    const limit = ctx.config.tokenSaving.toolOutputLimit
    const { text } = truncateOutput(output, limit)
    return result.exitCode === 0 ? ok(text) : { content: text, isError: result.exitCode !== 0 }
  },
}

function assessCommand(command: string, ctx: ToolContext): 'allow' | 'deny' | 'ask' {
  const { permissions } = ctx
  if (commandMatchList(permissions.bashDeny, command)) return 'deny'
  if (mentionsProtectedPaths(command)) return 'deny'
  if (commandMatchList(permissions.bashAllow, command)) return 'allow'
  // Session-scoped approvals (from "always" decisions) — Codex-style amendment.
  for (const pattern of ctx.sessionAllowPatterns) {
    if (commandMatchList([pattern], command)) return 'allow'
  }
  if (!permissions.bashAsk || ctx.yolo) return 'allow'
  return 'ask'
}

/** Derive a conservative allow pattern from an approved command. */
export function deriveAllowPattern(command: string): string {
  const tokens = command.trim().split(/\s+/)
  const first = tokens[0] ?? ''
  const wrappers = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'python', 'python3', 'pip', 'docker', 'make', 'gradle', 'mvn', 'kubectl', 'terraform'])
  if (tokens.length >= 2 && wrappers.has(first)) {
    return `${first} ${tokens[1]!}*`
  }
  return `${first}*`
}

/** Deny commands that read SaveCLI/SSH/cloud credential material. */
function mentionsProtectedPaths(command: string): boolean {
  const home = homedir()
  const suspicious = [`${home}/.savecli`, '~/.savecli', `${home}/.ssh`, '~/.ssh', '.ssh/id_', `${home}/.aws`, '~/.aws', 'credentials.json']
  const lowered = command.toLowerCase()
  for (const s of suspicious) {
    if (lowered.includes(s.toLowerCase())) {
      // Writing a new key via `savecli auth` is fine; reading is not.
      if (s.includes('.savecli') && /auth|login/.test(command) && !/cat|less|more|head|tail|grep|sed|awk|dd|cp|mv|scp|rsync/.test(command)) {
        continue
      }
      return true
    }
  }
  return false
}

interface BashResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  signal?: string
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      detached: true, // own process group → clean kill of pipelines
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    // Hard caps to avoid unbounded memory on chatty commands.
    const MAX_CAPTURE = 2_000_000

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already dead */
        }
      }, 2_000)
    }, timeoutMs)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: `${stderr}\n${e.message}`, exitCode: 127, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, timedOut, signal: signal ?? undefined })
    })
  })
}

function formatBashResult(command: string, r: BashResult): string {
  const parts: string[] = []
  if (r.timedOut) {
    parts.push(`[timed out after configured timeout — partial output below]`)
  }
  const out = r.stdout
  if (out !== '') parts.push(out.endsWith('\n') ? out.slice(0, -1) : out)
  if (r.stderr !== '') {
    const se = r.stderr
    parts.push(`[stderr]\n${se.endsWith('\n') ? se.slice(0, -1) : se}`)
  }
  if (r.exitCode !== 0) parts.push(`[exit code: ${r.exitCode ?? 'none'}${r.signal ? ` signal: ${r.signal}` : ''}]`)
  if (parts.length === 0) return `[no output, exit code ${r.exitCode ?? 'none'}]`
  return redact(parts.join('\n'))
}
