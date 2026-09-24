/**
 * `savecli auth …` — credential management.
 *   auth login claude|codex          device-code OAuth flow (manual fallback)
 *   auth login openai|anthropic|custom [--base-url …] [--api-key …]
 *   auth status                      list stored credentials (redacted)
 *   auth logout <name>               remove a credential
 */
import { apiKeyLogin, authStatus, deviceLogin, logout } from '../auth.js'
import { c } from '../ui/colors.js'
import { promptConfirm } from '../ui/prompt.js'

export async function cmdAuth(args: string[]): Promise<number> {
  const sub = args[0] ?? 'status'

  if (sub === 'login') {
    const provider = args[1]
    const flags = parseFlags(args.slice(2))
    if (provider === undefined) {
      console.error(c.red('Usage: savecli auth login <claude|codex|openai|anthropic|custom>'))
      return 1
    }
    switch (provider) {
      case 'claude':
      case 'codex': {
        const useKey = flags['api-key'] !== undefined || (await promptConfirm('Use an API key instead of the OAuth flow?', false))
        if (useKey) {
          const key = typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined
          const res = await apiKeyLogin(provider, { apiKey: key })
          console.log(res.ok ? c.green(res.message) : c.red(res.message))
          return res.ok ? 0 : 1
        }
        const res = await deviceLogin(provider)
        console.log(res.ok ? c.green(res.message) : c.red(res.message))
        return res.ok ? 0 : 1
      }
      case 'openai':
      case 'anthropic':
      case 'custom': {
        const name = provider === 'custom' ? (typeof flags['name'] === 'string' && flags['name'] !== '' ? flags['name'] : 'custom') : provider
        const res = await apiKeyLogin(name, {
          baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
          apiKey: typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined,
        })
        console.log(res.ok ? c.green(res.message) : c.red(res.message))
        if (res.ok && provider === 'custom') {
          console.log(c.dim(`Now create a profile for it:  savecli config profile ${name}`))
        }
        return res.ok ? 0 : 1
      }
      default:
        console.error(c.red(`Unknown provider "${provider}" — use claude, codex, openai, anthropic or custom.`))
        return 1
    }
  }

  if (sub === 'status') {
    const entries = authStatus()
    if (entries.length === 0) {
      console.log(c.dim('No credentials stored. Try: savecli auth login claude'))
      return 0
    }
    console.log(c.bold('Stored credentials (never shown in full):'))
    for (const e of entries) {
      console.log(`  ${c.green(e.name.padEnd(12))} ${e.detail}`)
    }
    return 0
  }

  if (sub === 'logout') {
    const name = args[1]
    if (name === undefined) {
      console.error(c.red('Usage: savecli auth logout <name>'))
      return 1
    }
    const res = logout(name)
    console.log(res.ok ? c.green(res.message) : c.yellow(res.message))
    return res.ok ? 0 : 1
  }

  console.error(c.red(`Unknown auth subcommand "${sub}". Use login, status or logout.`))
  return 1
}

export function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
      flags[a.slice(2)] = args[i + 1]!
      i++
    } else {
      flags[a.slice(2)] = true
    }
  }
  return flags
}
