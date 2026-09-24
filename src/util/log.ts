import { redact } from './redact.js'

/**
 * Namespaced debug logger. Disabled unless SAVECLI_DEBUG is set.
 * All output goes to stderr and is redacted — never write secrets to disk or stdout logs.
 */
class Logger {
  private enabled = process.env['SAVECLI_DEBUG'] === '1' || process.env['SAVECLI_DEBUG'] === 'true'

  debug(ns: string, msg: string, ...args: unknown[]): void {
    if (!this.enabled) return
    this.write('DBG', ns, msg, args)
  }

  warn(ns: string, msg: string, ...args: unknown[]): void {
    this.write('WRN', ns, msg, args)
  }

  error(ns: string, msg: string, ...args: unknown[]): void {
    this.write('ERR', ns, msg, args)
  }

  private write(level: string, ns: string, msg: string, args: unknown[]): void {
    const suffix = args.length > 0 ? ' ' + args.map((a) => redact(typeof a === 'string' ? a : safeJson(a))).join(' ') : ''
    process.stderr.write(`[${level}] [savecli:${ns}] ${redact(msg)}${suffix}\n`)
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = new Logger()
