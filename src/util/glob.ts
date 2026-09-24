/**
 * Glob matching used by permissions and the glob tool.
 * Supports: ** (cross-separator), * (within segment), ?, [class].
 */

export function globToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // '**' — match anything including separators
        re += '.*'
        i += 2
        // skip a following slash so 'a/**/b' also matches 'a/b'
        if (pattern[i] === '/') i++
      } else {
        re += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      re += '[^/]'
      i++
    } else if (ch === '[') {
      let j = i + 1
      let cls = ''
      if (pattern[j] === '!' || pattern[j] === '^') {
        cls += '^'
        j++
      }
      while (j < pattern.length && pattern[j] !== ']') {
        const c = pattern[j]!
        if (c === '\\') {
          cls += '\\' + (pattern[j + 1] ?? '')
          j += 2
        } else {
          cls += c
          j++
        }
      }
      if (j >= pattern.length) {
        // unterminated class — treat '[' literally
        re += '\\['
        i++
      } else {
        re += `[${cls}]`
        i = j + 1
      }
    } else if ('\\^$.|+(){}'.includes(ch)) {
      re += '\\' + ch
      i++
    } else {
      re += ch
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

export function globMatch(pattern: string, subject: string): boolean {
  return globToRegex(pattern).test(subject)
}

/** Match a subject against a list of patterns; first hit wins. Empty list never matches. */
export function globMatchList(patterns: readonly string[], subject: string): string | undefined {
  for (const p of patterns) {
    if (globMatch(p, subject)) return p
  }
  return undefined
}
