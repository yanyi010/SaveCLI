import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'

export class PromptCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'PromptCancelled'
  }
}

/** Plain text prompt (visible input). */
export async function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : ''
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}${suffix}: `, (ans) => resolve(ans.trim()))
    })
    return answer === '' && defaultValue !== undefined ? defaultValue : answer
  } finally {
    rl.close()
  }
}

/**
 * Hidden-input prompt for secrets. Echoes '*', supports backspace and Ctrl-C.
 * Falls back to a plain readline line when stdin is not a TTY (piped input).
 */
export async function promptHidden(question: string): Promise<string> {
  process.stdout.write(`${question}: `)
  const isTty = process.stdin.isTTY === true
  if (!isTty) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
    try {
      return await new Promise<string>((resolve) => {
        rl.on('line', (line) => resolve(line.trim()))
      })
    } finally {
      rl.close()
    }
  }

  const wasRaw = process.stdin.isRaw ?? false
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return await new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let input = ''
    let settled = false

    const cleanup = (): void => {
      if (settled) return
      settled = true
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(wasRaw)
      if (!process.stdin.readableFlowing) process.stdin.resume()
    }

    const onData = (buf: Buffer): void => {
      const str = decoder.write(buf)
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(input)
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C
          cleanup()
          process.stdout.write('\n')
          reject(new PromptCancelled())
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (ch < ' ') continue // other control chars
        input += ch
        process.stdout.write('*')
      }
    }

    process.stdin.on('data', onData)
  })
}

/** Yes/no confirm. Returns default on empty input. */
export async function promptConfirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N'
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<boolean>((resolve) => {
      rl.question(`${question} (${hint}): `, (ans) => {
        const a = ans.trim().toLowerCase()
        if (a === '') return resolve(defaultYes)
        resolve(a === 'y' || a === 'yes')
      })
    })
  } finally {
    rl.close()
  }
}
