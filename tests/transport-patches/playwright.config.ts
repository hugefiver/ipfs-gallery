import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

const run = process.env.TRANSPORT_BROWSER_RUN
if (!run) throw new Error('Use tests/transport-patches/browser-run.mjs for owned temporary output')

export default defineConfig({
  testDir: '.', testMatch: 'browser.spec.ts', workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 10_000 },
  outputDir: join(run, 'results'), reporter: 'line',
})
