/** Mission persistence: atomic JSON files under ~/.savecli/missions. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS, savecliHome } from '../constants.js'
import { readJsonFile, writePrivateFile } from '../util/fsx.js'
import { log } from '../util/log.js'
import type { Mission } from './types.js'

export function missionsDir(): string {
  return join(savecliHome(), 'missions')
}

export function missionPath(id: string): string {
  return join(missionsDir(), `${id}.json`)
}

export function loadMission(id: string): Mission | undefined {
  const mission = readJsonFile<Mission>(missionPath(id))
  if (!mission || mission.version !== 1 || !Array.isArray(mission.tasks)) {
    log.warn('mission', `invalid mission file for ${id}`)
    return undefined
  }
  return mission
}

export function saveMission(mission: Mission): void {
  writePrivateFile(missionPath(mission.id), JSON.stringify(mission, null, 2) + '\n')
}

export function listMissions(limit = 30): Mission[] {
  const out: Mission[] = []
  try {
    if (!existsSync(missionsDir())) return out
    const files = readdirSync(missionsDir())
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
    for (const f of files) {
      if (out.length >= limit) break
      const m = loadMission(f.replace(/\.json$/, ''))
      if (m) out.push(m)
    }
  } catch {
    /* ignore */
  }
  return out
}

export { PATHS }
