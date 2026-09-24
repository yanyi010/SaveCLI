#!/usr/bin/env node
// SaveCLI launcher — keeps startup path dependency-free.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'dist', 'index.js')

if (!existsSync(entry)) {
  console.error('savecli: dist/index.js not found. Run `npm run build` first, or install from npm.')
  process.exit(1)
}

const mod = await import(pathToFileURL(entry).href)
const code = await mod.main(process.argv)
process.exit(code)
