import { describe, expect, it } from 'vitest'
import { redact } from '../src/util/redact.js'

describe('redact', () => {
  it('redacts OpenAI-style keys', () => {
    const s = 'my key is sk-abc123def456ghi789jkl use it'
    expect(redact(s)).not.toContain('sk-abc123def456ghi789jkl')
    expect(redact(s)).toContain('sk-***')
  })

  it('redacts Anthropic keys before generic sk-', () => {
    const s = 'ANTHROPIC key sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    expect(redact(s)).toContain('sk-ant-***')
    expect(redact(s)).not.toContain('api03')
  })

  it('redacts Bearer headers case-insensitively', () => {
    expect(redact('Authorization: Bearer abcdefghijklmno')).toBe('Authorization: Bearer [REDACTED]')
    expect(redact('authorization: bearer abcdefghijklmno')).toContain('[REDACTED]')
    expect(redact('authorization: bearer abcdefghijklmno')).not.toContain('abcdefghijklmno')
  })

  it('redacts GitHub tokens', () => {
    const s = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12'
    expect(redact(s)).toBe('gh***')
  })

  it('redacts AWS access key ids', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA***')
  })

  it('redacts key=value assignments', () => {
    const s = 'api_key = "supersecretvalue123"'
    expect(redact(s)).not.toContain('supersecretvalue123')
  })

  it('redacts JSON-ish token fields', () => {
    const s = '{"access_token":"eyJhbGciOiJIUzI1NiJ9.e30.abc123def456ghi789jkl"}'
    expect(redact(s)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('redacts private key blocks', () => {
    const s = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'
    expect(redact(s)).not.toContain('MIIEow')
  })

  it('leaves ordinary text untouched', () => {
    const s = 'const x = 123; console.log("hello world")'
    expect(redact(s)).toBe(s)
  })
})
