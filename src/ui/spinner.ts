import { c } from './colors.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Non-TTY-safe spinner. Only one active at a time. */
export class Spinner {
  private frame = 0
  private timer?: ReturnType<typeof setInterval>
  private startedAt = 0
  private label = ''
  private active = false

  constructor(private enabled: boolean) {}

  start(label: string): void {
    if (!this.enabled) return
    this.stop()
    this.label = label
    this.active = true
    this.startedAt = Date.now()
    this.timer = setInterval(() => this.render(), 90)
    this.render()
  }

  /** Update the label without resetting the elapsed clock. */
  update(label: string): void {
    this.label = label
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.active) {
      // clear the spinner line
      process.stderr.write(`\r${' '.repeat(Math.max(this.label.length + 40, 20))}\r`)
      this.active = false
    }
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  private render(): void {
    if (!this.active) return
    const frame = FRAMES[this.frame % FRAMES.length] ?? '⠋'
    this.frame++
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(0)
    process.stderr.write(`\r${c.cyan(frame)} ${c.dim(this.label)} ${c.dim(`${secs}s`)}`)
  }
}
