/** `savecli sessions` — list saved sessions. */
import { Session } from '../agent/session.js'
import { c } from '../ui/colors.js'

export function cmdSessions(args: string[]): number {
  const all = args.includes('--all')
  const cwd = process.cwd()
  const sessions = Session.listRecent(50).filter((s) => all || s.cwd === cwd)
  if (sessions.length === 0) {
    console.log(c.dim(`No sessions found ${all ? '' : 'in this directory '}— start one with: savecli`))
    return 0
  }
  console.log(c.bold(`Sessions ${all ? '(all directories)' : `in ${cwd}`}:\n`))
  for (const s of sessions) {
    const when = new Date(s.startedAt).toLocaleString()
    console.log(`  ${c.green(s.id)}  ${c.dim(when)}  ${c.cyan(`${s.profile}/${s.model}`)}  ${s.turns} turns`)
    console.log(c.dim(`    ${s.firstUserText}`))
  }
  console.log(c.dim('\nResume: savecli --session <id>   or /resume <id> inside the REPL'))
  return 0
}
