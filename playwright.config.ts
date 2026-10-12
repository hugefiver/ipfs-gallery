import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 2,
  outputDir: './test-results/e2e',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/e2e' }]],
  use: {
    baseURL: 'http://127.0.0.1:4183',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm run preview:reader-album',
    url: 'http://127.0.0.1:4183',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
