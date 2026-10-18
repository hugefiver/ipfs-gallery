import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/deployment',
  workers: 1,
  timeout: 45_000,
  outputDir: './test-results/deployment',
  reporter: [['list']],
  use: { browserName: 'chromium', channel: 'chromium', trace: 'retain-on-failure', serviceWorkers: 'allow' },
  projects: [
    { name: 'desktop-subdirectory', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-subdirectory', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
})
