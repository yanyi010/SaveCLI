import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATHS, PROJECT_DIR_NAME } from './constants.js'
import { log } from './util/log.js'
import { defaultSecurityConfig, type SecurityConfig } from './security.js'

export type ProviderKind = 'openai' | 'anthropic'

export interface ProfileConfig {
  /** Wire protocol / API dialect. */
  provider: ProviderKind
  /** API base URL. Falls back to built-in default for known providers. */
  baseUrl?: string
  /** Default model id. */
  model: string
  /** Cheaper model used for compaction and auxiliary calls. */
  smallModel?: string
  /** Inline API key. Discouraged — prefer credentials store or env. */
  apiKey?: string
  /** Environment variable to read the key from (checked before inline key). */
  apiKeyEnv?: string
  /** Credentials-store entry name to draw the key from. */
  authRef?: string
  maxTokens?: number
  temperature?: number
  /** Extra headers (e.g. gateway tokens). Values may reference env with ${VAR}. */
  headers?: Record<string, string>
}

export interface TokenSavingConfig {
  /** Disk cache of identical (model, messages, tools) requests — replay for free. */
  responseCache: boolean
  /** Summarize old turns when the context grows past the threshold. */
  autoCompact: boolean
  /** Estimated-token threshold that triggers auto-compaction. */
  compactThresholdTokens: number
  /** Turns kept verbatim during compaction. */
  keepRecentTurns: number
  /** Max bytes of a tool result before truncation (0 = unlimited). */
  toolOutputLimit: number
  /** Use provider-side prompt caching (Anthropic cache_control / OpenAI prefix). */
  promptCaching: boolean
}

export interface PermissionsConfig {
  /** Bash commands auto-allowed without asking (glob patterns). */
  bashAllow: string[]
  /** Bash commands always denied (glob patterns; checked before allow). */
  bashDeny: string[]
  /** Editing files outside the working directory. */
  editOutsideCwd: 'ask' | 'deny' | 'allow'
  /** Ask before running bash commands not matched by allow/deny. */
  bashAsk: boolean
}

export interface Config {
  version: number
  defaultProfile: string
  profiles: Record<string, ProfileConfig>
  tokenSaving: TokenSavingConfig
  permissions: PermissionsConfig
  security: SecurityConfig
}

export const DEFAULT_TOKEN_SAVING: TokenSavingConfig = {
  responseCache: true,
  autoCompact: true,
  compactThresholdTokens: 24_000,
  keepRecentTurns: 6,
  toolOutputLimit: 8_192,
  promptCaching: true,
}

export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  bashDeny: [
    'rm -rf /*',
    'rm -fr /*',
    'sudo rm*',
    'mkfs*',
    'dd if=* of=/dev/*',
    'shutdown*',
    'reboot*',
    'halt*',
    'init 0*',
    'chmod -R 777 /*',
    'chown -R * /*',
    ':(){*,*}&*',
    'curl* | sh',
    'curl* | bash',
    'wget* | sh',
    'wget* | bash',
    '> /dev/sd*',
  ],
  bashAllow: [
    'ls*',
    'pwd',
    'cat *',
    'cat',
    'head *',
    'tail *',
    'wc *',
    'echo *',
    'which *',
    'file *',
    'tree *',
    'du *',
    'df *',
    'stat *',
    'rg *',
    'grep *',
    'find *',
    'fd *',
    'git status*',
    'git diff*',
    'git log*',
    'git show*',
    'git branch*',
    'git remote*',
    'git stash list*',
    'git rev-parse *',
    'node --version',
    'node -v',
    'npm --version',
    'python* --version',
    'python* -V',
    'go version',
    'rustc --version',
    'cargo --version',
    'git --version',
  ],
  editOutsideCwd: 'ask',
  bashAsk: true,
}

/** Built-in provider templates. Referenced by name; never contain keys. */
export const BUILTIN_PROFILES: Record<string, ProfileConfig> = {
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    smallModel: 'claude-haiku-4-5',
    maxTokens: 8_192,
  },
  claude: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    smallModel: 'claude-haiku-4-5',
    maxTokens: 8_192,
    authRef: 'claude',
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.1',
    smallModel: 'gpt-5-mini',
  },
  codex: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.1-codex',
    smallModel: 'gpt-5-mini',
    authRef: 'codex',
  },
  deepseek: {
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    smallModel: 'deepseek-chat',
  },
  moonshot: {
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-turbo-preview',
    smallModel: 'kimi-k2-turbo-preview',
  },
  zhipu: {
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    smallModel: 'glm-4.5-air',
  },
  openrouter: {
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    smallModel: 'anthropic/claude-haiku-4.5',
  },
  ollama: {
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:14b',
    smallModel: 'qwen2.5-coder:7b',
  },
  lmstudio: {
    provider: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen2.5-coder-14b-instruct',
  },
}

export function defaultConfig(): Config {
  return {
    version: 1,
    defaultProfile: 'anthropic',
    profiles: Object.fromEntries(Object.entries(BUILTIN_PROFILES).map(([k, v]) => [k, { ...v }])),
    tokenSaving: { ...DEFAULT_TOKEN_SAVING },
    permissions: {
      bashDeny: [...DEFAULT_PERMISSIONS.bashDeny],
      bashAllow: [...DEFAULT_PERMISSIONS.bashAllow],
      editOutsideCwd: 'ask',
      bashAsk: true,
    },
    security: defaultSecurityConfig(),
  }
}

function mergeProfile(base: ProfileConfig, over: Partial<ProfileConfig>): ProfileConfig {
  return { ...base, ...over }
}

function deepMergeConfig(base: Config, over: Partial<Config>): Config {
  const result: Config = {
    ...base,
    profiles: { ...base.profiles },
    tokenSaving: { ...base.tokenSaving, ...(over.tokenSaving ?? {}) },
    permissions: {
      ...base.permissions,
      ...(over.permissions ?? {}),
      bashAllow: over.permissions?.bashAllow ?? base.permissions.bashAllow,
      bashDeny: over.permissions?.bashDeny ?? base.permissions.bashDeny,
    },
    security: { ...base.security, ...(over.security ?? {}) },
  }
  if (over.defaultProfile) result.defaultProfile = over.defaultProfile
  if (over.security?.protectedPaths) result.security.protectedPaths = over.security.protectedPaths
  if (over.security?.warnPaths) result.security.warnPaths = over.security.warnPaths
  if (over.profiles) {
    for (const [name, profile] of Object.entries(over.profiles)) {
      if (!profile || typeof profile !== 'object') continue
      const sanitized = sanitizeProfile(name, profile)
      const existing = result.profiles[name]
      if (existing) {
        result.profiles[name] = mergeProfile(existing, sanitized)
      } else {
        const template = BUILTIN_PROFILES[name]
        const merged = template ? { ...template, ...sanitized } : sanitized
        if (typeof merged.provider === 'string' && typeof merged.model === 'string') {
          result.profiles[name] = merged as ProfileConfig
        } else {
          log.warn('config', `profile "${name}" is missing provider or model — ignored`)
        }
      }
    }
  }
  return result
}

/** Project-level configs must not carry secrets — silently strip with a warning. */
function sanitizeProfile(name: string, profile: Partial<ProfileConfig>): Partial<ProfileConfig> {
  if (profile.apiKey !== undefined) {
    log.warn('config', `profile "${name}" in project config contains apiKey — ignored for security`)
    const { apiKey: _ignored, ...rest } = profile
    return rest
  }
  return profile
}

export interface LoadedConfig {
  config: Config
  /** Config file paths that contributed, in precedence order (low → high). */
  sources: string[]
  projectRoot?: string
}

/** Find nearest ancestor directory (including cwd) containing a .savecli dir. */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = startDir
   
  while (true) {
    if (existsSync(join(dir, PROJECT_DIR_NAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Load configuration: defaults < user config < project config < env overrides.
 * Project configs cannot inject credentials.
 */
export function loadConfig(cwd: string): LoadedConfig {
  const sources: string[] = []
  let config = defaultConfig()

  // 2. user config
  const userPath = PATHS.config
  const userJson = safeReadJson(userPath) as Partial<Config> | undefined
  if (userJson) {
    config = deepMergeConfig(config, userJson)
    sources.push(userPath)
  }

  // 3. project config (nearest .savecli/config.json)
  const projectRoot = findProjectRoot(cwd)
  if (projectRoot) {
    const projectPath = join(projectRoot, PROJECT_DIR_NAME, 'config.json')
    const projectJson = safeReadJson(projectPath) as Partial<Config> | undefined
    if (projectJson) {
      config = deepMergeConfig(config, projectJson)
      sources.push(projectPath)
    }
  }

  // 4. env overrides
  const envProfile = process.env['SAVECLI_PROFILE']
  if (envProfile) config.defaultProfile = envProfile

  return { config, sources, projectRoot }
}

function safeReadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    log.warn('config', `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

export interface ResolvedProfile {
  profileName: string
  provider: ProviderKind
  baseUrl: string
  model: string
  smallModel?: string
  apiKeyEnv?: string
  authRef?: string
  inlineApiKey?: string
  maxTokens?: number
  temperature?: number
  headers?: Record<string, string>
}

/**
 * Resolve a model spec into a concrete profile.
 * Accepted forms:
 *   "sonnet"            → profile named sonnet
 *   "anthropic/claude-sonnet-4-5" → built-in/user profile "anthropic", model override
 *   "claude-sonnet-4-5" → default profile with model override
 */
export function resolveProfileSpec(config: Config, spec: string | undefined): ResolvedProfile {
  let profileName = config.defaultProfile
  let modelOverride: string | undefined

  if (spec) {
    if (spec.includes('/')) {
      const idx = spec.indexOf('/')
      const providerPart = spec.slice(0, idx)
      const modelPart = spec.slice(idx + 1)
      profileName = providerPart
      if (modelPart !== '') modelOverride = modelPart
    } else if (config.profiles[spec]) {
      profileName = spec
    } else {
      modelOverride = spec
    }
  }

  const profile = config.profiles[profileName]
  if (!profile) {
    const known = Object.keys(config.profiles).join(', ')
    throw new SavecliError(`unknown profile "${profileName}". Known profiles: ${known}`)
  }

  return {
    profileName,
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? defaultBaseUrl(profile.provider),
    model: modelOverride ?? profile.model,
    smallModel: profile.smallModel,
    apiKeyEnv: profile.apiKeyEnv,
    authRef: profile.authRef,
    inlineApiKey: profile.apiKey,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    headers: profile.headers,
  }
}

export function defaultBaseUrl(provider: ProviderKind): string {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
}

export class SavecliError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'SavecliError'
  }
}

/** Environment-level runtime overrides for the active session. */
export interface RuntimeOverrides {
  provider?: ProviderKind
  baseUrl?: string
  model?: string
  smallModel?: string
  apiKey?: string
  noCache?: boolean
  yolo?: boolean
}

export function applyEnvOverrides(resolved: ResolvedProfile, env: NodeJS.ProcessEnv = process.env): ResolvedProfile {
  const out: ResolvedProfile = { ...resolved }
  if (env['SAVECLI_BASE_URL']) out.baseUrl = env['SAVECLI_BASE_URL']
  if (env['SAVECLI_MODEL']) out.model = env['SAVECLI_MODEL']
  if (env['SAVECLI_SMALL_MODEL']) out.smallModel = env['SAVECLI_SMALL_MODEL']
  if (env['SAVECLI_API_KEY']) out.inlineApiKey = env['SAVECLI_API_KEY']
  return out
}
