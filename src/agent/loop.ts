/**
 * The agent loop: sends conversation turns to the LLM, executes tool calls
 * with permission gates, records usage, applies the response cache and
 * auto-compaction. The Agent class is UI-agnostic — the REPL and one-shot
 * mode both drive it through the same callbacks.
 */
import { VERSION } from '../constants.js'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Config, type ResolvedProfile } from '../config.js'
import { createProvider, createSmallProvider, type ProviderHandle } from '../providers/index.js'
import { ProviderError, type ChatResult, type ToolSpec, type UBlock, type UMessage, type Usage } from '../providers/types.js'
import { DEFAULT_TOOLS, toolSpecs } from '../tools/index.js'
import type { Tool, ToolContext, TodoItem } from '../tools/types.js'
import { computeCacheKey, cacheGet, cachePut } from './cache.js'
import { compactMessages, estimateContextTokens } from './compaction.js'
import { buildSystemPrompt, detectGitBranch } from './prompts.js'
import { Session } from './session.js'
import { estimateCostUsd, recordUsage } from './usage.js'
import { log } from '../util/log.js'

const MAX_TOOL_TURNS = 40

interface FileSnapshot {
  turn: number
  path: string
  /** File content before the edit; null = file did not exist. */
  before: string | null
}

export interface AgentCallbacks {
  /** Streaming text from the assistant. */
  onText?: (delta: string) => void
  /** A tool call is starting. */
  onToolStart?: (name: string, argsSummary: string) => void
  /** A tool call finished. */
  onToolEnd?: (name: string, summary: string, isError: boolean, durationMs: number) => void
  /** Per-request usage report. */
  onUsage?: (usage: Usage, meta: { fromCache: boolean; model: string; purpose: 'chat' | 'compaction' }) => void
  /** Informational notices (compaction happened, etc). */
  onNotice?: (message: string) => void
  /** Confirmation gate (REPL answers interactively). */
  confirm?: (question: string) => Promise<boolean>
  /** Confirmation with "remember pattern" support. */
  confirmWithRemember?: (question: string, pattern: string) => Promise<'yes' | 'always' | 'no'>
  /** Todo list updates. */
  onTodos?: (todos: TodoItem[]) => void
  /**
   * Steering (Pi-style): called between model iterations; returns user
   * messages typed while the agent was working. They get injected before
   * the next model request.
   */
  drainQueue?: () => string[]
}

export interface TurnResult {
  ok: boolean
  text: string
  usage: Usage
  toolCalls: Array<{ name: string; argsSummary: string; isError: boolean; durationMs: number }>
  turns: number
  error?: string
}

export class Agent {
  readonly cwd: string
  config: Config
  profile: ResolvedProfile
  private handle: ProviderHandle
  private systemPrompt: string
  private tools: Tool[]
  private toolSpecList: ToolSpec[]
  readonly session: Session
  messages: UMessage[] = []
  todos: TodoItem[] = []
  editedFiles: string[] = []
  private snapshots: FileSnapshot[] = []
  private currentTurn = 0
  private readFiles = new Set<string>()
  private gitBranch?: string
  private usageAcc: Usage = { input: 0, output: 0 }
  private cacheDisabled: boolean

  private smallProviderFactory?: (profile: ResolvedProfile) => ProviderHandle

  constructor(opts: {
    cwd: string
    config: Config
    profile: ResolvedProfile
    yolo?: boolean
    nonInteractive?: boolean
    session?: Session
    resumeMessages?: UMessage[]
    cacheDisabled?: boolean
    /** Custom tool set (e.g. read-only for Reviewer agents). */
    tools?: Tool[]
    /** Override the system prompt (role prompts for mission mode). */
    systemPrompt?: string
    /** Test seam: inject a provider instead of creating one from the profile. */
    providerFactory?: (profile: ResolvedProfile) => ProviderHandle
    /** Test seam: inject the small (compaction) provider. */
    smallProviderFactory?: (profile: ResolvedProfile) => ProviderHandle
  }) {
    this.cwd = opts.cwd
    this.config = opts.config
    this.profile = opts.profile
    this.cacheDisabled = opts.cacheDisabled ?? !opts.config.tokenSaving.responseCache
    this.handle = opts.providerFactory
      ? opts.providerFactory(opts.profile)
      : createProvider(this.profile, { promptCaching: opts.config.tokenSaving.promptCaching })
    this.smallProviderFactory = opts.smallProviderFactory
    this.gitBranch = detectGitBranch(opts.cwd)
    this.systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.cwd, this.gitBranch)
    this.tools = opts.tools ?? DEFAULT_TOOLS
    this.toolSpecList = toolSpecs(this.tools)
    this.session = opts.session ?? new Session()
    if (opts.resumeMessages) this.messages = opts.resumeMessages
    this.yolo = opts.yolo ?? false
    this.nonInteractive = opts.nonInteractive ?? false
    this.session.append({
      type: 'meta',
      ts: Date.now(),
      cwd: opts.cwd,
      profile: opts.profile.profileName,
      model: opts.profile.model,
      savecliVersion: VERSION,
    })
  }

  yolo: boolean
  nonInteractive: boolean

  get providerLabel(): string {
    return `${this.profile.profileName}/${this.profile.model}`
  }

  get keyMissing(): boolean {
    return !this.handle.hasKey && this.profile.provider === 'anthropic'
  }

  get usage(): Usage {
    return { ...this.usageAcc }
  }

  /** Switch model/profile mid-session (REPL /model). */
  switchProfile(profile: ResolvedProfile): void {
    this.profile = profile
    this.handle = createProvider(profile, { promptCaching: this.config.tokenSaving.promptCaching })
    this.session.append({ type: 'meta', ts: Date.now(), cwd: this.cwd, profile: profile.profileName, model: profile.model, savecliVersion: VERSION })
  }

  private toolContext(callbacks: AgentCallbacks): ToolContext {
    return {
      cwd: this.cwd,
      config: this.config,
      permissions: this.config.permissions,
      security: this.config.security,
      yolo: this.yolo,
      nonInteractive: this.nonInteractive,
      confirm:
        callbacks.confirm ??
        (async () => {
          /* no UI attached: decline */
          return false
        }),
      confirmWithRemember: callbacks.confirmWithRemember,
      allowPattern: (pattern) => this.addSessionAllowPattern(pattern),
      sessionAllowPatterns: this.sessionAllowPatterns,
      readFiles: this.readFiles,
      recordEdit: (path) => {
        this.editedFiles.push(path)
      },
      snapshotBefore: (path) => this.snapshotBefore(path),
      onTodos: (todos) => {
        this.todos = todos
        callbacks.onTodos?.(todos)
      },
    }
  }

  private sessionAllowPatterns = new Set<string>()

  /** Remember an approved bash pattern for this session (Codex-style amendment). */
  addSessionAllowPattern(pattern: string): void {
    this.sessionAllowPatterns.add(pattern)
  }

  /** Fork: a new session carrying the current conversation (Pi-style branching). */
  fork(): Agent {
    const forked = new Agent({
      cwd: this.cwd,
      config: this.config,
      profile: this.profile,
      yolo: this.yolo,
      nonInteractive: this.nonInteractive,
      cacheDisabled: this.cacheDisabled,
      resumeMessages: this.messages.map((m) => ({ role: m.role, blocks: [...m.blocks] })),
    })
    forked.todos = this.todos.map((t) => ({ ...t }))
    forked.readFiles = new Set(this.readFiles)
    return forked
  }

  /** Capture file content before a modifying tool runs — enables /undo. */
  private snapshotBefore(path: string): void {
    if (this.snapshots.some((s) => s.path === path && s.turn === this.currentTurn)) return
    let before: string | null = null
    try {
      before = readFileSync(path, 'utf8')
    } catch {
      before = null // new file
    }
    this.snapshots.push({ turn: this.currentTurn, path, before })
  }

  /** Undo every edit from the most recent turn that has snapshots. */
  undoLastTurn(): string[] {
    if (this.snapshots.length === 0) return []
    const lastTurn = Math.max(...this.snapshots.map((s) => s.turn))
    const batch = this.snapshots.filter((s) => s.turn === lastTurn)
    const undone: string[] = []
    for (const snap of [...batch].reverse()) {
      try {
        if (snap.before === null) rmSync(snap.path, { force: true })
        else writeFileSync(snap.path, snap.before)
        undone.push(snap.path)
      } catch (err) {
        log.warn('agent', `undo failed for ${snap.path}: ${err instanceof Error ? err.message : err}`)
      }
    }
    this.snapshots = this.snapshots.filter((s) => s.turn !== lastTurn)
    // Post-undo state diverges from the conversation history — drop it.
    this.messages = []
    return undone
  }

  /** Send a user turn; runs tool loops until the assistant finishes. */
  async send(userText: string, callbacks: AgentCallbacks = {}, signal?: AbortSignal): Promise<TurnResult> {
    const startUsage = { ...this.usageAcc }
    const toolCalls: TurnResult['toolCalls'] = []
    this.currentTurn++

    if (userText.trim() !== '') {
      this.messages.push({ role: 'user', blocks: [{ type: 'text', text: userText }] })
      this.session.append({ type: 'user', ts: Date.now(), text: userText })
    }

    try {
      await this.maybeAutoCompact(callbacks, signal)
    } catch (err) {
      log.warn('agent', `auto-compact failed: ${err instanceof Error ? err.message : err}`)
    }

    let finalText = ''
    let turns = 0
    try {
      for (let i = 0; i < MAX_TOOL_TURNS; i++) {
        turns++
        // Steering: inject user messages typed while the agent was working.
        const queued = callbacks.drainQueue?.() ?? []
        if (queued.length > 0) {
          const text = queued.join('\n\n')
          this.messages.push({ role: 'user', blocks: [{ type: 'text', text }] })
          this.session.append({ type: 'user', ts: Date.now(), text })
        }
        const result = await this.requestChat(callbacks, signal)
        finalText =
          result.blocks
            .filter((b): b is Extract<UBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim() || finalText

        this.messages.push({ role: 'assistant', blocks: result.blocks })
        this.session.append({ type: 'assistant', ts: Date.now(), blocks: result.blocks })

        const calls = result.blocks.filter((b): b is Extract<UBlock, { type: 'tool_call' }> => b.type === 'tool_call')
        if (result.stopReason !== 'tool_use' || calls.length === 0) break

        const results: UBlock[] = []
        for (const call of calls) {
          const started = Date.now()
          const args = parseToolArgs(call.arguments)
          const argsSummary = summarizeArgs(call.name, args)
          callbacks.onToolStart?.(call.name, argsSummary)
          const output = await this.executeTool(call, args, callbacks)
          const durationMs = Date.now() - started
          const isError = output.isError === true
          callbacks.onToolEnd?.(call.name, firstLine(output.content), isError, durationMs)
          toolCalls.push({ name: call.name, argsSummary, isError, durationMs })
          this.session.append({
            type: 'tool_result',
            ts: Date.now(),
            toolCallId: call.id,
            content: output.content,
            isError,
          })
          results.push({ type: 'tool_result', toolCallId: call.id, content: output.content, isError })
        }
        this.messages.push({ role: 'user', blocks: results })
      }

      if (turns >= MAX_TOOL_TURNS) {
        callbacks.onNotice?.(`Reached the ${MAX_TOOL_TURNS}-iteration safety limit for one turn; stopping.`)
      }

      return {
        ok: true,
        text: finalText,
        usage: deltaUsage(startUsage, this.usageAcc),
        toolCalls,
        turns,
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return {
          ok: false,
          text: finalText,
          usage: deltaUsage(startUsage, this.usageAcc),
          toolCalls,
          turns,
          error: 'aborted',
        }
      }
      const message = err instanceof ProviderError ? formatProviderError(err) : err instanceof Error ? err.message : String(err)
      log.debug('agent', `turn failed: ${message}`)
      return {
        ok: false,
        text: finalText,
        usage: deltaUsage(startUsage, this.usageAcc),
        toolCalls,
        turns,
        error: message,
      }
    }
  }

  private async requestChat(callbacks: AgentCallbacks, signal?: AbortSignal): Promise<ChatResult> {
    const temperature = this.profile.temperature
    const key = computeCacheKey(this.handle.provider.id, this.profile.model, this.systemPrompt, this.messages, this.toolSpecList, temperature)

    if (!this.cacheDisabled) {
      const hit = cacheGet(key)
      if (hit && hit.result) {
        const text = hit.result.blocks
          .filter((b): b is Extract<UBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('')
        if (text !== '') callbacks.onText?.(text)
        recordUsage({
          ts: Date.now(),
          profile: this.profile.profileName,
          provider: this.handle.provider.id,
          model: this.profile.model,
          input: 0,
          output: 0,
          fromCache: true,
          purpose: 'chat',
        })
        callbacks.onUsage?.(hit.result.usage, { fromCache: true, model: this.profile.model, purpose: 'chat' })
        return hit.result
      }
    }

    const result = await this.handle.provider.complete({
      system: this.systemPrompt,
      messages: this.messages,
      tools: this.toolSpecList,
      temperature,
      signal,
      onText: callbacks.onText,
      onToolCallStart: (name) => callbacks.onToolStart?.(name, ''),
    })

    this.addUsage(result.usage)
    recordUsage({
      ts: Date.now(),
      profile: this.profile.profileName,
      provider: this.handle.provider.id,
      model: this.profile.model,
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      purpose: 'chat',
      costUsd: estimateCostUsd(this.profile.model, result.usage),
    })
    callbacks.onUsage?.(result.usage, { fromCache: false, model: this.profile.model, purpose: 'chat' })

    if (!this.cacheDisabled) {
      cachePut({
        key,
        model: this.profile.model,
        provider: this.handle.provider.id,
        result,
      })
    }
    return result
  }

  private async executeTool(
    call: Extract<UBlock, { type: 'tool_call' }>,
    args: Record<string, unknown>,
    callbacks: AgentCallbacks,
  ): Promise<{ content: string; isError?: boolean }> {
    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) {
      return { content: `unknown tool "${call.name}" — available: ${this.tools.map((t) => t.name).join(', ')}`, isError: true }
    }
    try {
      const output = await tool.execute(args, this.toolContext(callbacks))
      this.session.append({
        type: 'tool',
        ts: Date.now(),
        name: call.name,
        argsSummary: summarizeArgs(call.name, args),
        isError: output.isError,
      })
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('agent', `tool ${call.name} threw: ${message}`)
      return { content: `tool ${call.name} crashed: ${message}`, isError: true }
    }
  }

  /** Manual /compact — optionally with a focus instruction (Claude Code-style). */
  async compact(callbacks: AgentCallbacks = {}, signal?: AbortSignal, focus?: string): Promise<boolean> {
    return this.runCompaction(callbacks, signal, true, focus)
  }

  private async maybeAutoCompact(callbacks: AgentCallbacks, signal?: AbortSignal): Promise<void> {
    if (!this.config.tokenSaving.autoCompact) return
    const estimate = estimateContextTokens(this.systemPrompt, this.messages, this.toolSpecList)
    if (estimate > this.config.tokenSaving.compactThresholdTokens) {
      await this.runCompaction(callbacks, signal, false, undefined)
    }
  }

  private async runCompaction(
    callbacks: AgentCallbacks,
    signal: AbortSignal | undefined,
    manual: boolean,
    focus?: string,
  ): Promise<boolean> {
    const tokensBefore = estimateContextTokens(this.systemPrompt, this.messages, this.toolSpecList)
    const small = this.smallProviderFactory
      ? this.smallProviderFactory(this.profile)
      : createSmallProvider(this.profile, { promptCaching: false })
    const { messages, summary, result } = await compactMessages(small.provider, this.messages, {
      keepRecentTurns: this.config.tokenSaving.keepRecentTurns,
      signal,
      focus,
    })
    if (summary === null) return false
    this.messages = messages
    this.session.append({ type: 'summary', ts: Date.now(), text: summary })
    if (result) {
      this.addUsage(result.usage)
      recordUsage({
        ts: Date.now(),
        profile: this.profile.profileName,
        provider: small.provider.id,
        model: result.model,
        input: result.usage.input,
        output: result.usage.output,
        purpose: 'compaction',
        costUsd: estimateCostUsd(result.model, result.usage),
      })
      callbacks.onUsage?.(result.usage, { fromCache: false, model: result.model, purpose: 'compaction' })
    }
    const tokensAfter = estimateContextTokens(this.systemPrompt, this.messages, this.toolSpecList)
    callbacks.onNotice?.(
      `${manual ? 'Compacted' : 'Auto-compacted'} context: ~${tokensBefore} → ~${tokensAfter} tokens (summary + ${Math.min(this.messages.length - 1, this.config.tokenSaving.keepRecentTurns)} recent turns kept)`,
    )
    return true
  }

  private addUsage(u: Usage): void {
    this.usageAcc = {
      input: this.usageAcc.input + u.input,
      output: this.usageAcc.output + u.output,
      cacheRead: (this.usageAcc.cacheRead ?? 0) + (u.cacheRead ?? 0),
      cacheWrite: (this.usageAcc.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
    }
  }
}

function deltaUsage(before: Usage, after: Usage): Usage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, (after.cacheRead ?? 0) - (before.cacheRead ?? 0)),
    cacheWrite: Math.max(0, (after.cacheWrite ?? 0) - (before.cacheWrite ?? 0)),
  }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { _raw: raw }
  } catch {
    // Salvage balanced JSON object if the model wrapped it in prose.
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        /* fall through */
      }
    }
    return { _error: 'arguments were not valid JSON', _raw: raw.slice(0, 500) }
  }
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return String(args['command'] ?? '').slice(0, 120)
    case 'read':
    case 'write':
    case 'edit':
      return String(args['path'] ?? '')
    case 'grep':
      return `/${String(args['pattern'] ?? '')}/`
    case 'glob':
      return String(args['pattern'] ?? '')
    case 'tree':
      return String(args['path'] ?? '.')
    default: {
      const s = JSON.stringify(args)
      return s ? s.slice(0, 120) : ''
    }
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function formatProviderError(err: ProviderError): string {
  const hint = err.hint ? `\nHint: ${err.hint}` : ''
  return `${err.message}${hint}`
}
