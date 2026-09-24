import { c, stripAnsi } from './colors.js'

/**
 * Lightweight markdown renderer for terminal output — fenced code blocks,
 * inline code, bold, headers, bullet lists. No external deps.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCode = false

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (!inCode) {
        inCode = true
        out.push(c.dim('─────────────────────────'))
      } else {
        inCode = false
        out.push(c.dim('─────────────────────────'))
      }
      continue
    }
    if (inCode) {
      out.push(c.cyan(line))
      continue
    }
    out.push(renderInline(line))
  }
  return out.join('\n')
}

function renderInline(line: string): string {
  // headers
  if (/^#{1,6}\s/.test(line)) return c.bold(c.cyan(line))
  // bullets — keep plain but dim the marker
  const bullet = line.match(/^(\s*)([-*]|\d+\.)\s/)
  if (bullet) {
    return `${bullet[1]}${c.dim(bullet[2]!)} ${renderInline(line.slice(bullet[0].length))}`
  }
  let s = line
  // inline code (before bold so ** doesn't eat `**`)
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => c.cyan(code))
  // bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, t: string) => c.bold(t))
  // italic — rarely used, cheap
  s = s.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, (_, pre: string, t: string) => `${pre}${t}`)
  return s
}

/** Render a compact status footer for a completed turn. */
export function renderTurnStatus(opts: {
  seconds: number
  input: number
  output: number
  cacheRead?: number
  costUsd?: number
  model: string
  fromCache: boolean
}): string {
  const parts: string[] = []
  parts.push(c.dim(`${opts.seconds.toFixed(1)}s`))
  if (opts.fromCache) {
    parts.push(c.green('⚡ cached (0 tokens)'))
  } else {
    const io = `${fmt(opts.input)} in / ${fmt(opts.output)} out`
    parts.push(c.dim(io))
    if (opts.cacheRead && opts.cacheRead > 0) parts.push(c.dim(`(${fmt(opts.cacheRead)} cache-read)`))
    if (opts.costUsd !== undefined) parts.push(c.yellow(`$${opts.costUsd < 0.0001 ? opts.costUsd.toExponential(1) : opts.costUsd.toFixed(4)}`))
  }
  parts.push(c.magenta(opts.model))
  return parts.join(c.dim(' · '))
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export { stripAnsi }
