import { homedir } from 'node:os'
import { join } from 'node:path'

/** SaveCLI version — keep in sync with package.json (guarded by test/version.test.ts). */
export const VERSION = '0.1.0'

/** Root state directory. Override with SAVECLI_HOME for isolated environments/tests. */
export function savecliHome(): string {
  const override = process.env['SAVECLI_HOME']
  if (override && override.trim() !== '') return override
  return join(homedir(), '.savecli')
}

export const PATHS = {
  get config() {
    return join(savecliHome(), 'config.json')
  },
  get credentials() {
    return join(savecliHome(), 'credentials.json')
  },
  get cacheDir() {
    return join(savecliHome(), 'cache')
  },
  get responseCacheDir() {
    return join(savecliHome(), 'cache', 'responses')
  },
  get sessionsDir() {
    return join(savecliHome(), 'sessions')
  },
  get usageFile() {
    return join(savecliHome(), 'usage.jsonl')
  },
} as const

export const PROJECT_DIR_NAME = '.savecli'

/** Environment variable prefix for overrides. */
export const ENV_PREFIX = 'SAVECLI_'
