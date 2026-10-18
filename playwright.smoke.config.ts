import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig(base, {
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: './test-results/smoke',
  reporter: [['list']],
  webServer: {
    command: 'pnpm run preview:reader-album',
    url: 'http://127.0.0.1:4183',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
