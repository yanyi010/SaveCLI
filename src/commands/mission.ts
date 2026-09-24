/**
 * `savecli mission …` — long-running autonomous work (Driver layer).
 *   mission start "<objective>" [--criteria "a;b"] [--budget-tokens N] …
 *   mission list / status <id> / resume <id> / pause <id>
 */
import { loadConfig, resolveProfileSpec, type Config, type ResolvedProfile } from '../config.js'
import { MissionDriver } from '../mission/driver.js'
import { listMissions, loadMission, saveMission } from '../mission/store.js'
import { defaultBudget, newMissionId, recordEvent, type Mission } from '../mission/types.js'
import { c } from '../ui/colors.js'
import { Spinner } from '../ui/spinner.js'
import { parseFlags } from './auth.js'
import { estimateCostUsd } from '../agent/usage.js'

export async function cmdMission(args: string[]): Promise<number> {
  const sub = args[0] ?? 'list'

  switch (sub) {
    case 'start':
      return cmdMissionStart(args.slice(1))
    case 'list':
      return cmdMissionList()
    case 'status': {
      const id = args[1]
      if (id === undefined) {
        console.error(c.red('Usage: savecli mission status <id>'))
        return 1
      }
      return cmdMissionStatus(id)
    }
    case 'resume': {
      const id = args[1]
      if (id === undefined) {
        console.error(c.red('Usage: savecli mission resume <id>'))
        return 1
      }
      return await cmdMissionResume(id, args.slice(2))
    }
    case 'pause': {
      const id = args[1]
      const mission = id !== undefined ? loadMission(id) : undefined
      if (mission === undefined) {
        console.error(c.red(`mission ${id} not found`))
        return 1
      }
      mission.status = 'paused'
      recordEvent(mission, 'paused', 'paused by user')
      saveMission(mission)
      console.log(c.green(`✓ mission ${id} paused — resume with: savecli mission resume ${id}`))
      return 0
    }
    default:
      console.error(c.red(`Unknown mission subcommand "${sub}". Use start, list, status, resume, pause.`))
      return 1
  }
}

async function cmdMissionStart(args: string[]): Promise<number> {
  const positional: string[] = []
  for (const a of args) {
    if (!a.startsWith('--')) positional.push(a)
  }
  const flags = parseFlags(args.filter((a) => a.startsWith('--')))
  const objective = positional.join(' ').trim()
  if (objective === '') {
    console.error(c.red('Usage: savecli mission start "<objective>" [--criteria "a;b;c"] [flags]'))
    console.error(c.dim('Flags: --criteria, --budget-tokens, --max-tasks, --max-hours, --autonomy cautious|pragmatic|autonomous, --model <spec>, --yolo'))
    return 1
  }

  const cwd = process.cwd()
  const { config } = loadConfig(cwd)
  let profile: ResolvedProfile
  try {
    profile = resolveProfileSpec(config, typeof flags['model'] === 'string' ? flags['model'] : undefined)
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)))
    return 1
  }

  const criteria =
    typeof flags['criteria'] === 'string'
      ? flags['criteria'].split(';').map((s) => s.trim()).filter((s) => s !== '')
      : []

  const budget = defaultBudget()
  if (typeof flags['budget-tokens'] === 'string' && Number.isFinite(Number(flags['budget-tokens']))) {
    budget.maxTokens = Number(flags['budget-tokens'])
  }
  if (typeof flags['max-tasks'] === 'string' && Number.isFinite(Number(flags['max-tasks']))) {
    budget.maxTasks = Number(flags['max-tasks'])
  }
  if (typeof flags['max-hours'] === 'string' && Number.isFinite(Number(flags['max-hours']))) {
    budget.maxHours = Number(flags['max-hours'])
  }
  const autonomyRaw = typeof flags['autonomy'] === 'string' ? flags['autonomy'] : 'pragmatic'
  if (!['cautious', 'pragmatic', 'autonomous'].includes(autonomyRaw)) {
    console.error(c.red('--autonomy must be cautious, pragmatic or autonomous'))
    return 1
  }

  const mission: Mission = {
    version: 1,
    id: newMissionId(),
    objective,
    acceptanceCriteria: criteria,
    cwd,
    profileName: profile.profileName,
    model: profile.model,
    autonomy: autonomyRaw as Mission['autonomy'],
    status: 'planning',
    tasks: [],
    currentTaskIndex: -1,
    lessons: [],
    budget,
    spentTokens: 0,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  recordEvent(mission, 'planned', `mission created: ${objective.slice(0, 120)}`)
  saveMission(mission)

  console.log(c.green(`✓ mission ${mission.id} created`))
  console.log(c.dim(`  objective: ${objective}`))
  if (criteria.length > 0) criteria.forEach((cr) => console.log(c.dim(`  criterion: ${cr}`)))
  console.log(c.dim(`  budgets: ${budget.maxTokens} tokens · ${budget.maxTasks} tasks · ${budget.maxHours}h · ${budget.maxAttemptsPerTask} attempts/task`))
  console.log()
  return await runDriver(mission, config, { yolo: flags['yolo'] === true })
}

function cmdMissionList(): number {
  const missions = listMissions(20)
  if (missions.length === 0) {
    console.log(c.dim('No missions. Start one: savecli mission start "<objective>"'))
    return 0
  }
  console.log(c.bold('Missions:\n'))
  for (const m of missions) {
    const done = m.tasks.filter((t) => t.status === 'done').length
    const cost = estimateCostUsd(m.model, { input: m.spentTokens, output: 0 })
    console.log(
      `  ${c.green(m.id)}  ${statusColor(m.status)(m.status.padEnd(9))}  ${done}/${m.tasks.length} tasks · ${m.spentTokens} tok${cost !== undefined && m.spentTokens > 0 ? ` · ~$${cost.toFixed(2)}` : ''}`,
    )
    console.log(c.dim(`    ${m.objective.slice(0, 100)}`))
  }
  return 0
}

function cmdMissionStatus(id: string): number {
  const m = loadMission(id)
  if (m === undefined) {
    console.error(c.red(`mission ${id} not found`))
    return 1
  }
  console.log(c.bold(`Mission ${m.id}`))
  console.log(`  objective:  ${m.objective}`)
  console.log(`  status:     ${statusColor(m.status)(m.status)}`)
  console.log(`  model:      ${m.profileName}/${m.model}`)
  console.log(`  autonomy:   ${m.autonomy}`)
  console.log(`  progress:   ${m.tasks.filter((t) => t.status === 'done').length}/${m.tasks.length} tasks · ${m.spentTokens} tokens`)
  if (m.acceptanceCriteria.length > 0) {
    console.log('  criteria:')
    m.acceptanceCriteria.forEach((cr) => console.log(`    - ${cr}`))
  }
  if (m.tasks.length > 0) {
    console.log('  tasks:')
    for (const t of m.tasks) {
      const mark = t.status === 'done' ? c.green('✓') : t.status === 'in_progress' ? c.cyan('▸') : t.status === 'blocked' ? c.red('⊘') : c.dim('·')
      console.log(`    ${mark} ${t.title} ${c.dim(`(${t.status}, attempts: ${t.attempts})`)}`)
    }
  }
  if (m.lessons.length > 0) {
    console.log('  lessons:')
    m.lessons.forEach((l) => console.log(c.dim(`    - ${l.slice(0, 140)}`)))
  }
  if (m.finalReport !== undefined) {
    console.log(`  final report: ${m.finalReport}`)
  }
  const recent = m.history.slice(-8)
  if (recent.length > 0) {
    console.log('  recent events:')
    for (const ev of recent) {
      console.log(c.dim(`    ${new Date(ev.ts).toLocaleTimeString()} ${ev.event}: ${ev.detail.slice(0, 110)}`))
    }
  }
  return 0
}

async function cmdMissionResume(id: string, args: string[]): Promise<number> {
  const m = loadMission(id)
  if (m === undefined) {
    console.error(c.red(`mission ${id} not found`))
    return 1
  }
  if (m.status === 'done') {
    console.log(c.dim('Mission is already done. Final report:'))
    console.log(m.finalReport ?? '')
    return 0
  }
  const flags = parseFlags(args.filter((a) => a.startsWith('--')))
  const cwd = process.cwd()
  const { config } = loadConfig(cwd)
  // Resume uses the mission's own profile for continuity.
  const profile = resolveProfileSpec(config, m.profileName)
  const driverMission = { ...m, cwd: m.cwd }
  return await runDriver(driverMission, config, { yolo: flags['yolo'] === true, profile })
}

async function runDriver(
  mission: Mission,
  config: Config,
  opts: { yolo?: boolean; profile?: ResolvedProfile },
): Promise<number> {
  const { resolveProfileSpec } = await import('../config.js')
  const profile =
    opts.profile ??
    resolveProfileSpec(config, mission.profileName)

  const spinner = new Spinner(process.stderr.isTTY === true)
  const abort = new AbortController()
  let lastPhase = ''
  process.on('SIGINT', () => {
    if (!abort.signal.aborted) {
      console.log(c.yellow('\n⏹ pausing mission (state saved)…'))
      abort.abort()
    } else {
      process.exit(130)
    }
  })

  const driver = new MissionDriver(mission, config, profile, { yolo: opts.yolo })
  const finalMission = await driver.run({
    signal: abort.signal,
    events: {
      onPhase: (phase, detail) => {
        lastPhase = detail
        spinner.start(`${c.dim(phase)} ${detail.slice(0, 60)}`)
      },
      onTaskStart: (task, attempt) => {
        spinner.stop()
        console.log(`${c.cyan('▸')} ${c.bold(task.title)} ${c.dim(`(attempt ${attempt})`)}`)
      },
      onTaskVerdict: (task, verdict, notes) => {
        spinner.stop()
        const mark = verdict === 'pass' ? c.green('✓') : verdict === 'blocked' ? c.red('⊘') : c.yellow('↻')
        console.log(`  ${mark} ${verdict} ${c.dim(notes.slice(0, 160))}`)
      },
      onLesson: (lesson) => {
        console.log(`  ${c.magenta('★ lesson:')} ${c.dim(lesson.slice(0, 160))}`)
      },
    },
  })
  spinner.stop()

  console.log()
  const status = finalMission.status
  if (status === 'done') {
    console.log(c.green(c.bold(`✓ Mission complete — ${finalMission.tasks.filter((t) => t.status === 'done').length} tasks`)))
    console.log(finalMission.finalReport ?? '')
    return 0
  }
  if (status === 'blocked') {
    console.log(c.red(c.bold('⊘ Mission blocked — needs a human decision:')))
    const last = finalMission.history.filter((e) => e.event === 'task-blocked').at(-1)
    console.log(c.yellow(`  ${last?.detail ?? 'unknown blocker'}`))
    console.log(c.dim('  Inspect: savecli mission status ' + finalMission.id))
    return 2
  }
  console.log(c.yellow(`⏸ Mission paused (${status}). Resume with: savecli mission resume ${finalMission.id}`))
  void lastPhase
  return 0
}

function statusColor(status: Mission['status']): (s: string) => string {
  switch (status) {
    case 'done':
      return c.green
    case 'blocked':
    case 'failed':
      return c.red
    case 'paused':
      return c.yellow
    default:
      return c.cyan
  }
}
