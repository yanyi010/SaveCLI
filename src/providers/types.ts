/** Unified internal message model — converted per provider on the wire. */

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  /** JSON-encoded arguments from the model. */
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError?: boolean
}

export type UBlock = TextBlock | ToolCallBlock | ToolResultBlock

export interface UMessage {
  role: 'user' | 'assistant'
  blocks: UBlock[]
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema object for the parameters. */
  parameters: Record<string, unknown>
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal'

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ChatRequest {
  system: string
  messages: UMessage[]
  tools: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Streaming callbacks — invoked as tokens arrive. */
  onText?: (delta: string) => void
  onToolCallStart?: (name: string) => void
}

export interface ChatResult {
  /** Assistant output: text and/or tool_call blocks. */
  blocks: UBlock[]
  stopReason: StopReason
  usage: Usage
  model: string
}

export interface LLMProvider {
  readonly id: string
  readonly model: string
  complete(req: ChatRequest): Promise<ChatResult>
}

export { ProviderError } from './http.js'
