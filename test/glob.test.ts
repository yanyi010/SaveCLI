import { describe, expect, it } from 'vitest'
import { globMatch, globToRegex, globMatchList } from '../src/util/glob.js'

describe('glob matcher', () => {
  it('matches * within a segment', () => {
    expect(globMatch('*.ts', 'a.ts')).toBe(true)
    expect(globMatch('*.ts', 'src/a.ts')).toBe(false)
    expect(globMatch('git status*', 'git status')).toBe(true)
    expect(globMatch('git status*', 'git status --short')).toBe(true)
    expect(globMatch('git status*', 'git stash')).toBe(false)
  })

  it('matches ** across segments', () => {
    expect(globMatch('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatch('src/**/*.ts', 'src/x/y/z.ts')).toBe(true)
    expect(globMatch('**/.env', '/home/u/proj/.env')).toBe(true)
  })

  it('matches ? single chars', () => {
    expect(globMatch('file?.txt', 'file1.txt')).toBe(true)
    expect(globMatch('file?.txt', 'file12.txt')).toBe(false)
  })

  it('matches character classes', () => {
    expect(globMatch('[abc].txt', 'b.txt')).toBe(true)
    expect(globMatch('[abc].txt', 'd.txt')).toBe(false)
    expect(globMatch('[!abc].txt', 'd.txt')).toBe(true)
  })

  it('escapes regex metacharacters', () => {
    expect(globMatch('a.b+c.txt', 'a.b+c.txt')).toBe(true)
    expect(globMatch('a.b+c.txt', 'axbyc.txt')).toBe(false)
  })

  it('globMatchList returns the first matching pattern', () => {
    const patterns = ['cat *', 'ls*', 'pwd']
    expect(globMatchList(patterns, 'ls -la')).toBe('ls*')
    expect(globMatchList(patterns, 'rm -rf /')).toBeUndefined()
  })

  it('handles home-style protected patterns', () => {
    const re = globToRegex('/home/u/.ssh/**')
    expect(re.test('/home/u/.ssh/id_rsa')).toBe(true)
    expect(re.test('/home/u/.ssh/config')).toBe(true)
    expect(re.test('/home/u/.sshx')).toBe(false)
  })
})
