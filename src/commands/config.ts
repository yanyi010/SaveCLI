/**
 * `savecli config …` — configure everything from the CLI, no file digging.
 *
 *   savecli config list                     show effective settings + sources
 *   savecli config get <key>                read one value
 *   savecli config set <key> <value>        write one value (user config)
 *   savecli config unset <key>              revert to default
 *   savecli config profiles                 list provider profiles
 *   savecli config profile [name]           interactive profile editor wizard
 *   savecli config model [spec]             view / switch default model
 *   savecli config edit                     open in $EDITOR (escape hatch)
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PATHS } from '../constants.js'
import {
  BUILTIN_PROFILES,
  loadConfig,
  resolveProfileSpec,
  type Config,
  type ProfileConfig,
} from '../config.js'
import {
  CONFIG_KEYS,
  coerceConfigValue,
  findConfigKey,
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
} from '../config-schema.js'
import { apiKeyLogin } from '../auth.js'
import { c } from '../ui/colors.js'
import { promptConfirm, promptText } from '../ui/prompt.js'
import { mutateUserConfig, readUserConfigRaw } from './config-helpers.js'

export function cmdConfigList(cwd: string): number {
  const { config, sources } = loadConfig(cwd)
  console.log(c.bold('SaveCLI configuration'))
  console.log(c.dim(`  merged from: ${sources.length > 0 ? sources.join(' → ') : 'defaults only'}`))
  console.log()
  let section = ''
  for (const key of CONFIG_KEYS) {
    const sec = key.path.split('.')[0] ?? ''
    if (sec !== section) {
      section = sec
      console.log(c.cyan(`[${section}]`))
    }
    const value = getConfigValue(config, key.path)
    console.log(`  ${c.green(key.path)} = ${c.bold(formatValue(value))}`)
    console.log(c.dim(`    ${key.description}`))
  }
  console.log()
  console.log(c.cyan('[profiles]'))
  for (const [name, profile] of Object.entries(config.profiles)) {
    const isDefault = name === config.defaultProfile
    const marker = isDefault ? c.yellow(' (default)') : ''
    console.log(`  ${c.green(name)}${marker} → ${describeProfile(profile)}`)
  }
  console.log()
  console.log(c.dim('Tip: `savecli config profile <name>` edits a profile interactively;'))
  console.log(c.dim('     `savecli setup` runs the full onboarding wizard.'))
  return 0
}

function describeProfile(p: ProfileConfig): string {
  const parts = [p.provider, p.baseUrl ?? '(default url)', p.model]
  if (p.smallModel) parts.push(`small=${p.smallModel}`)
  if (p.authRef) parts.push(`auth=${p.authRef}`)
  if (p.apiKeyEnv) parts.push(`env=${p.apiKeyEnv}`)
  return parts.join(' · ')
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.join(', ')}]`
  return JSON.stringify(v)
}

export function cmdConfigGet(cwd: string, path: string): number {
  const { info, suggestions } = findConfigKey(path)
  if (!info) return unknownKeyError(path, suggestions)
  const { config } = loadConfig(cwd)
  console.log(formatValue(getConfigValue(config, info.path)))
  return 0
}

export function cmdConfigSet(cwd: string, path: string, rawValue: string): number {
  const { info, suggestions } = findConfigKey(path)
  if (!info) return unknownKeyError(path, suggestions)
  const value = coerceConfigValue(info, rawValue)
  mutateUserConfig((partial) => setConfigValue(partial, info.path, value))
  console.log(c.green(`✓ ${info.path} = ${formatValue(value)}`))
  return 0
}

export function cmdConfigUnset(path: string): number {
  const { info, suggestions } = findConfigKey(path)
  if (!info) return unknownKeyError(path, suggestions)
  mutateUserConfig((partial) => unsetConfigValue(partial, info.path))
  console.log(c.green(`✓ ${info.path} reverted to default`))
  return 0
}

function unknownKeyError(path: string, suggestions: string[]): number {
  console.error(c.red(`Unknown config key: "${path}"`))
  if (suggestions.length > 0) {
    console.error(c.yellow(`Did you mean: ${suggestions.map((s) => `  ${s}`).join('\n')}`))
  } else {
    console.error(c.yellow('Run `savecli config list` to see all keys.'))
  }
  return 1
}

export function cmdConfigProfiles(): number {
  console.log(c.bold('Provider profiles'))
  for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
    console.log(`  ${c.green(name)} (built-in) → ${describeProfile(profile)}`)
  }
  const user = readUserConfigRaw()
  const userProfiles = (user['profiles'] as Record<string, ProfileConfig> | undefined) ?? {}
  for (const [name, profile] of Object.entries(userProfiles)) {
    console.log(`  ${c.green(name)} (yours) → ${describeProfile({ ...BUILTIN_PROFILES[name], ...profile })}`)
  }
  console.log()
  console.log(c.dim('Use a profile with: savecli --model <name>   or   savecli --model <name>/<model-id>'))
  console.log(c.dim('Edit one with:    savecli config profile <name>'))
  return 0
}

/** Interactive profile editor. Creates or modifies a named profile. */
export async function cmdConfigProfileWizard(cwd: string, nameArg?: string): Promise<number> {
  const name =
    nameArg ??
    (await promptText('Profile name (e.g. myproxy)', 'custom')).replace(/\s+/g, '-')
  if (name === '') {
    console.error(c.red('Profile name is required.'))
    return 1
  }

  const { config } = loadConfig(cwd)
  const existing = config.profiles[name]
  const builtin = BUILTIN_PROFILES[name]
  const base: Partial<ProfileConfig> = { ...builtin, ...existing }

  console.log(c.bold(`\nEditing profile "${name}"${existing ? '' : ' (new)'} — Enter keeps the current value\n`))

  const provider = (await promptText('Provider kind (openai | anthropic)', base.provider ?? 'openai')) as ProfileConfig['provider']
  if (provider !== 'openai' && provider !== 'anthropic') {
    console.error(c.red(`Invalid provider "${provider}" — use openai or anthropic.`))
    return 1
  }

  const defaultUrl = base.baseUrl ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const baseUrl = await promptText('Base URL', defaultUrl)
  const model = await promptText('Model id', base.model ?? '')
  if (model === '') {
    console.error(c.red('Model id is required.'))
    return 1
  }
  const smallModel = await promptText('Cheap model for compaction (optional)', base.smallModel ?? '')
  const apiKeyEnv = await promptText('Env var holding the API key (optional)', base.apiKeyEnv ?? '')
  const authRef = await promptText('Credentials-store entry name (optional)', base.authRef ?? '')

  const profile: ProfileConfig = {
    provider,
    model,
    baseUrl: baseUrl === '' ? undefined : baseUrl,
    smallModel: smallModel === '' ? undefined : smallModel,
    apiKeyEnv: apiKeyEnv === '' ? undefined : apiKeyEnv,
    authRef: authRef === '' ? undefined : authRef,
  }

  mutateUserConfig((partial) => {
    const profiles = (partial['profiles'] as Record<string, unknown> | undefined) ?? {}
    profiles[name] = profile
    partial['profiles'] = profiles
  })
  console.log(c.green(`\n✓ Profile "${name}" saved.`))

  const wantsKey = await promptConfirm('Store an API key for this profile now? (saved to credentials.json, 0600)', true)
  if (wantsKey) {
    await apiKeyLogin(authRef === '' ? name : authRef, { baseUrl: profile.baseUrl })
  }

  const current = loadConfig(cwd).config
  if (name !== current.defaultProfile) {
    const makeDefault = await promptConfirm(`Make "${name}" the default profile?`, true)
    if (makeDefault) {
      mutateUserConfig((partial) => {
        partial['defaultProfile'] = name
      })
      console.log(c.green(`✓ Default profile is now "${name}".`))
    }
  }
  return 0
}

export function cmdConfigModel(cwd: string, spec?: string): number {
  const { config } = loadConfig(cwd)
  if (!spec) {
    const p = config.profiles[config.defaultProfile]
    console.log(
      `Default: ${c.bold(config.defaultProfile)} → ${p ? describeProfile(p) : c.red('(missing)')}`,
    )
    console.log(c.dim('Switch with: savecli config model <profile> | <profile>/<model-id> | <model-id>'))
    return 0
  }
  // Validate it resolves before saving.
  try {
    resolveProfileSpec(config, spec)
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)))
    return 1
  }
  const profileName = spec.includes('/') ? spec.slice(0, spec.indexOf('/')) : config.profiles[spec] ? spec : config.defaultProfile
  mutateUserConfig((partial) => {
    partial['defaultProfile'] = profileName
    if (spec.includes('/')) {
      const model = spec.slice(spec.indexOf('/') + 1)
      const profiles = (partial['profiles'] as Record<string, unknown> | undefined) ?? {}
      const existing = (profiles[profileName] as Partial<ProfileConfig> | undefined) ?? {}
      existing['model'] = model
      profiles[profileName] = existing
      partial['profiles'] = profiles
    }
  })
  console.log(c.green(`✓ Default model set to ${spec}`))
  return 0
}

export function cmdConfigEdit(): number {
  const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'vi'
  const result = spawnSync(editor, [PATHS.config], { stdio: 'inherit' })
  if (result.error) {
    console.error(c.red(`Could not launch editor "${editor}": ${result.error.message}`))
    return 1
  }
  // Validate the result parses.
  try {
    JSON.parse(readFileSync(PATHS.config, 'utf8'))
    console.log(c.green('✓ Config still valid JSON.'))
  } catch (err) {
    console.error(c.red(`Config is no longer valid JSON: ${err instanceof Error ? err.message : err}`))
    return 1
  }
  return 0
}

/** Shown when no key can be resolved — points users at the fastest fix. */
export function printSetupHint(config: Config): void {
  const known = Object.keys(config.profiles).slice(0, 8).join(', ')
  console.error(c.yellow('\nNo API key found for this profile.'))
  console.error(c.dim('  Fastest fix:   savecli setup            (interactive wizard)'))
  console.error(c.dim('  Or login:      savecli auth login claude | codex | openai | anthropic | custom'))
  console.error(c.dim('  Or env var:    ANTHROPIC_API_KEY / OPENAI_API_KEY / SAVECLI_API_KEY'))
  if (known !== '') console.error(c.dim(`  Known profiles: ${known}`))
}
