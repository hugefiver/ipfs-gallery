import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

const parent = await realpath(resolve(process.argv[2]))
const owned = await mkdtemp(join(parent, 'ipfs-transport-browser-'))
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run with pnpm exec node')
console.log(`Owned browser run: ${owned}`)
try {
  const args = ['exec', 'playwright', 'test', '--config', 'tests/transport-patches/playwright.config.ts', '--retries=0']
  const result = spawnSync(pnpm.endsWith('.exe') ? pnpm : process.execPath, pnpm.endsWith('.exe') ? args : [pnpm, ...args], {
    cwd: resolve(import.meta.dirname, '../..'), stdio: 'inherit',
    env: { ...process.env, TRANSPORT_BROWSER_RUN: owned },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (dirname(owned) !== parent || !basename(owned).startsWith('ipfs-transport-browser-') || await realpath(owned) !== owned) throw new Error('Unsafe browser cleanup target')
  await rm(owned, { recursive: true, force: true })
}
