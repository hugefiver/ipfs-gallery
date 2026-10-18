import { cp, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const temporaryParent = await realpath(resolve(process.argv[2]))
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this delivery check with pnpm exec node')
const owned = await mkdtemp(join(temporaryParent, 'ipfs-transport-frozen-'))
console.log(`Owned frozen-install directory: ${owned}`)
const fresh = join(owned, 'fresh')
const run = (cwd, args, expectedSuccess = true) => {
  const command = pnpm.endsWith('.exe') ? pnpm : process.execPath
  const commandArgs = pnpm.endsWith('.exe') ? args : [pnpm, ...args]
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
  if (result.error) throw result.error
  if ((result.status === 0) !== expectedSuccess) throw new Error(`Unexpected pnpm exit ${result.status}: ${args.join(' ')}`)
}
try {
  await mkdir(fresh)
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(join(root, file), join(fresh, file))
  for (const directory of ['patches', 'tests/transport-patches', 'tests/support', 'tests/fixtures']) {
    await cp(join(root, directory), join(fresh, directory), { recursive: true })
  }
  run(fresh, ['install', '--frozen-lockfile'])
  run(fresh, ['exec', 'vitest', 'run', '--config', 'tests/transport-patches/vitest.config.ts'])
  run(fresh, ['exec', 'node', 'tests/transport-patches/build-worker.mjs', join(fresh, 'worker-build')])

  const workspace = parse(await readFile(join(fresh, 'pnpm-workspace.yaml'), 'utf8'))
  const patch = Object.values(workspace.patchedDependencies)[0]
  if (typeof patch !== 'string') throw new Error('No delivered patch mapping')
  const missing = join(owned, 'missing')
  const invalid = join(owned, 'invalid')
  for (const directory of [missing, invalid]) {
    await mkdir(directory)
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(join(fresh, file), join(directory, file))
    await cp(join(fresh, 'patches'), join(directory, 'patches'), { recursive: true })
  }
  await rename(join(missing, patch), join(missing, `${patch}.withheld`))
  run(missing, ['install', '--frozen-lockfile'], false)
  await writeFile(join(invalid, patch), 'diff --git a/missing.js b/missing.js\n--- a/missing.js\n+++ b/missing.js\n@@ -1 +1 @@\n-impossible context\n+changed\n')
  run(invalid, ['install', '--frozen-lockfile'], false)
  console.log('Frozen install, installed-entry regressions, worker bundle and negative delivery checks passed.')
} finally {
  if (dirname(owned) !== temporaryParent || !basename(owned).startsWith('ipfs-transport-frozen-')) throw new Error('Unsafe cleanup target')
  if (await realpath(owned) !== owned) throw new Error('Cleanup target was replaced')
  await rm(owned, { recursive: true, force: true })
}
