/**
 * Mission state — the Driver layer's persistent brain.
 * Lives outside any conversation, so compaction can never drift the goal.
 */
import { randomBytes } from 'node:crypto'

export type MissionStatus =
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'paused'
  | 'blocked'
  | 'done'
  | 'failed'

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked'

export interface MissionTask {
  id: string
  title: string
  details: string
  /** What artifact or command output proves completion. */
  evidence: string
  status: TaskStatus
  attempts: number
  /** Engineer report from the last attempt. */
  lastReport?: string
  /** Reviewer verdict notes from the last attempt. */
  lastReview?: string
  createdAt: number
  completedAt?: number
}

export interface MissionBudget {
  maxTokens: number
  maxTasks: number
  maxHours: number
  maxAttemptsPerTask: number
}

export interface MissionEvent {
  ts: number
  event: 'planned' | 'task-start' | 'task-done' | 'task-failed' | 'task-blocked' | 'review' | 'lesson' | 'paused' | 'resumed' | 'done' | 'failed' | 'budget'
  detail: string
}

export interface Mission {
  version: 1
  id: string
  objective: string
  acceptanceCriteria: string[]
  cwd: string
  profileName: string
  model: string
  autonomy: 'cautious' | 'pragmatic' | 'autonomous'
  status: MissionStatus
  tasks: MissionTask[]
  currentTaskIndex: number
  lessons: string[]
  budget: MissionBudget
  spentTokens: number
  history: MissionEvent[]
  finalReport?: string
  createdAt: number
  updatedAt: number
}

export function newMissionId(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `m${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${randomBytes(2).toString('hex')}`
}

export function defaultBudget(): MissionBudget {
  return { maxTokens: 2_000_000, maxTasks: 30, maxHours: 8, maxAttemptsPerTask: 3 }
}

export function recordEvent(mission: Mission, event: MissionEvent['event'], detail: string): void {
  mission.history.push({ ts: Date.now(), event, detail })
  // Keep the journal bounded — old detail text has diminishing value.
  if (mission.history.length > 500) {
    mission.history = mission.history.filter((e) => e.event !== 'task-start' && e.event !== 'review').concat(
      mission.history.filter((e) => e.event === 'task-start' || e.event === 'review').slice(-200),
    )
  }
  mission.updatedAt = Date.now()
}

export function missionBrief(mission: Mission): string {
  const done = mission.tasks.filter((t) => t.status === 'done').length
  const lines: string[] = []
  lines.push(`Mission: ${mission.objective}`)
  if (mission.acceptanceCriteria.length > 0) {
    lines.push('Acceptance criteria:')
    for (const crit of mission.acceptanceCriteria) lines.push(`- ${crit}`)
  }
  lines.push(`Progress: ${done}/${mission.tasks.length} tasks done · ${mission.spentTokens} tokens spent`)
  if (mission.lessons.length > 0) {
    lines.push('Lessons so far:')
    for (const l of mission.lessons.slice(-10)) lines.push(`- ${l}`)
  }
  return lines.join('\n')
}
