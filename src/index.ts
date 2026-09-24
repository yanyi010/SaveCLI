#!/usr/bin/env node
/**
 * SaveCLI — token-efficient coding agent.
 * Entry point: argument parsing, subcommand dispatch, REPL / one-shot modes.
 *
 * Startup discipline: only constants/colors/config load eagerly; command
 * modules and the agent graph are imported on demand so `--version`,
 * `--help`, and quick subcommands stay fast.
 */
import { VERSION } from './constants.js'
import { applyEnvOverrides, loadConfig, resolveProfileSpec, type ResolvedProfile, type Config, SavecliError } from './config.js'
import { c } from './ui/colors.js'
import { log } from './util/log.js'

interface CliOptions {
  modelSpec?: string
  yolo: boolean
  noCache: boolean
  print: boolean
  resume?: string
  continue: boolean
  prompt?: string
}

const HELP = `SaveCLI v${VERSION} — token-efficient coding agent

Usage:
  savecli                                 interactive REPL
  savecli "<prompt>"                      one-shot: run a task and print the answer
  savecli -p "<prompt>"                   print mode (final answer only, no UI chrome)

Options:
  -m, --model <spec>        profile | profile/model-id | model-id
  --yolo                    skip confirmations (deny rules still enforced)
  --no-cache                disable the response cache for this run
  -p, --print               print mode for one-shot runs
  -c, --continue            continue the most recent session in this directory
  -s, --session <id>        resume a specific session
  -v, --version             print version
  -h, --help                show this help

Subcommands:
  setup                     first-run wizard (provider, key, model)
  auth login|status|logout  credential management (claude / codex / openai / …)
  config list|get|set|…     settings, profiles, model switching
  mission start|list|…      long-running autonomous missions (Driver mode)
  usage                     token spend & cost overview
  sessions                  list saved sessions
  cache clear               drop the response cache

Environment:
  SAVECLI_API_KEY, SAVECLI_BASE_URL, SAVECLI_MODEL, SAVECLI_PROFILE,
  SAVECLI_NO_CACHE=1, SAVECLI_HOME=…, SAVECLI_DEBUG=1

Token saving (on by default): response cache, auto-compaction, tool output
truncation, context sanitization, prompt caching. See /usage inside the REPL.`

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)

  // ── subcommands ────────────────────────────────────────────────────────
  if (args.length > 0 && !args[0]!.startsWith('-')) {
    const sub = args[0]!
    const rest = args.slice(1)
    switch (sub) {
      case 'help':
        console.log(HELP)
        return 0
      case 'version':
        console.log(VERSION)
        return 0
      case 'setup': {
        const { cmdSetup } = await import('./commands/setup.js')
        return await cmdSetup(process.cwd())
      }
      case 'auth': {
        const { cmdAuth } = await import('./commands/auth.js')
        return await cmdAuth(rest)
      }
      case 'usage': {
        const { cmdUsage } = await import('./commands/usage-cmd.js')
        return cmdUsage(rest)
      }
      case 'sessions': {
        const { cmdSessions } = await import('./commands/sessions-cmd.js')
        return cmdSessions(rest)
      }
      case 'mission': {
        const { cmdMission } = await import('./commands/mission.js')
        return await cmdMission(rest)
      }
      case 'cache': {
        if (rest[0] === 'clear') {
          const { clearResponseCache } = await import('./agent/cache.js')
          const n = clearResponseCache()
          console.log(c.green(`✓ removed ${n} cached responses`))
          return 0
        }
        console.error(c.red('Usage: savecli cache clear'))
        return 1
      }
      case 'config': {
        const cfg = await import('./commands/config.js')
        const sub2 = rest[0] ?? 'list'
        const rest2 = rest.slice(1)
        const cwd = process.cwd()
        switch (sub2) {
          case 'list':
            return cfg.cmdConfigList(cwd)
          case 'get':
            if (rest2[0] === undefined) {
              console.error(c.red('Usage: savecli config get <key>'))
              return 1
            }
            return cfg.cmdConfigGet(cwd, rest2[0]!)
          case 'set': {
            if (rest2.length < 2) {
              console.error(c.red('Usage: savecli config set <key> <value>'))
              return 1
            }
            return cfg.cmdConfigSet(cwd, rest2[0]!, rest2.slice(1).join(' '))
          }
          case 'unset':
            if (rest2[0] === undefined) {
              console.error(c.red('Usage: savecli config unset <key>'))
              return 1
            }
            return cfg.cmdConfigUnset(rest2[0]!)
          case 'profiles':
            return cfg.cmdConfigProfiles()
          case 'profile':
            return await cfg.cmdConfigProfileWizard(cwd, rest2[0])
          case 'model':
            return cfg.cmdConfigModel(cwd, rest2[0])
          case 'edit':
            return cfg.cmdConfigEdit()
          default:
            console.error(c.red(`Unknown config subcommand "${sub2}"`))
            return 1
        }
      }
      default:
        // Unknown subcommand — treat as a one-shot prompt? No: be explicit.
        if (!sub.includes(' ')) {
          console.error(c.red(`Unknown command "${sub}". Run savecli --help.`))
          return 1
        }
        // fall through: quoted prompt starting with a word
        break
    }
  }

  // ── flag parsing ───────────────────────────────────────────────────────
  const opts: CliOptions = { yolo: false, noCache: false, print: false, continue: false }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP)
        return 0
      case '-v':
      case '--version':
        console.log(VERSION)
        return 0
      case '-m':
      case '--model':
        opts.modelSpec = args[++i]
        break
      case '--yolo':
        opts.yolo = true
        break
      case '--no-cache':
        opts.noCache = true
        break
      case '-p':
      case '--print':
        opts.print = true
        break
      case '-c':
      case '--continue':
        opts.continue = true
        break
      case '-s':
      case '--session':
        opts.resume = args[++i]
        break
      default:
        if (a.startsWith('-')) {
          if (a.includes('=')) {
            const [k, v] = a.split('=')
            if (k === '--model' || k === '-m') opts.modelSpec = v
            else if (k === '--session' || k === '-s') opts.resume = v
            else {
              console.error(c.red(`Unknown option ${k}`))
              return 1
            }
          } else {
            console.error(c.red(`Unknown option ${a}`))
            return 1
          }
        } else {
          positional.push(a)
        }
    }
  }

  const prompt = positional.join(' ').trim()
  const stdinIsPiped = !process.stdin.isTTY && prompt === ''
  const stdinText = stdinIsPiped ? await readStdin() : ''
  const task = prompt !== '' ? prompt : stdinText.trim()
  const oneShot = task !== ''

  if (opts.print && !oneShot) {
    console.error(c.red('--print needs a prompt (argument or piped stdin).'))
    return 1
  }

  // ── resolve configuration & profile ────────────────────────────────────
  const cwd = process.cwd()
  const { config } = loadConfig(cwd)
  let resolved: ResolvedProfile
  try {
    resolved = resolveProfileSpec(config, opts.modelSpec)
  } catch (err) {
    if (err instanceof SavecliError) {
      console.error(c.red(err.message))
      return 1
    }
    throw err
  }
  resolved = applyEnvOverrides(resolved)
  const cacheDisabled = opts.noCache || process.env['SAVECLI_NO_CACHE'] === '1' || !config.tokenSaving.responseCache

  // --continue: most recent session in this cwd
  let resumeId = opts.resume
  if (opts.continue && resumeId === undefined) {
    const { Session } = await import('./agent/session.js')
    const recent = Session.listRecent(50).filter((s) => s.cwd === cwd)
    if (recent.length > 0) resumeId = recent[0]!.id
    else console.error(c.yellow('No previous session in this directory — starting fresh.'))
  }

  // ── run ────────────────────────────────────────────────────────────────
  if (!oneShot) {
    const { runRepl } = await import('./ui/repl.js')
    await runRepl({
      cwd,
      config,
      profile: resolved,
      yolo: opts.yolo,
      cacheDisabled,
      resumeSessionId: resumeId,
    })
    return 0
  }

  return await runOneShot({
    cwd,
    config,
    profile: resolved,
    task,
    yolo: opts.yolo,
    printMode: opts.print,
    cacheDisabled,
    resumeSessionId: resumeId,
  })
}

async function runOneShot(opts: {
  cwd: string
  profile: ResolvedProfile
  config: Config
  task: string
  yolo: boolean
  printMode: boolean
  cacheDisabled: boolean
  resumeSessionId?: string
}): Promise<number> {
  const [{ resolveApiKey }, { Agent }, { Session, eventsToMessages }, { printSetupHint }, { Spinner }, { renderMarkdown }, { estimateCostUsd }] =
    await Promise.all([
      import('./auth.js'),
      import('./agent/loop.js'),
      import('./agent/session.js'),
      import('./commands/config.js'),
      import('./ui/spinner.js'),
      import('./ui/render.js'),
      import('./agent/usage.js'),
    ])
  const key = resolveApiKey(opts.profile)
  if (!key.apiKey && opts.profile.provider === 'anthropic') {
    printSetupHint(opts.config)
    return 1
  }

  const spinner = new Spinner(!opts.printMode && process.stderr.isTTY === true)
  const agent = new Agent({
    cwd: opts.cwd,
    config: opts.config,
    profile: opts.profile,
    yolo: opts.yolo,
    nonInteractive: true,
    cacheDisabled: opts.cacheDisabled,
    ...(opts.resumeSessionId
      ? {
          session: new Session(opts.resumeSessionId),
          resumeMessages: eventsToMessages(Session.load(opts.resumeSessionId)),
        }
      : {}),
  })

  if (!opts.printMode) {
    console.log(c.dim(`savecli · ${agent.providerLabel} · key: ${key.source}`))
  }

  spinner.start(agent.providerLabel)
  const startedAt = Date.now()
  let streamed = ''
  const result = await agent.send(
    opts.task,
    {
      onText: (delta) => {
        if (opts.printMode) return
        spinner.stop()
        process.stdout.write(delta)
        streamed += delta
      },
      onToolStart: (name, argsSummary) => {
        if (opts.printMode) return
        // Skip the early name-only notice from stream onToolCallStart —
        // the full (name, args) line follows immediately.
        if (argsSummary === '') return
        spinner.stop()
        process.stdout.write(`${c.dim('⚙')} ${c.cyan(name)} ${c.dim(argsSummary.slice(0, 100))}\n`)
      },
      onToolEnd: (name, summary, isError) => {
        if (opts.printMode) return
        const mark = isError ? c.red('✗') : c.green('✓')
        process.stdout.write(`${mark}${c.dim(` ${name}`)}${summary !== '' ? c.dim(` ${summary.slice(0, 120)}`) : ''}\n`)
        spinner.start(agent.providerLabel)
      },
      onNotice: (message) => {
        if (!opts.printMode) process.stdout.write(`${c.magenta('ℹ')} ${c.dim(message)}\n`)
      },
      confirm: async () => false,
    },
  )
  spinner.stop()

  if (opts.printMode) {
    // Pure output for scripting: final answer only.
    if (result.ok) {
      console.log(result.text)
      return 0
    }
    console.error(result.error ?? 'unknown error')
    return 1
  }

  if (streamed === '' && result.text !== '') {
    console.log(renderMarkdown(result.text))
  } else if (streamed !== '') {
    process.stdout.write('\n')
  }
  const cost = estimateCostUsd(opts.profile.model, result.usage)
  console.error(
    c.dim(
      `⏱ ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${result.usage.input} in / ${result.usage.output} out${cost !== undefined ? ` · ~$${cost.toFixed(4)}` : ''} · ${result.turns} turn${result.turns > 1 ? 's' : ''}`,
    ),
  )
  if (!result.ok && result.error !== undefined) {
    console.error(c.red(result.error))
    return 1
  }
  return 0
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    // Guard: piped stdin that never closes
    setTimeout(() => resolve(data), 100).unref?.()
  })
}

// When executed directly (node dist/index.js), run main; the bin wrapper
// imports and calls main() explicitly.
if (process.argv[1]?.endsWith('index.js')) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      log.error('cli', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
      console.error(c.red(`savecli: ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    })
}
