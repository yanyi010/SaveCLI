/**
 * Provider factory: turns a resolved profile into a connected LLMProvider.
 */
import { resolveApiKey } from '../auth.js'
import { log } from '../util/log.js'
import type { ResolvedProfile } from '../config.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import type { LLMProvider } from './types.js'

export interface ProviderHandle {
  provider: LLMProvider
  /** Diagnostic label for where the key came from (never the key itself). */
  keySource: string
  hasKey: boolean
}

export function createProvider(profile: ResolvedProfile, opts: { promptCaching?: boolean } = {}): ProviderHandle {
  const resolution = resolveApiKey(profile)
  log.debug('provider', `key resolution for ${profile.profileName}: ${resolution.source} (${resolution.scheme})`)

  const extraHeaders = expandHeaders(profile.headers)

  if (profile.provider === 'anthropic') {
    return {
      provider: new AnthropicProvider({
        baseUrl: profile.baseUrl,
        apiKey: resolution.apiKey,
        authScheme: resolution.scheme,
        model: profile.model,
        maxTokens: profile.maxTokens,
        temperature: profile.temperature,
        promptCaching: opts.promptCaching ?? true,
        extraHeaders,
      }),
      keySource: resolution.source,
      hasKey: resolution.apiKey !== undefined,
    }
  }

  return {
    provider: new OpenAIProvider({
      baseUrl: profile.baseUrl,
      apiKey: resolution.apiKey,
      model: profile.model,
      maxTokens: profile.maxTokens,
      temperature: profile.temperature,
      extraHeaders,
    }),
    keySource: resolution.source,
    hasKey: resolution.apiKey !== undefined,
  }
}

/** Create a provider for the profile's cheap model (compaction, aux calls). */
export function createSmallProvider(profile: ResolvedProfile, opts: { promptCaching?: boolean } = {}): ProviderHandle {
  if (!profile.smallModel) return createProvider(profile, opts)
  return createProvider({ ...profile, model: profile.smallModel }, opts)
}

/** Expand ${ENV_VAR} references in header values. */
function expandHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  return out
}
