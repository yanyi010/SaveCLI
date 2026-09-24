/**
 * Interactive REPL — a single-readline state machine (input / busy / confirm).
 * Features: streaming output, steering queue, y/a/n approval with "always",
 * slash commands, custom commands, Ctrl-C abort-then-exit.
 */
import createReadline from 'node:readline'
import { VERSION } from '../constants.js'
import { type Config, type ResolvedProfile, resolveProfileSpec } from '../config.js'
import { coerceConfigValue, findConfigKey, setConfigValue } from '../config-schema.js'
import { mutateUserConfig } from '../commands/config-helpers.js'
import { expandTemplate, loadCustomCommands } from '../commands/custom.js'
import { Agent, type AgentCallbacks } from '../agent/loop.js'
import { Session, eventsToMessages } from '../agent/session.js'
import { estimateCostUsd, summarizeUsage } from '../agent/usage.js'
import { c } from './colors.js'
import { renderTurnStatus } from './render.js'
import { Spinner } from './spinner.js'
import { formatNumber } from '../util/tokens.js'

interface ConfirmRequest {
  question: string
  pattern?: string
  resolve: (v: 'yes' | 'always' | 'no') => void
}

export interface ReplOptions {
  cwd: string
  config: Config
  profile: ResolvedProfile
  yolo?: boolean
  cacheDisabled?: boolean
  resumeSessionId?: string
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const rl = createReadline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan('❯')} `,
    historySize: 500,
  })

  let agent: Agent
  if (opts.resumeSessionId) {
    const events = Session.load(opts.resumeSessionId)
    if (events.length === 0) {
      console.error(c.red(`session ${opts.resumeSessionId} not found`))
      process.exit(1)
    }
    agent = new Agent({
      cwd: opts.cwd,
      config: opts.config,
      profile: opts.profile,
      yolo: opts.yolo,
      nonInteractive: false,
      cacheDisabled: opts.cacheDisabled,
      session: new Session(opts.resumeSessionId),
      resumeMessages: eventsToMessages(events),
    })
  } else {
    agent = new Agent({
      cwd: opts.cwd,
      config: opts.config,
      profile: opts.profile,
      yolo: opts.yolo,
      nonInteractive: false,
      cacheDisabled: opts.cacheDisabled,
    })
  }

  const spinner = new Spinner(process.stderr.isTTY === true)
  const queue: string[] = []
  let busy = false
  let pendingConfirm: ConfirmRequest | null = null
  let buffer = '' // multi-line continuation
  let lastUsage = { input: 0, output: 0, cacheRead: 0 }
  let lastUsageFromCache = false
  let abortController: AbortController | null = null

  const customCommands = loadCustomCommands(opts.cwd)

  // ── banner ──────────────────────────────────────────────────────────────
  console.log(c.bold(`SaveCLI ${c.dim(`v${VERSION}`)}`) + c.dim(` · ${agent.providerLabel} · ${opts.cwd}`))
  if (agent.keyMissing) {
    console.log(c.yellow('\nNo API key found for this profile.'))
    console.log(c.dim('  Run `savecli setup` for the wizard, or `savecli auth login claude` etc.'))
    console.log(c.dim('  You can still explore commands with /help.\n'))
  } else {
    console.log(c.dim('Type /help for commands · Ctrl-C aborts a turn, twice exits'))
  }

  // ── confirmation plumbing ───────────────────────────────────────────────
  function askConfirm(question: string, pattern?: string): Promise<'yes' | 'always' | 'no'> {
    return new Promise((resolve) => {
      pendingConfirm = {
        question,
        pattern,
        resolve: (v) => {
          pendingConfirm = null
          resolve(v)
        },
      }
      const hint = pattern !== undefined ? '(y)es / (a)lways allow / (n)o' : '(y)es / (n)o'
      rl.setPrompt(`${c.yellow('?')} ${question} ${c.dim(hint)} `)
      rl.prompt(true)
    })
  }

  const callbacks: AgentCallbacks = {
    onText: (delta) => {
      spinner.stop()
      process.stdout.write(delta)
    },
    onToolStart: (name, argsSummary) => {
      spinner.stop()
      if (argsSummary !== '') process.stdout.write(`\n${c.dim('⚙')} ${c.cyan(name)} ${c.dim(argsSummary.slice(0, 100))}\n`)
      else process.stdout.write(`\n${c.dim('⚙')} ${c.cyan(name)}\n`)
      spinner.start(name)
    },
    onToolEnd: (name, summary, isError, durationMs) => {
      spinner.stop()
      const mark = isError ? c.red('✗') : c.green('✓')
      const line = summary !== '' ? ` ${c.dim(summary.slice(0, 120))}` : ''
      process.stdout.write(`${mark}${c.dim(` ${name} (${(durationMs / 1000).toFixed(1)}s)`)}${line}\n`)
    },
    onUsage: (usage, meta) => {
      lastUsage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0 }
      lastUsageFromCache = meta.fromCache
    },
    onNotice: (message) => {
      spinner.stop()
      process.stdout.write(`\n${c.magenta('ℹ')} ${c.dim(message)}\n`)
    },
    onTodos: (todos) => {
      renderTodos(todos)
    },
    confirm: async (question) => {
      if (agent.yolo) return true
      const v = await askConfirm(question)
      return v !== 'no'
    },
    confirmWithRemember: async (question, pattern) => askConfirm(question, pattern),
    drainQueue: () => {
      if (queue.length === 0) return []
      const drained = queue.splice(0, queue.length)
      for (const q of drained) process.stdout.write(`\n${c.magenta('↳')} ${c.dim(`steering: ${q.slice(0, 100)}`)}\n`)
      return drained
    },
  }

  // ── turn execution ──────────────────────────────────────────────────────
  async function runTurn(text: string): Promise<void> {
    busy = true
    abortController = new AbortController()
    const startedAt = Date.now()
    spinner.start(agent.providerLabel)
    try {
      const result = await agent.send(text, callbacks, abortController.signal)
      spinner.stop()
      process.stdout.write('\n')
      if (result.text === '' && result.error !== undefined) {
        process.stdout.write(`${c.red('✗')} ${result.error}\n`)
      }
      const cost = estimateCostUsd(agent.profile.model, lastUsage)
      process.stdout.write(
        `  ${c.dim('│')} ${renderTurnStatus({
          seconds: (Date.now() - startedAt) / 1000,
          input: lastUsage.input,
          output: lastUsage.output,
          cacheRead: lastUsage.cacheRead,
          costUsd: cost,
          model: agent.profile.model,
          fromCache: lastUsageFromCache,
        })}\n\n`,
      )
    } catch (err) {
      spinner.stop()
      process.stdout.write(`\n${c.red('✗')} ${err instanceof Error ? err.message : String(err)}\n\n`)
    } finally {
      busy = false
      abortController = null
      restorePrompt()
    }
  }

  function restorePrompt(): void {
    rl.setPrompt(`${c.cyan('❯')} `)
    rl.prompt(true)
  }

  // ── line handling ───────────────────────────────────────────────────────
  rl.on('line', (line: string) => {
    if (pendingConfirm !== null) {
      const a = line.trim().toLowerCase()
      const req = pendingConfirm
      if (req.pattern !== undefined && (a === 'a' || a === 'always')) {
        req.resolve('always')
      } else if (a === 'y' || a === 'yes') {
        req.resolve('yes')
      } else if (a === '' || a === 'n' || a === 'no') {
        req.resolve('no')
      } else {
        rl.prompt(true)
        return
      }
      if (busy) spinner.start('waiting')
      return
    }

    if (busy) {
      if (line.trim() !== '') {
        queue.push(line)
        process.stdout.write(`${c.dim('⏎ queued (will steer the agent)')}\n`)
      }
      return
    }

    if (line.endsWith('\\') && !line.endsWith('\\\\')) {
      buffer += `${line.slice(0, -1)}\n`
      rl.setPrompt(`${c.dim('…')} `)
      rl.prompt(true)
      return
    }
    const input = (buffer + line).trim()
    buffer = ''
    if (input === '') {
      restorePrompt()
      return
    }
    if (input.startsWith('/')) {
      void handleCommand(input)
      return
    }
    void runTurn(input)
  })

  rl.on('SIGINT', () => {
    if (pendingConfirm !== null) {
      pendingConfirm.resolve('no')
      return
    }
    if (busy) {
      abortController?.abort()
      process.stdout.write(`\n${c.yellow('⏹ aborted')}\n`)
      return
    }
    if (buffer !== '') {
      buffer = ''
      restorePrompt()
      return
    }
    console.log(c.dim('\nbye'))
    rl.close()
    process.exit(0)
  })

  // ── slash commands ──────────────────────────────────────────────────────
  async function handleCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ')
    const name = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).slice(1).toLowerCase()
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim()

    // custom commands first (project workflows)
    const custom = customCommands.get(name)
    if (custom !== undefined) {
      const expanded = expandTemplate(custom.template, args)
      process.stdout.write(c.dim(`→ custom command /${name} (${custom.source})\n`))
      await runTurn(expanded)
      return
    }

    switch (name) {
      case 'help':
        printHelp(customCommands)
        restorePrompt()
        return
      case 'model':
        handleModel(args)
        restorePrompt()
        return
      case 'usage':
        printUsage(agent)
        restorePrompt()
        return
      case 'compact': {
        busy = true
        spinner.start('compacting')
        try {
          const done = await agent.compact(callbacks, undefined, args === '' ? undefined : args)
          if (!done) console.log(c.dim('Not enough conversation to compact yet.'))
        } finally {
          spinner.stop()
          busy = false
        }
        restorePrompt()
        return
      }
      case 'clear':
        agent = new Agent({
          cwd: opts.cwd,
          config: opts.config,
          profile: agent.profile,
          yolo: agent.yolo,
          nonInteractive: false,
          cacheDisabled: opts.cacheDisabled,
        })
        console.log(c.dim('Started a fresh session.'))
        restorePrompt()
        return
      case 'fork':
        agent = agent.fork()
        console.log(c.dim(`Forked → new session ${agent.session.id}`))
        restorePrompt()
        return
      case 'undo': {
        const undone = agent.undoLastTurn()
        if (undone.length === 0) {
          console.log(c.dim('Nothing to undo (no file edits recorded this session).'))
        } else {
          console.log(c.green(`Reverted ${undone.length} file(s):`))
          for (const f of undone) console.log(`  ${f}`)
          console.log(c.yellow('Conversation history cleared — the model no longer sees the reverted work.'))
        }
        restorePrompt()
        return
      }
      case 'resume':
        await handleResume(args)
        restorePrompt()
        return
      case 'todos':
        renderTodos(agent.todos)
        restorePrompt()
        return
      case 'set': {
        handleSet(args)
        restorePrompt()
        return
      }
      case 'yolo':
        agent.yolo = !agent.yolo
        console.log(agent.yolo ? c.yellow('⚡ yolo ON — confirmations skipped (deny rules still enforced)') : c.dim('yolo off'))
        restorePrompt()
        return
      case 'exit':
      case 'quit':
      case 'q':
        console.log(c.dim('bye'))
        rl.close()
        process.exit(0)
        return
      default:
        console.log(c.yellow(`Unknown command /${name}. Try /help.`))
        restorePrompt()
    }
  }

  function handleModel(args: string): void {
    if (args === '') {
      console.log(c.bold('Profiles:'))
      for (const [pname, profile] of Object.entries(opts.config.profiles)) {
        const marker = pname === agent.profile.profileName ? c.yellow(' ← current') : ''
        console.log(`  ${c.green(pname)} ${c.dim(`${profile.provider} · ${profile.model}`)}${marker}`)
      }
      console.log(c.dim('\nSwitch: /model <profile> or /model <profile>/<model-id>'))
      return
    }
    try {
      const resolved = resolveProfileSpec(opts.config, args)
      agent.switchProfile(resolved)
      console.log(c.green(`✓ model → ${agent.providerLabel}`))
    } catch (err) {
      console.log(c.red(err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleResume(args: string): Promise<void> {
    if (args === '') {
      const sessions = Session.listRecent(15).filter((s) => s.cwd === opts.cwd)
      if (sessions.length === 0) {
        console.log(c.dim('No sessions found for this directory.'))
        return
      }
      console.log(c.bold('Recent sessions (this directory):'))
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i]!
        const when = new Date(s.startedAt).toLocaleString()
        console.log(`  ${c.green(s.id)} ${c.dim(`${when} · ${s.turns} turns · ${s.firstUserText}`)}`)
      }
      console.log(c.dim('\nResume: /resume <id>'))
      return
    }
    const events = Session.load(args)
    if (events.length === 0) {
      console.log(c.red(`session ${args} not found`))
      return
    }
    agent = new Agent({
      cwd: opts.cwd,
      config: opts.config,
      profile: opts.profile,
      yolo: opts.yolo,
      nonInteractive: false,
      cacheDisabled: opts.cacheDisabled,
      session: new Session(args),
      resumeMessages: eventsToMessages(events),
    })
    console.log(c.green(`✓ resumed ${args} (${agent.messages.length} messages)`))
  }

  function handleSet(args: string): void {
    const parts = args.split(/\s+/)
    const key = parts[0]
    const value = parts.slice(1).join(' ')
    if (key === undefined || key === '' || value === '') {
      console.log(c.dim('Usage: /set <key> <value>   (see `savecli config list`)'))
      return
    }
    const { info, suggestions } = findConfigKey(key)
    if (!info) {
      console.log(c.red(`Unknown key "${key}"${suggestions.length > 0 ? ` — did you mean ${suggestions.join(', ')}?` : ''}`))
      return
    }
    try {
      const coerced = coerceConfigValue(info, value)
      setConfigValue(opts.config as unknown as Record<string, unknown>, info.path, coerced)
      mutateUserConfig((partial) => setConfigValue(partial, info.path, coerced))
      console.log(c.green(`✓ ${info.path} = ${JSON.stringify(coerced)}`))
    } catch (err) {
      console.log(c.red(err instanceof Error ? err.message : String(err)))
    }
  }

  restorePrompt()
}

function printHelp(custom: Map<string, { name: string; source: string; template: string }>): void {
  console.log(c.bold('Commands:'))
  const rows: Array<[string, string]> = [
    ['/help', 'show this help'],
    ['/model [spec]', 'switch model: profile | profile/model-id'],
    ['/compact [focus]', 'summarize old turns (optionally focus on X)'],
    ['/usage', 'token usage & cost: session + all-time'],
    ['/todos', 'show the current task list'],
    ['/undo', 'revert file edits from the last turn'],
    ['/fork', 'branch this conversation into a new session'],
    ['/resume [id]', 'list/resume sessions in this directory'],
    ['/clear', 'start a fresh conversation'],
    ['/set <key> <value>', 'change a setting (same as savecli config set)'],
    ['/yolo', 'toggle confirmation skipping'],
    ['/exit', 'quit'],
  ]
  for (const [cmd, desc] of rows) {
    console.log(`  ${c.green(cmd.padEnd(22))} ${c.dim(desc)}`)
  }
  if (custom.size > 0) {
    console.log(c.bold('\nCustom commands:'))
    for (const cmd of custom.values()) {
      console.log(`  ${c.green(`/${cmd.name}`.padEnd(22))} ${c.dim(`(${cmd.source})`)} ${c.dim(firstLineOf(cmd.template))}`)
    }
  }
  console.log(c.dim('\nLines ending with \\ continue. Input during a running turn steers the agent.'))
}

function printUsage(agent: Agent): void {
  const u = agent.usage
  console.log(c.bold('This session:'))
  console.log(`  input: ${formatNumber(u.input)} · output: ${formatNumber(u.output)} · cache-read: ${formatNumber(u.cacheRead ?? 0)}`)
  const s = summarizeUsage()
  console.log(c.bold('\nAll-time:'))
  console.log(
    `  requests: ${s.allTime.requests} · input: ${formatNumber(s.allTime.input)} · output: ${formatNumber(s.allTime.output)} · cost: ~$${s.allTime.costUsd.toFixed(4)}`,
  )
  console.log(
    c.green(`  ⚡ cache hits: ${s.cacheHits} (≈${formatNumber(s.cacheSavedTokens)} tokens saved)`),
  )
  if (s.byModel.length > 0) {
    console.log(c.bold('\nBy model:'))
    for (const m of s.byModel.slice(0, 8)) {
      console.log(`  ${c.green(m.model.padEnd(34))} ${formatNumber(m.input)} in / ${formatNumber(m.output)} out`)
    }
  }
}

function renderTodos(todos: Array<{ content: string; status: string }>): void {
  if (todos.length === 0) return
  const marks: Record<string, string> = { pending: ' ', in_progress: '▸', completed: '✓', cancelled: '×' }
  const colors: Record<string, (s: string) => string> = {
    pending: c.dim,
    in_progress: c.cyan,
    completed: c.green,
    cancelled: c.red,
  }
  process.stdout.write('\n')
  for (const t of todos) {
    const mark = marks[t.status] ?? ' '
    const color = colors[t.status] ?? c.dim
    process.stdout.write(`${color(`[${mark}] ${t.content}`)}\n`)
  }
  process.stdout.write('\n')
}

function firstLineOf(s: string): string {
  return (s.split('\n')[0] ?? '').slice(0, 60)
}
