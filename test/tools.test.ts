import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'
import { editTool } from '../src/tools/edit.js'
import { bashTool, deriveAllowPattern } from '../src/tools/bash.js'
import { grepTool } from '../src/tools/grep.js'
import { globTool } from '../src/tools/glob.js'
import { treeTool } from '../src/tools/tree.js'
import { todoWriteTool } from '../src/tools/todowrite.js'
import { defaultConfig, type Config } from '../src/config.js'
import type { ToolContext } from '../src/tools/types.js'

let cwd: string
let home: string
let config: Config
let confirmAnswers: boolean[]

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    config,
    permissions: config.permissions,
    security: config.security,
    yolo: false,
    nonInteractive: false,
    confirm: async () => confirmAnswers.shift() ?? false,
    sessionAllowPatterns: new Set<string>(),
    readFiles: new Set<string>(),
    ...overrides,
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'savecli-tools-'))
  home = mkdtempSync(join(tmpdir(), 'savecli-tools-home-'))
  process.env['SAVECLI_HOME'] = home
  config = defaultConfig()
  confirmAnswers = []
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  delete process.env['SAVECLI_HOME']
})

describe('read tool', () => {
  it('reads files with line numbers', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n')
    const out = await readTool.execute({ path: 'a.txt' }, ctx())
    expect(out.isError).toBeFalsy()
    expect(out.content).toContain('1: one')
    expect(out.content).toContain('3: three')
  })

  it('respects offset and limit', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n')
    const out = await readTool.execute({ path: 'a.txt', offset: 2, limit: 2 }, ctx())
    expect(out.content).toContain('2: l2')
    expect(out.content).toContain('3: l3')
    expect(out.content).not.toContain('l1')
    expect(out.content).not.toContain('l5')
  })

  it('refuses binary files', async () => {
    writeFileSync(join(cwd, 'b.bin'), Buffer.from([0x01, 0x00, 0x02, 0x00]))
    const out = await readTool.execute({ path: 'b.bin' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('binary')
  })

  it('denies protected paths', async () => {
    const out = await readTool.execute({ path: join(home, 'credentials.json') }, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('protected')
  })

  it('records the file as read (edit precondition)', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'x\n')
    const c = ctx()
    await readTool.execute({ path: 'a.txt' }, c)
    expect(c.readFiles.has(join(cwd, 'a.txt'))).toBe(true)
  })
})

describe('write tool', () => {
  it('creates files and parent dirs', async () => {
    const out = await writeTool.execute({ path: 'src/deep/new.ts', content: 'export {}\n' }, ctx())
    expect(out.isError).toBeFalsy()
    expect(readFileSync(join(cwd, 'src', 'deep', 'new.ts'), 'utf8')).toBe('export {}\n')
  })

  it('refuses .git writes even in yolo', async () => {
    const out = await writeTool.execute({ path: '.git/HEAD', content: 'evil' }, ctx({ yolo: true }))
    expect(out.isError).toBe(true)
    expect(out.content).toContain('protected')
  })

  it('asks before writing AGENTS.md', async () => {
    confirmAnswers = [false]
    const out = await writeTool.execute({ path: 'AGENTS.md', content: 'new rules' }, ctx())
    expect(out.content).toContain('declined')
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false)
  })

  it('denies outside-cwd writes when policy is deny', async () => {
    config.permissions.editOutsideCwd = 'deny'
    const out = await writeTool.execute({ path: join(tmpdir(), 'escape.txt'), content: 'x' }, ctx())
    expect(out.isError).toBe(true)
  })
})

describe('edit tool', () => {
  it('replaces unique strings', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'alpha\nbeta\ngamma\n')
    const c = ctx()
    await readTool.execute({ path: 'f.txt' }, c)
    const out = await editTool.execute({ path: 'f.txt', oldString: 'beta', newString: 'BETA' }, c)
    expect(out.isError).toBeFalsy()
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('requires read-before-edit', async () => {
    writeFileSync(join(cwd, 'g.txt'), 'x\n')
    const out = await editTool.execute({ path: 'g.txt', oldString: 'x', newString: 'y' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('must read')
  })

  it('rejects ambiguous matches without replaceAll', async () => {
    writeFileSync(join(cwd, 'h.txt'), 'dup\ndup\n')
    const c = ctx()
    await readTool.execute({ path: 'h.txt' }, c)
    const out = await editTool.execute({ path: 'h.txt', oldString: 'dup', newString: 'x' }, c)
    expect(out.isError).toBe(true)
    expect(out.content).toContain('2 times')
  })

  it('replaces all with replaceAll', async () => {
    writeFileSync(join(cwd, 'i.txt'), 'dup\ndup\n')
    const c = ctx()
    await readTool.execute({ path: 'i.txt' }, c)
    await editTool.execute({ path: 'i.txt', oldString: 'dup', newString: 'x', replaceAll: true }, c)
    expect(readFileSync(join(cwd, 'i.txt'), 'utf8')).toBe('x\nx\n')
  })

  it('reports when oldString is missing', async () => {
    writeFileSync(join(cwd, 'j.txt'), 'content\n')
    const c = ctx()
    await readTool.execute({ path: 'j.txt' }, c)
    const out = await editTool.execute({ path: 'j.txt', oldString: 'nope', newString: 'x' }, c)
    expect(out.isError).toBe(true)
    expect(out.content).toContain('not found')
  })
})

describe('bash tool', () => {
  it('runs allowlisted commands without asking', async () => {
    const c = ctx()
    const out = await bashTool.execute({ command: 'echo hello-savecli' }, c)
    expect(out.isError).toBeFalsy()
    expect(out.content).toContain('hello-savecli')
  })

  it('asks for unlisted commands and respects rejection', async () => {
    confirmAnswers = [false]
    const out = await bashTool.execute({ command: 'touch asked.txt' }, ctx())
    expect(out.content).toContain('declined')
    expect(existsSync(join(cwd, 'asked.txt'))).toBe(false)
  })

  it('runs unlisted commands when confirmed', async () => {
    confirmAnswers = [true]
    const out = await bashTool.execute({ command: 'touch asked.txt' }, ctx())
    expect(out.isError).toBeFalsy()
    expect(existsSync(join(cwd, 'asked.txt'))).toBe(true)
  })

  it('denies destructive patterns unconditionally', async () => {
    confirmAnswers = [true] // even if the user said yes
    const out = await bashTool.execute({ command: 'sudo rm -rf /important' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.content).toContain('denied')
  })

  it('denies reading savecli credentials', async () => {
    const out = await bashTool.execute({ command: `cat ${join(home, 'credentials.json')}` }, ctx({ yolo: true }))
    expect(out.isError).toBe(true)
    expect(out.content).toContain('denied')
  })

  it('honors session allow patterns', async () => {
    const c = ctx()
    c.sessionAllowPatterns.add('python* *')
    const out = await bashTool.execute({ command: 'python3 -c "print(42)"' }, c)
    expect(out.isError).toBeFalsy()
    expect(out.content.trim()).toBe('42')
  })

  it('yolo skips confirmation but keeps deny rules', async () => {
    const out = await bashTool.execute({ command: 'touch y.txt' }, ctx({ yolo: true }))
    expect(out.isError).toBeFalsy()
    const denied = await bashTool.execute({ command: 'mkfs /dev/sda1' }, ctx({ yolo: true }))
    expect(denied.isError).toBe(true)
  })

  it('truncates huge output with head+tail', async () => {
    config.tokenSaving.toolOutputLimit = 500
    const out = await bashTool.execute({ command: 'seq 1 2000' }, ctx({ yolo: true }))
    expect(out.content.length).toBeLessThan(2000)
    expect(out.content).toContain('truncated')
    expect(out.content).toContain('1\n') // head kept
    expect(out.content).toContain('2000') // tail kept
  })

  it('times out long commands', async () => {
    const out = await bashTool.execute({ command: 'sleep 30', timeout: 1 }, ctx({ yolo: true }))
    expect(out.content).toContain('timed out')
  })

  it('derives conservative allow patterns', () => {
    expect(deriveAllowPattern('git status --short')).toBe('git status*')
    expect(deriveAllowPattern('npm test')).toBe('npm test*')
    expect(deriveAllowPattern('echo hi')).toBe('echo*')
  })
})

describe('search tools', () => {
  beforeEach(() => {
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const x = 1\nexport const y = 2\n')
    writeFileSync(join(cwd, 'src', 'b.ts'), 'const z = 3\n')
    writeFileSync(join(cwd, 'README.md'), '# hello\n')
    mkdirSync(join(cwd, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules', 'junk', 'x.ts'), 'const x = 1\n')
  })

  it('grep finds matches with file:line', async () => {
    const out = await grepTool.execute({ pattern: 'const' }, ctx())
    expect(out.content).toContain('src/a.ts:1')
    expect(out.content).toContain('src/b.ts:1')
    expect(out.content).not.toContain('node_modules')
  })

  it('grep include filter works', async () => {
    const out = await grepTool.execute({ pattern: 'const', include: '*.md' }, ctx())
    expect(out.content).toContain('no matches')
  })

  it('glob finds files sorted by mtime', async () => {
    const out = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx())
    expect(out.content).toContain('src/a.ts')
    expect(out.content).toContain('src/b.ts')
    expect(out.content).not.toContain('node_modules')
  })

  it('tree shows structure with sizes', async () => {
    const out = await treeTool.execute({}, ctx())
    expect(out.content).toContain('src/')
    expect(out.content).toContain('a.ts')
    expect(out.content).not.toContain('node_modules')
  })
})

describe('todowrite tool', () => {
  it('validates and updates the task list', async () => {
    const seen: unknown[] = []
    const c = ctx({ onTodos: (t) => seen.push(t) })
    const out = await todoWriteTool.execute(
      { todos: [{ content: 'task', status: 'in_progress', priority: 'high' }] },
      c,
    )
    expect(out.isError).toBeFalsy()
    expect(seen).toHaveLength(1)
    const bad = await todoWriteTool.execute({ todos: [{ content: 'x', status: 'bogus' }] }, ctx())
    expect(bad.isError).toBe(true)
  })
})
