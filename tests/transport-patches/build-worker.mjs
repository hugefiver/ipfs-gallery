import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export async function buildWorker(outDir) {
  return build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: resolve(outDir),
    emptyOutDir: false,
    lib: {
      entry: resolve('tests/transport-patches/worker-entry.ts'),
      formats: ['es'], fileName: () => 'transport-test-sw.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWorker(process.argv[2] ?? '.transport-patches-build')
}
