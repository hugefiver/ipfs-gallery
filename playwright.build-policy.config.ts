import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { expectedSwGalleryPolicy, type SwGalleryTestOptions } from './tests/support/sw-gallery-policy'

const strict = process.env.SW_GALLERY_STRICT_BUILD_DIR
const nonStrict = process.env.SW_GALLERY_FALSE_BUILD_DIR
if (!strict || !nonStrict || resolve(strict) === resolve(nonStrict)) {
  throw new Error('Set distinct SW_GALLERY_STRICT_BUILD_DIR and SW_GALLERY_FALSE_BUILD_DIR to existing isolated build outputs')
}
if (!process.env.SW_GALLERY_EXPECT_DEFAULTS) throw new Error('Set SW_GALLERY_EXPECT_DEFAULTS to the normalized defaults compiled into both outputs')

export default defineConfig<SwGalleryTestOptions>({
  testDir: './tests/e2e',
  testMatch: '**/build-policy.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  outputDir: './test-results/build-policy',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/build-policy' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'allow' },
  projects: [
    { name: 'strict', use: { ...devices['Desktop Chrome'], channel: 'chromium', expectedPolicy: expectedSwGalleryPolicy(true),
      galleryBuildDir: resolve(strict), oppositeBuildDir: resolve(nonStrict) } },
    { name: 'configured-gateway', use: { ...devices['Desktop Chrome'], channel: 'chromium', expectedPolicy: expectedSwGalleryPolicy(false),
      galleryBuildDir: resolve(nonStrict), oppositeBuildDir: resolve(strict) } },
  ],
})
