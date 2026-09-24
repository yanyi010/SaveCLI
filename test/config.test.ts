import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PROFILES,
  defaultConfig,
  loadConfig,
  resolveProfileSpec,
  applyEnvOverrides,
  findProjectRoot,
} from '../src/config.js'
import { defaultSecurityConfig, checkPath, checkWritePath, sanitizeForContext } from '../src/security.js'

let home: string
let cwd: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'savecli-cfg-'))
  cwd = mkdtempSync(join(tmpdir(), 'savecli-cwd-'))
  process.env['SAVECLI_HOME'] = home
})

describe('config', () => {
  it('defaults include builtin profiles', () => {
    const cfg = defaultConfig()
    expect(cfg.profiles['anthropic']?.model).toBe('claude-sonnet-4-5')
    expect(cfg.profiles['openai']?.provider).toBe('openai')
    expect(cfg.tokenSaving.responseCache).toBe(true)
    expect(cfg.security.sanitizeContext).toBe(true)
  })

  it('user config merges over builtins', () => {
    mkdirSync(join(home), { recursive: true })
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ tokenSaving: { autoCompact: false }, profiles: { fast: { provider: 'openai', model: 'm1', baseUrl: 'http://x/v1' } } }),
    )
    const { config } = loadConfig(cwd)
    expect(config.tokenSaving.autoCompact).toBe(false)
    expect(config.tokenSaving.responseCache).toBe(true) // untouched default
    expect(config.profiles['fast']?.model).toBe('m1')
    expect(config.profiles['anthropic']?.model).toBe('claude-sonnet-4-5') // builtin stays
  })

  it('project config cannot inject apiKey', () => {
    mkdirSync(join(cwd, '.savecli'), { recursive: true })
    writeFileSync(
      join(cwd, '.savecli', 'config.json'),
      JSON.stringify({ profiles: { evil: { provider: 'openai', model: 'x', apiKey: 'sk-injected' } } }),
    )
    const { config } = loadConfig(cwd)
    expect(config.profiles['evil']?.apiKey).toBeUndefined()
    expect(config.profiles['evil']?.model).toBe('x') // rest kept
  })

  it('finds project root in ancestor directories', () => {
    mkdirSync(join(cwd, '.savecli'), { recursive: true })
    const nested = join(cwd, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(findProjectRoot(nested)).toBe(cwd)
    expect(findProjectRoot(tmpdir())).toBeUndefined()
  })

  it('resolves profile specs: name, provider/model, bare model', () => {
    const cfg = defaultConfig()

    expect(resolveProfileSpec(cfg, 'deepseek').profileName).toBe('deepseek')
    expect(resolveProfileSpec(cfg, 'anthropic/claude-haiku-4-5').model).toBe('claude-haiku-4-5')
    expect(resolveProfileSpec(cfg, 'claude-haiku-4-5').model).toBe('claude-haiku-4-5')
    expect(resolveProfileSpec(cfg, undefined).profileName).toBe(cfg.defaultProfile)
    expect(() => resolveProfileSpec(cfg, 'nonexistent-provider/x')).toThrow(/unknown profile/)
  })

  it('env overrides win', () => {
    const cfg = defaultConfig()
    for (const [name, p] of Object.entries(BUILTIN_PROFILES)) cfg.profiles[name] = { ...p }
    const resolved = resolveProfileSpec(cfg, 'anthropic')
    const overridden = applyEnvOverrides(resolved, { ...process.env, SAVECLI_MODEL: 'claude-x', SAVECLI_BASE_URL: 'http://proxy' })
    expect(overridden.model).toBe('claude-x')
    expect(overridden.baseUrl).toBe('http://proxy')
  })
})

describe('security', () => {
  it('denies ssh and savecli state reads by default', () => {
    const sec = defaultSecurityConfig()
    const realSsh = join(homedir(), '.ssh', 'id_rsa')
    expect(checkPath(realSsh, cwd, sec)).toBe('deny')
    // SAVECLI_HOME-relative stores use PATHS (env-aware)
    expect(checkPath(join(home, 'credentials.json'), cwd, sec)).toBe('deny')
    expect(checkPath(join(home, 'cache', 'x.json'), cwd, sec)).toBe('deny')
    expect(checkPath(join(home, 'sessions', 'y.jsonl'), cwd, sec)).toBe('deny')
  })

  it('warns on .env and pem files', () => {
    const sec = defaultSecurityConfig()
    expect(checkPath(join(cwd, '.env'), cwd, sec)).toBe('warn')
    expect(checkPath(join(cwd, 'cert.pem'), cwd, sec)).toBe('warn')
    expect(checkPath(join(cwd, 'src', 'main.ts'), cwd, sec)).toBe('ok')
  })

  it('write path protects .git and project instructions', () => {
    const sec = defaultSecurityConfig()
    expect(checkWritePath(join(cwd, '.git', 'HEAD'), cwd, sec, { yolo: false })).toBe('deny')
    expect(checkWritePath(join(cwd, '.savecli', 'config.json'), cwd, sec, { yolo: false })).toBe('deny')
    expect(checkWritePath(join(cwd, 'AGENTS.md'), cwd, sec, { yolo: false })).toBe('ask')
    expect(checkWritePath(join(cwd, '.git', 'HEAD'), cwd, sec, { yolo: true })).toBe('deny') // even in yolo
    expect(checkWritePath(join(cwd, 'src', 'a.ts'), cwd, sec, { yolo: false })).toBe('ok')
  })

  it('sanitizeForContext strips private keys and secrets', () => {
    const sec = defaultSecurityConfig()
    const dirty = `prefix\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecretkeybytes\n-----END OPENSSH PRIVATE KEY-----\nsk-abcdefghijklmnop123\napi_key="abcdef123456"\n`
    const { text, redactions } = sanitizeForContext(dirty, sec)
    expect(text).not.toContain('secretkeybytes')
    expect(text).not.toContain('sk-abcdefghijklmnop123')
    expect(redactions).toBeGreaterThan(0)
    const clean = 'just normal code'
    expect(sanitizeForContext(clean, sec)).toEqual({ text: clean, redactions: 0 })
  })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  delete process.env['SAVECLI_HOME']
})
