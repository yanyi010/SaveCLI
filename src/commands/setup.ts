/**
 * `savecli setup` — first-run onboarding wizard.
 * Picks a provider, collects the key (hidden), optionally tests connectivity,
 * stores the credential and sets the default profile.
 */
import { BUILTIN_PROFILES, loadConfig, type ProfileConfig, type ResolvedProfile } from '../config.js'
import { apiKeyLogin, deviceLogin, resolveApiKey } from '../auth.js'
import { mutateUserConfig } from './config-helpers.js'
import { c } from '../ui/colors.js'
import { promptConfirm, promptText } from '../ui/prompt.js'

interface Choice {
  key: string
  label: string
  profile?: string
  device?: 'claude' | 'codex'
}

const CHOICES: Choice[] = [
  { key: 'claude', label: 'Claude (Anthropic OAuth login)', profile: 'claude', device: 'claude' },
  { key: 'codex', label: 'Codex (OpenAI OAuth login)', profile: 'codex', device: 'codex' },
  { key: 'anthropic', label: 'Anthropic API key', profile: 'anthropic' },
  { key: 'openai', label: 'OpenAI API key', profile: 'openai' },
  { key: 'deepseek', label: 'DeepSeek API key', profile: 'deepseek' },
  { key: 'moonshot', label: 'Moonshot / Kimi API key', profile: 'moonshot' },
  { key: 'zhipu', label: 'Zhipu GLM API key', profile: 'zhipu' },
  { key: 'openrouter', label: 'OpenRouter API key', profile: 'openrouter' },
  { key: 'ollama', label: 'Ollama (local, no key)', profile: 'ollama' },
  { key: 'lmstudio', label: 'LM Studio (local, no key)', profile: 'lmstudio' },
  { key: 'custom', label: 'Custom OpenAI-compatible endpoint', profile: 'custom' },
]

export async function cmdSetup(cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    console.log('Non-interactive terminal — setup wizard needs a TTY.')
    console.log('Alternatives:')
    console.log('  SAVECLI_API_KEY=… SAVECLI_BASE_URL=… SAVECLI_MODEL=… savecli "task"')
    console.log('  savecli auth login anthropic   # then follow prompts')
    return 1
  }

  console.log(c.bold('\nSaveCLI setup — answer a few questions, you are ready to code.\n'))
  console.log('Which provider do you want to use?\n')
  CHOICES.forEach((choice, i) => console.log(`  ${i + 1}. ${c.green(choice.label)}`))
  console.log('')

  const pickRaw = await promptText('Choice (1-11)', '1')
  const idx = Number(pickRaw) - 1
  const choice = CHOICES[idx]
  if (!choice || Number.isNaN(idx) || idx < 0 || idx >= CHOICES.length) {
    console.log(c.red('Invalid choice.'))
    return 1
  }

  let profileName = choice.profile ?? 'custom'

  if (choice.device !== undefined) {
    const res = await deviceLogin(choice.device)
    console.log(res.ok ? c.green(res.message) : c.red(res.message))
    if (!res.ok) return 1
    const wantsKeyInstead = await promptConfirm('Also/instead store an API key for this provider?', false)
    if (wantsKeyInstead) {
      const res2 = await apiKeyLogin(choice.device)
      console.log(res2.ok ? c.green(res2.message) : c.yellow(res2.message))
    }
  } else {
    const builtin = BUILTIN_PROFILES[profileName]
    const baseUrl =
      profileName === 'custom'
        ? await promptText('Base URL (e.g. https://gateway.example.com/v1)')
        : await promptText('Base URL (Enter = default)', builtin?.baseUrl ?? '')
    if (profileName === 'custom') {
      if (baseUrl === '') {
        console.log(c.red('Base URL is required for custom providers.'))
        return 1
      }
      const customName = await promptText('Profile name for this endpoint', 'custom')
      profileName = customName.replace(/\s+/g, '-') || 'custom'
      const model = await promptText('Model id (e.g. deepseek-chat)')
      if (model === '') {
        console.log(c.red('Model id is required.'))
        return 1
      }
      const profile: ProfileConfig = {
        provider: 'openai',
        model,
        baseUrl,
      }
      mutateUserConfig((partial) => {
        const profiles = (partial['profiles'] as Record<string, unknown> | undefined) ?? {}
        profiles[profileName] = profile
        partial['profiles'] = profiles
      })
    }
    if (profileName !== 'ollama' && profileName !== 'lmstudio') {
      const res = await apiKeyLogin(profileName, { baseUrl: baseUrl === '' ? undefined : baseUrl })
      console.log(res.ok ? c.green(res.message) : c.red(res.message))
      if (!res.ok) return 1
    }
  }

  mutateUserConfig((partial) => {
    partial['defaultProfile'] = profileName
  })
  console.log(c.green(`\n✓ Default profile: ${profileName}`))

  // Optional connectivity test (free /models listing, never a chat call).
  const wantsTest = await promptConfirm('Test the connection now? (free, no tokens)', true)
  if (wantsTest) {
    await testConnection(cwd, profileName)
  }

  console.log(c.bold('\nYou are ready. Try:'))
  console.log(c.dim('  savecli                 # interactive REPL'))
  console.log(c.dim('  savecli "fix the bug"   # one-shot'))
  console.log(c.dim('  savecli usage           # token spend overview'))
  console.log('')
  return 0
}

async function testConnection(cwd: string, profileName: string): Promise<void> {
  const { config } = loadConfig(cwd)
  const profile = config.profiles[profileName]
  if (!profile) {
    console.log(c.yellow('Profile not found — skipping test.'))
    return
  }
  const baseUrl = profile.baseUrl ?? (profile.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  const url =
    profile.provider === 'anthropic' ? `${baseUrl.replace(/\/$/, '')}/v1/models` : `${baseUrl.replace(/\/$/, '')}/models`
  const headers: Record<string, string> = {}
  const resolved: ResolvedProfile = {
    profileName,
    provider: profile.provider,
    baseUrl,
    model: profile.model,
  }
  const key = resolveApiKey(resolved).apiKey
  if (key) {
    if (profile.provider === 'anthropic') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['authorization'] = `Bearer ${key}`
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (res.ok) {
      console.log(c.green(`✓ connection ok (${res.status}) — endpoint reachable and key accepted`))
    } else if (res.status === 401 || res.status === 403) {
      console.log(c.yellow(`⚠ endpoint reachable, but the key was rejected (HTTP ${res.status})`))
    } else {
      console.log(c.yellow(`⚠ unexpected HTTP ${res.status} from ${url} (some gateways don't implement /models — this may be fine)`))
    }
  } catch (err) {
    console.log(c.yellow(`⚠ could not reach ${url}: ${err instanceof Error ? err.message : err}`))
    console.log(c.dim('  (offline? custom gateway without /models? you can still try a chat)'))
  } finally {
    clearTimeout(timer)
  }
}
