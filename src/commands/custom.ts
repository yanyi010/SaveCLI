/**
 * Custom slash commands (Claude Code-style): markdown templates in
 *   .savecli/commands/*.md   (project)
 *   ~/.savecli/commands/*.md (global)
 * The file name becomes /name; $ARGUMENTS and $1..$9 substitute arguments.
 * Progressive disclosure: command bodies only cost tokens when invoked.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { savecliHome } from '../constants.js'

export interface CustomCommand {
  name: string
  /** Where it was found (for /help display). */
  source: 'project' | 'global'
  template: string
}

export function loadCustomCommands(cwd: string): Map<string, CustomCommand> {
  const map = new Map<string, CustomCommand>()
  const globalDir = join(savecliHome(), 'commands')
  const projectDir = join(cwd, '.savecli', 'commands')
  // Project overrides global with the same name.
  collect(globalDir, 'global', map)
  collect(projectDir, 'project', map)
  return map
}

function collect(dir: string, source: 'project' | 'global', map: Map<string, CustomCommand>): void {
  try {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const name = f.slice(0, -3).toLowerCase()
      if (name === '' || !/^[a-z0-9_-]+$/.test(name)) continue
      try {
        const template = readFileSync(join(dir, f), 'utf8').trim()
        if (template === '') continue
        map.set(name, { name, source, template })
      } catch {
        /* unreadable — skip */
      }
    }
  } catch {
    /* unreadable dir — skip */
  }
}

/** Expand $ARGUMENTS / $1..$9 in a command template. */
export function expandTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter((s) => s !== '')
  let out = template
  out = out.replaceAll('$ARGUMENTS', args)
  for (let i = 1; i <= 9; i++) {
    out = out.replaceAll(`$${i}`, parts[i - 1] ?? '')
  }
  return out
}
