/**
 * Secret redaction. Every piece of output that may contain user data passes
 * through here before being logged or sent to the LLM context.
 * Note: JavaScript regexes do not support inline flags like (?i) — use the
 * global+insensitive flags instead. Order matters (specific before generic).
 */

const REDACTED = '[REDACTED]'

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Private key blocks (before the rest — largest span)
  {
    re: PRIVATE_KEY_BLOCK,
    replacement: '-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----',
  },
  // Anthropic keys (before generic sk-)
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-ant-***' },
  // OpenAI-style keys
  { re: /\b(?:sk|rkk?)-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-***' },
  // GitHub tokens
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: 'gh***' },
  // GitLab tokens
  { re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replacement: 'glpat-***' },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: 'xox-***' },
  // AWS access key ids
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA***' },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: 'jwt-***' },
  // Authorization headers
  { re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `Bearer ${REDACTED}` },
  { re: /\bx-api-key\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `x-api-key: ${REDACTED}` },
  // key=value / "key": "value" assignments with secret-ish names
  {
    re: /(['"]?)(api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)\1(\s*[:=]\s*)(['"]?)[A-Za-z0-9._~+/=-]{8,}\4/gi,
    replacement: `$1$2$3$4${REDACTED}$4`,
  },
]

/** Redact common secret formats from a string. */
export function redact(input: string): string {
  let out = input
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement)
  }
  return out
}

/** Redact secrets from an arbitrary value's string form. */
export function redactValue(value: unknown): string {
  if (typeof value === 'string') return redact(value)
  try {
    return redact(JSON.stringify(value))
  } catch {
    return REDACTED
  }
}
