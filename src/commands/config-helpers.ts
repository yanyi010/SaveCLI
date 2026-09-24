/** Shared config mutation helpers (used by CLI commands and the REPL /set). */
import { readFileSync } from 'node:fs'
import { PATHS } from '../constants.js'
import { writeJsonFile } from '../util/fsx.js'

export function readUserConfigRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function mutateUserConfig(fn: (partial: Record<string, unknown>) => void): void {
  const partial = readUserConfigRaw()
  fn(partial)
  writeJsonFile(PATHS.config, partial)
}
