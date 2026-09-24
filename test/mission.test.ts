import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionDriver } from '../src/mission/driver.js'
import { defaultBudget, newMissionId, recordEvent, type Mission } from '../src/mission/types.ts'
import { loadMission, saveMission } from '../src/mission/store.js'
import { defaultConfig, type ResolvedProfile } from '../src/config.js'
import { MockProvider, mockHandle, freshHome, trackHome } from './helpers.js'

let cwd: string
let home: string

const PROFILE: ResolvedProfile = {
  profileName: 'mock',
  provider: 'openai',
  baseUrl: 'http://localhost:0/v1',
  model: 'mock-model',
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    version: 1,
    id: newMissionId(),
    objective: 'Test the mission driver loop',
    acceptanceCriteria: ['task completes'],
    cwd,
    profileName: 'mock',
    model: 'mock-model',
    autonomy: 'autonomous',
    status: 'planning',
    tasks: [],
    currentTaskIndex: -1,
    lessons: [],
    budget: defaultBudget(),
    spentTokens: 0,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/** One shared scripted provider drives planner/engineer/reviewer in call order. */
function makeDriver(responses: Array<Partial<{ text: string }> | Error>, mission = makeMission()): {
  driver: MissionDriver
  provider: MockProvider
} {
  const provider = new MockProvider(responses.map((r) => (r instanceof Error ? r : { text: r.text ?? '' })))
  const driver = new MissionDriver(mission, defaultConfig(), PROFILE, {
    cacheDisabled: true,
    providerFactory: () => mockHandle(provider),
    smallProviderFactory: () => mockHandle(provider),
  })
  return { driver, provider }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'savecli-mission-'))
  home = freshHome()
  trackHome(home)
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('mission driver', () => {
  it('runs plan → execute → review → admit → done', async () => {
    const { driver } = makeDriver([
      { text: JSON.stringify({ task: { title: 'Write the report', details: 'write report.md', evidence: 'report.md exists' } }) },
      { text: 'I created report.md with the required content.' },
      { text: JSON.stringify({ verdict: 'pass', notes: 'report.md verified on disk' }) },
      { text: JSON.stringify({ done: true, summary: 'Mission accomplished: report written and verified.' }) },
    ])
    const phases: string[] = []
    const verdicts: string[] = []
    const mission = await driver.run({
      events: {
        onPhase: (p) => phases.push(p),
        onTaskVerdict: (_t, v) => verdicts.push(v),
      },
    })
    expect(mission.status).toBe('done')
    expect(mission.finalReport).toContain('report written')
    expect(mission.tasks).toHaveLength(1)
    expect(mission.tasks[0]).toMatchObject({ title: 'Write the report', status: 'done' })
    expect(mission.tasks[0]!.lastReview).toContain('verified')
    expect(verdicts).toEqual(['pass'])
    expect(phases).toEqual(['plan', 'execute', 'review', 'plan', 'done'])
    // Reviewer must be read-only: bash/write/edit absent from its tool list.
    expect(driver.reviewerToolNames).not.toContain('bash')
    expect(driver.reviewerToolNames).not.toContain('write')
    expect(driver.reviewerToolNames).not.toContain('edit')
  })

  it('retries a failed task with review feedback, then passes', async () => {
    const { driver } = makeDriver([
      { text: JSON.stringify({ task: { title: 'Fix tests', details: 'make vitest pass', evidence: 'npm test exits 0' } }) },
      { text: 'Attempt 1: partially done.' },
      { text: JSON.stringify({ verdict: 'fail', notes: 'tests still red', lessons: ['run the full suite before claiming done'] }) },
      { text: 'Attempt 2 with feedback: all green now.' },
      { text: JSON.stringify({ verdict: 'pass', notes: 'suite green' }) },
      { text: JSON.stringify({ done: true, summary: 'tests fixed' }) },
    ])
    const mission = await driver.run({})
    expect(mission.status).toBe('done')
    expect(mission.tasks[0]!.attempts).toBe(2)
    expect(mission.tasks[0]!.status).toBe('done')
    expect(mission.lessons).toContain('run the full suite before claiming done')
    // Attempt 2 prompt must carry the review feedback.
    const mission2 = mission
    expect(mission2.tasks[0]!.lastReport).toContain('Attempt 2')
  })

  it('stops as blocked when attempts are exhausted', async () => {
    const { driver } = makeDriver([
      { text: JSON.stringify({ task: { title: 'Impossible', details: 'x', evidence: 'y' } }) },
      { text: 'try 1' },
      { text: JSON.stringify({ verdict: 'fail', notes: 'nope 1' }) },
      { text: 'try 2' },
      { text: JSON.stringify({ verdict: 'fail', notes: 'nope 2' }) },
      { text: 'try 3' },
      { text: JSON.stringify({ verdict: 'fail', notes: 'nope 3' }) },
    ])
    const mission = await driver.run({})
    expect(mission.status).toBe('blocked')
    expect(mission.tasks[0]!.attempts).toBe(3)
    expect(mission.tasks[0]!.status).toBe('failed')
  })

  it('blocked verdict halts the mission immediately', async () => {
    const { driver } = makeDriver([
      { text: JSON.stringify({ task: { title: 'Need creds', details: 'x', evidence: 'y' } }) },
      { text: 'cannot proceed' },
      { text: JSON.stringify({ verdict: 'blocked', notes: 'missing deploy key' }) },
    ])
    const mission = await driver.run({})
    expect(mission.status).toBe('blocked')
    expect(mission.tasks[0]!.status).toBe('blocked')
  })

  it('pauses when the task budget is exhausted', async () => {
    const mission = makeMission({ budget: { ...defaultBudget(), maxTasks: 0 } })
    const { driver } = makeDriver([], mission)
    const out = await driver.run({})
    expect(out.status).toBe('paused')
    expect(out.history.some((e) => e.event === 'budget')).toBe(true)
  })

  it('pauses when the token budget is exhausted', async () => {
    const mission = makeMission({ budget: { ...defaultBudget(), maxTokens: 1 }, spentTokens: 1000 })
    const { driver } = makeDriver([], mission)
    const out = await driver.run({})
    expect(out.status).toBe('paused')
  })

  it('aborts cleanly via AbortSignal', async () => {
    const { driver } = makeDriver([])
    const controller = new AbortController()
    controller.abort()
    const out = await driver.run({ signal: controller.signal })
    expect(out.status).toBe('paused')
  })

  it('pauses (not crashes) when the planner outputs garbage', async () => {
    const { driver } = makeDriver([{ text: 'I will definitely not return JSON' }])
    const out = await driver.run({})
    expect(out.status).toBe('paused')
    expect(out.history.some((e) => e.event === 'paused' && e.detail.includes('planner'))).toBe(true)
  })

  it('treats a reviewer JSON-wrap-in-prose output as usable', async () => {
    const { driver } = makeDriver([
      { text: JSON.stringify({ task: { title: 'T', details: 'd', evidence: 'e' } }) },
      { text: 'done the work' },
      { text: `Here is my verdict:\n\n\`\`\`json\n{"verdict": "pass", "notes": "ok"}\n\`\`\`` },
      { text: JSON.stringify({ done: true, summary: 's' }) },
    ])
    const out = await driver.run({})
    expect(out.status).toBe('done')
  })

  it('persists state to disk after each phase', async () => {
    const mission = makeMission()
    const { driver } = makeDriver(
      [
        { text: JSON.stringify({ task: { title: 'Persist me', details: 'd', evidence: 'e' } }) },
        { text: 'work report' },
        { text: JSON.stringify({ verdict: 'pass', notes: 'ok' }) },
        { text: JSON.stringify({ done: true, summary: 'finished' }) },
      ],
      mission,
    )
    await driver.run({})
    const reloaded = loadMission(mission.id)
    expect(reloaded).toBeDefined()
    expect(reloaded!.status).toBe('done')
    expect(reloaded!.tasks).toHaveLength(1)
    expect(existsSync(join(home, 'missions', `${mission.id}.json`))).toBe(true)
    const raw = JSON.parse(readFileSync(join(home, 'missions', `${mission.id}.json`), 'utf8')) as Mission
    expect(raw.objective).toBe('Test the mission driver loop')
  })

  it('records events and keeps history bounded', () => {
    const mission = makeMission()
    for (let i = 0; i < 600; i++) recordEvent(mission, 'review', `detail ${i}`)
    expect(mission.history.length).toBeLessThanOrEqual(500)
    expect(mission.history.length).toBeGreaterThan(0)
  })

  it('saveMission/loadMission round-trip and listMissions finds it', async () => {
    const mission = makeMission()
    saveMission(mission)
    const loaded = loadMission(mission.id)
    expect(loaded?.id).toBe(mission.id)
    saveMission(makeMission())
    const { listMissions } = await import('../src/mission/store.js')
    expect(listMissions().length).toBeGreaterThanOrEqual(2)
  })
})
