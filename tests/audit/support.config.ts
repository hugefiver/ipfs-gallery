import { defineConfig } from '@playwright/test'

// Contract checks use their own tiny HTTP fixture, never the app preview or a dev server.
export default defineConfig({
  testDir: '.',
  testMatch: '*.check.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: '../../test-results/audit-contract',
  reporter: [['list']],
})
