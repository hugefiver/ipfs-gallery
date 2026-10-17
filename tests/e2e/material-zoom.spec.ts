import { test, expect } from './fixtures'
import { ui, screenshot } from './gallery-ui'
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const nativeZoomTest = test.extend({
  context: async ({ playwright, headless }, use, testInfo) => {
    const profile = testInfo.outputPath('owned-browser-profile')
    await mkdir(profile)
    let context: BrowserContext | undefined
    try {
      context = await playwright.chromium.launchPersistentContext(profile, { channel: 'chrome', headless, viewport: { width: 2000, height: 1125 }, deviceScaleFactor: 1, serviceWorkers: 'block', args: ['--disable-extensions', '--disable-sync'] })
      await use(context)
    } finally {
      await context?.close()
      const resolved = await realpath(profile)
      expect(basename(resolved)).toBe('owned-browser-profile')
      expect(dirname(resolved)).toBe(await realpath(testInfo.outputDir))
      await rm(resolved, { recursive: true })
      await writeFile(testInfo.outputPath('owned-browser.json'), JSON.stringify({ profile, owner: testInfo.testId, closed: true, removed: true }))
    }
  },
})

async function recordGeometry(page: Page, testInfo: TestInfo, label: string) {
  await expect.poll(async () => (await ui.dialog(page).locator('.gallery-drawer-surface').boundingBox())?.x).toBe(0)
  const geometry = await page.evaluate(() => {
    const surface = document.querySelector('.gallery-drawer-surface')!, title = document.querySelector('#gallery-panel-title')!
    return { innerWidth, innerHeight, cssZoom: getComputedStyle(document.documentElement).zoom, dpr: devicePixelRatio, visualScale: visualViewport!.scale, surface: surface.getBoundingClientRect().toJSON(), titleSize: getComputedStyle(title).fontSize, main: document.querySelector('main')!.getBoundingClientRect().toJSON(), sourceRowDirection: getComputedStyle(document.querySelector('.source-row')!).flexDirection }
  })
  expect(geometry.surface.y).toBe(0)
  expect(geometry.surface.height).toBe(geometry.main.height)
  expect(geometry.titleSize).toBe('20px')
  expect(geometry.sourceRowDirection).toBe('column')
  await testInfo.attach(label, { body: JSON.stringify(geometry), contentType: 'application/json' })
  await writeFile(testInfo.outputPath(`${label}.json`), JSON.stringify(geometry))
  await screenshot(page, testInfo, label)
  return geometry
}

test('2000x1125 CSS150 keeps a 320 CSS px integral sidebar and true invalid-input recovery', async ({ page, network }, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 1125 })
  await page.goto('/')
  await expect(ui.source(page)).toBeFocused()
  await page.evaluate(() => { document.documentElement.style.zoom = '1.5' })
  const geometry = await recordGeometry(page, testInfo, 'empty-css150')
  expect(geometry.cssZoom).toBe('1.5'); expect(geometry.visualScale).toBe(1)
  expect(geometry.surface.width).toBe(480)
  await ui.source(page).fill('invalid source')
  await ui.submit(page).click()
  await expect(ui.source(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(ui.dialog(page).getByRole('alert')).toBeVisible()
  await expect(ui.source(page)).toBeFocused()
  await screenshot(page, testInfo, 'invalid-source-css150')
  expect(network.bridge.routes).toHaveLength(0)
})

nativeZoomTest('2000x1125 actual Chrome150 is distinct from CSS zoom and native pinch', async ({ page, context, network }, testInfo) => {
  await page.goto('/')
  await expect(ui.source(page)).toBeFocused()
  const settings = await context.newPage()
  try {
    await settings.goto('chrome://settings/appearance')
    await settings.evaluate(() => new Promise<void>(resolve => Reflect.get(globalThis, 'chrome').settingsPrivate.setDefaultZoom(1.5, resolve)))
  } finally { await settings.close() }
  await page.reload()
  await expect(ui.source(page)).toBeFocused()
  const geometry = await recordGeometry(page, testInfo, 'empty-native-chrome150')
  expect(geometry.cssZoom).toBe('1'); expect(geometry.visualScale).toBe(1)
  expect(Math.abs(geometry.innerWidth - 2000 / 1.5)).toBeLessThanOrEqual(1)
  expect(geometry.surface.width).toBe(320)
  await ui.closePanel(page).click()
  await expect(ui.dialog(page)).toHaveCount(0)
  await ui.menuButton(page).click()
  await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
  await screenshot(page, testInfo, 'menu-native-chrome150')
  expect(network.bridge.routes).toHaveLength(0)
})
