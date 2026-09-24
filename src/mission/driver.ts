/**
 * The Mission Driver: a deterministic loop that keeps an
 * agent working for hours. Mechanics are guaranteed by code — budgets,
 * persistence, role separation — while judgment stays with the model.
 *
 * Loop: plan (Planner, small model) → execute (Engineer, main model, fresh
 * context per task) → review (Reviewer, main model, READ-ONLY tools) → admit.
 * The Engineer can never declare its own work complete; the Reviewer can
 * never edit. Irreversible actions still go through the permission gates.
 */
import { type Config, type ResolvedProfile } from '../config.js'
import { createProvider, createSmallProvider, type ProviderHandle } from '../providers/index.js'
import type { Usage } from '../providers/types.js'
import { Agent } from '../agent/loop.js'
import { grepTool, globTool, readTool, treeTool, toolSpecs } from '../tools/index.js'
import type { Tool } from '../tools/types.js'
import { estimateCostUsd } from '../agent/usage.js'
import { engineerSystemPrompt, parseJsonOutput, PLANNER_SYSTEM, REVIEWER_SYSTEM } from './prompts.js'
import { missionBrief, recordEvent, type Mission, type MissionTask } from './types.js'
import { saveMission } from './store.js'
import { log } from '../util/log.js'

export interface DriverEvents {
  onPhase?: (phase: 'plan' | 'execute' | 'review' | 'admit' | 'budget' | 'done', detail: string) => void
  onTaskStart?: (task: MissionTask, attempt: number) => void
  onTaskVerdict?: (task: MissionTask, verdict: 'pass' | 'fail' | 'blocked', notes: string) => void
  onLesson?: (lesson: string) => void
}

export interface RunOptions {
  signal?: AbortSignal
  events?: DriverEvents
  /** Called between tasks; return false to pause the mission. */
  shouldContinue?: () => boolean
}

const REVIEWER_TOOLS: Tool[] = [readTool, grepTool, globTool, treeTool]

export class MissionDriver {
  constructor(
    readonly mission: Mission,
    private readonly config: Config,
    private readonly profile: ResolvedProfile,
    private readonly opts: {
      yolo?: boolean
      cacheDisabled?: boolean
      /** Test seam: inject providers (planner/engineer/reviewer). */
      providerFactory?: (profile: ResolvedProfile) => ProviderHandle
      smallProviderFactory?: (profile: ResolvedProfile) => ProviderHandle
    } = {},
  ) {}

  /** Run the mission until done/blocked/budget/abort. Persists every step. */
  async run(runOpts: RunOptions): Promise<Mission> {
    const m = this.mission
    recordEvent(m, 'resumed', `status=${m.status}`)
    m.status = 'planning'
    saveMission(m)

     
    while (true) {
      if (runOpts.signal?.aborted) {
        m.status = 'paused'
        recordEvent(m, 'paused', 'aborted by user (Ctrl-C); resume with `savecli mission resume`')
        saveMission(m)
        return m
      }
      if (runOpts.shouldContinue?.() === false) {
        m.status = 'paused'
        recordEvent(m, 'paused', 'paused by callback')
        saveMission(m)
        return m
      }
      if (!this.checkBudget()) {
        m.status = 'paused'
        saveMission(m)
        return m
      }

      // ── 1. PLAN: what is the next task? ─────────────────────────────────
      runOpts.events?.onPhase?.('plan', 'asking the Planner for the next task')
      const plan = await this.planNextTask(runOpts.signal)
      if (plan === undefined) {
        // Planner unreachable/invalid — do not burn budget silently.
        m.status = 'paused'
        recordEvent(m, 'paused', 'planner produced no usable output; check model/config')
        saveMission(m)
        return m
      }
      if (plan.done === true) {
        m.status = 'done'
        m.finalReport = plan.summary ?? 'Mission complete.'
        recordEvent(m, 'done', m.finalReport)
        saveMission(m)
        runOpts.events?.onPhase?.('done', m.finalReport)
        return m
      }
      const task: MissionTask = {
        id: `t${m.tasks.length + 1}`,
        title: plan.task?.title ?? 'untitled task',
        details: plan.task?.details ?? '',
        evidence: plan.task?.evidence ?? 'not specified',
        status: 'in_progress',
        attempts: 1,
        createdAt: Date.now(),
      }
      m.tasks.push(task)
      m.currentTaskIndex = m.tasks.length - 1
      recordEvent(m, 'planned', `${task.id}: ${task.title}`)
      saveMission(m)

      // ── 2. EXECUTE with retries ─────────────────────────────────────────
      let verdict: 'pass' | 'fail' | 'blocked' = 'fail'
      let reviewNotes = ''
      while (task.attempts <= m.budget.maxAttemptsPerTask) {
        if (runOpts.signal?.aborted) break
        runOpts.events?.onPhase?.('execute', `${task.id}: ${task.title} (attempt ${task.attempts})`)
        runOpts.events?.onTaskStart?.(task, task.attempts)
        const engineerReport = await this.executeTask(task, runOpts.signal)
        task.lastReport = engineerReport.slice(0, 4_000)
        saveMission(m)

        // ── 3. REVIEW (read-only) ────────────────────────────────────────
        runOpts.events?.onPhase?.('review', `${task.id} attempt ${task.attempts}`)
        const review = await this.reviewTask(task, engineerReport, runOpts.signal)
        if (review === undefined) {
          reviewNotes = 'reviewer produced no usable verdict; treating as fail'
          verdict = 'fail'
        } else {
          verdict = review.verdict
          reviewNotes = review.notes ?? ''
          for (const lesson of review.lessons ?? []) {
            if (typeof lesson === 'string' && lesson !== '' && !m.lessons.includes(lesson)) {
              m.lessons.push(lesson)
              runOpts.events?.onLesson?.(lesson)
            }
          }
        }
        task.lastReview = reviewNotes.slice(0, 2_000)
        recordEvent(m, 'review', `${task.id} attempt ${task.attempts}: ${verdict} — ${reviewNotes.slice(0, 200)}`)
        saveMission(m)
        runOpts.events?.onTaskVerdict?.(task, verdict, reviewNotes)
        if (verdict !== 'fail') break
        if (task.attempts >= m.budget.maxAttemptsPerTask) break
        task.attempts++
        recordEvent(m, 'task-failed', `${task.id} attempt ${task.attempts - 1} rejected; retrying with review feedback`)
        saveMission(m)
      }

      // ── 4. ADMIT ────────────────────────────────────────────────────────
      if (verdict === 'pass') {
        task.status = 'done'
        task.completedAt = Date.now()
        recordEvent(m, 'task-done', `${task.id}: ${task.title}`)
      } else if (verdict === 'blocked') {
        task.status = 'blocked'
        m.status = 'blocked'
        recordEvent(m, 'task-blocked', `${task.id}: ${reviewNotes.slice(0, 300)}`)
        saveMission(m)
        return m
      } else {
        task.status = 'failed'
        m.status = 'blocked'
        recordEvent(m, 'task-blocked', `${task.id}: exhausted ${m.budget.maxAttemptsPerTask} attempts — ${reviewNotes.slice(0, 300)}`)
        saveMission(m)
        return m
      }
      saveMission(m)
      // Loop continues: next planning round with updated state.
    }
  }

  private checkBudget(): boolean {
    const m = this.mission
    const hours = (Date.now() - m.createdAt) / 3_600_000
    if (m.spentTokens > m.budget.maxTokens) {
      recordEvent(m, 'budget', `token budget exhausted: ${m.spentTokens} > ${m.budget.maxTokens}`)
      this.emitBudget(`token budget exhausted (${m.spentTokens} / ${m.budget.maxTokens})`)
      return false
    }
    if (m.tasks.length >= m.budget.maxTasks) {
      recordEvent(m, 'budget', `task budget exhausted: ${m.tasks.length} tasks`)
      this.emitBudget(`task budget exhausted (${m.tasks.length} / ${m.budget.maxTasks})`)
      return false
    }
    if (hours > m.budget.maxHours) {
      recordEvent(m, 'budget', `time budget exhausted: ${hours.toFixed(1)}h`)
      this.emitBudget(`time budget exhausted (${hours.toFixed(1)}h / ${m.budget.maxHours}h)`)
      return false
    }
    return true
  }

  private emitBudget(detail: string): void {
    log.warn('mission', detail)
  }

  private async planNextTask(signal?: AbortSignal): Promise<PlanOutput | undefined> {
    const m = this.mission
    const handle = this.opts.smallProviderFactory
      ? this.opts.smallProviderFactory(this.profile)
      : createSmallProvider(this.profile, { promptCaching: false })
    const history = m.tasks
      .map((t) => `- [${t.status}] ${t.title}${t.lastReview !== undefined && t.status === 'done' ? '' : ''}`)
      .join('\n')
    const prompt = [
      missionBrief(m),
      '',
      '# Task history',
      history === '' ? '(none yet — this is the first task)' : history,
      '',
      'Output the next task as strict JSON now.',
    ].join('\n')

    const result = await this.completeQuiet(handle.provider.complete.bind(handle.provider), {
      system: PLANNER_SYSTEM,
      prompt,
      signal,
    })
    if (result === undefined) return undefined
    const plan = parseJsonOutput<PlanOutput>(result)
    if (plan === undefined || (plan.done !== true && (plan.task === undefined || typeof plan.task.title !== 'string'))) {
      log.warn('mission', 'planner output was not usable JSON')
      return undefined
    }
    return plan
  }

  private async executeTask(task: MissionTask, signal?: AbortSignal): Promise<string> {
    const m = this.mission
    const agent = new Agent({
      cwd: m.cwd,
      config: this.config,
      profile: this.profile,
      yolo: this.opts.yolo || m.autonomy === 'autonomous',
      nonInteractive: true,
      cacheDisabled: this.opts.cacheDisabled,
      systemPrompt: engineerSystemPrompt(missionBrief(m), task, task.attempts, task.lastReview),
      providerFactory: this.opts.providerFactory,
    })
    const prompt = `Execute task ${task.id}: ${task.title}`
    const result = await agent.send(
      prompt,
      {
        onNotice: (msg) => log.debug('mission', `engineer: ${msg}`),
      },
      signal,
    )
    this.addUsage(result.usage)
    if (!result.ok && result.error !== undefined) {
      return `ENGINEER ERROR: ${result.error}\n\nPartial work report:\n${result.text}`
    }
    return result.text
  }

  private async reviewTask(task: MissionTask, engineerReport: string, signal?: AbortSignal): Promise<ReviewOutput | undefined> {
    const m = this.mission
    const agent = new Agent({
      cwd: m.cwd,
      config: this.config,
      profile: this.profile,
      nonInteractive: true,
      cacheDisabled: this.opts.cacheDisabled,
      tools: REVIEWER_TOOLS,
      systemPrompt: REVIEWER_SYSTEM,
      providerFactory: this.opts.providerFactory,
    })
    const prompt = [
      `Verify task ${task.id}: ${task.title}`,
      `# Task details\n${task.details}`,
      `# Required evidence\n${task.evidence}`,
      `# Engineer's report\n${engineerReport}`,
      '',
      'Verify the evidence yourself with the read-only tools, then output the verdict JSON.',
    ].join('\n')
    const result = await agent.send(prompt, {}, signal)
    this.addUsage(result.usage)
    const review = parseJsonOutput<ReviewOutput>(result.text)
    if (review === undefined || !['pass', 'fail', 'blocked'].includes(review.verdict ?? '')) {
      log.warn('mission', 'reviewer output was not usable JSON')
      return undefined
    }
    return review
  }

  private addUsage(u: Usage): void {
    this.mission.spentTokens += u.input + u.output
  }

  /** Non-streaming completion with error tolerance (used by the Planner). */
  private async completeQuiet(
    complete: (req: {
      system: string
      messages: Array<{ role: 'user'; blocks: Array<{ type: 'text'; text: string }> }>
      tools: []
      signal?: AbortSignal
    }) => Promise<{ blocks: Array<{ type: string; text?: string }>; usage: Usage }>,
    args: { system: string; prompt: string; signal?: AbortSignal },
  ): Promise<string | undefined> {
    try {
      const result = await complete({
        system: args.system,
        messages: [{ role: 'user', blocks: [{ type: 'text', text: args.prompt }] }],
        tools: [],
        signal: args.signal,
      })
      this.addUsage(result.usage)
      return result.blocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
    } catch (err) {
      log.warn('mission', `completion failed: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
  }

  get estimatedCostUsd(): number | undefined {
    return estimateCostUsd(this.mission.model, { input: this.mission.spentTokens, output: 0 })
  }

  get reviewerToolNames(): string[] {
    return toolSpecs(REVIEWER_TOOLS).map((t) => t.name)
  }
}

interface PlanOutput {
  done?: boolean
  summary?: string
  task?: { title: string; details?: string; evidence?: string }
}

interface ReviewOutput {
  verdict: 'pass' | 'fail' | 'blocked'
  notes?: string
  lessons?: string[]
  report?: string
}

export { createProvider }
