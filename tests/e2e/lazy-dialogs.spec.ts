import type { Page, Request } from '@playwright/test'
import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { ui, openPanel, expectReaderImage } from './gallery-ui'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] } })
type ModuleOutcome = 'success' | 'failure'
const modulePattern = /\/(?:assets\/NetworkSettings-[^/]+\.js|src\/components\/NetworkSettings\.tsx)(?:\?.*)?$/

async function holdModule(page: Page, outcome: ModuleOutcome) {
  let release!: () => void
  let requested!: (url: string) => void
  let attempts = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const request = new Promise<string>(resolve => { requested = resolve })
  await page.route(modulePattern, async route => {
    if (++attempts === 1) {
      requested(route.request().url())
      await gate
      if (outcome === 'failure') { await route.abort('failed'); return }
    }
    await route.continue()
  })
  return { release, request }
}

async function settleModule(page: Page, url: string, outcome: ModuleOutcome, release: () => void) {
  const matches = (request: Request) => request.url() === url
  const finished = outcome === 'success' ? page.waitForEvent('requestfinished', matches) : page.waitForEvent('requestfailed', matches)
  release()
  const request = await finished
  if (outcome === 'failure') expect(request.failure()).not.toBeNull()
  else expect((await request.response())?.ok()).toBe(true)
  await page.evaluate(async () => {
    for (let frame = 0; frame < 32; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

function bodyStyles(page: Page) {
  return page.locator('body').evaluate(element => ({ paddingRight: element.style.paddingRight, overflow: element.style.overflow }))
}

async function prepareScrollbar(page: Page) {
  const original = await page.evaluate(() => {
    document.body.style.paddingRight = '13.25px'
    document.body.style.overflow = 'auto'
    document.body.style.minHeight = '200vh'
    return { styles: { paddingRight: document.body.style.paddingRight, overflow: document.body.style.overflow }, gutter: innerWidth - document.documentElement.clientWidth, padding: parseFloat(getComputedStyle(document.body).paddingRight) }
  })
  expect(original.gutter, 'This case requires a real nonzero scrollbar gutter').toBeGreaterThan(0)
  return { original: original.styles, locked: { paddingRight: `${original.padding + original.gutter}px`, overflow: 'hidden' } }
}

test('network loading and loaded content share the same sidebar, focus trap and scroll lock', async ({ page, galleryFixtures }) => {
  const pending = await holdModule(page, 'success')
  try {
    await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
    await expectReaderImage(page, galleryFixtures.raw.bytes)
    const { original, locked } = await prepareScrollbar(page)
    await openPanel(page, 'network')
    await pending.request
    const dialog = ui.dialog(page)
    const shell = await dialog.elementHandle()
    if (!shell) throw new Error('Sidebar shell is missing')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog.getByRole('status')).toBeVisible()
    await expect(ui.closePanel(page)).toBeFocused()
    expect(await bodyStyles(page)).toEqual(locked)
    expect(await ui.reader(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
    for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key)
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    }
    pending.release()
    await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
    await expect(ui.dialog(page)).toHaveCount(1)
    expect(await dialog.evaluate((element, prior) => element === prior, shell)).toBe(true)
    await expect(dialog.getByRole('dialog')).toHaveCount(0)
    expect(await bodyStyles(page)).toEqual(locked)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(ui.menuButton(page)).toBeFocused()
    expect(await bodyStyles(page)).toEqual(original)
    expect(await page.evaluate(() => innerWidth - document.documentElement.clientWidth)).toBeGreaterThan(0)
    await shell.dispose()
  } finally { pending.release() }
})

test('failed network module closes without navigation and recovers through explicit reload', async ({ page, galleryFixtures }) => {
  let attempts = 0
  await page.route(modulePattern, async route => {
    if (++attempts === 1) await route.abort('failed')
    else await route.continue()
  })
  await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await openPanel(page, 'network')
  await expect(ui.dialog(page).getByRole('alert')).toBeVisible()
  const url = page.url()
  const historyLength = await page.evaluate(() => history.length)
  for (const key of ['Tab', 'Tab']) {
    await page.keyboard.press(key)
    expect(await ui.dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await ui.closePanel(page).click()
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeFocused()
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
  await openPanel(page, 'network')
  await expect(ui.dialog(page).getByRole('alert')).toBeVisible()
  await Promise.all([page.waitForNavigation(), ui.dialog(page).getByRole('button', { name: '重新加载页面', exact: true }).click()])
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
  expect(attempts).toBe(2)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`Escape pending network stays closed after late ${outcome} and can explicitly reopen`, async ({ page, galleryFixtures }) => {
    const pending = await holdModule(page, outcome)
    try {
      await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
      await expectReaderImage(page, galleryFixtures.raw.bytes)
      const original = await bodyStyles(page)
      await openPanel(page, 'network')
      const moduleUrl = await pending.request
      await expect(ui.dialog(page).getByRole('status')).toBeVisible()
      const url = page.url()
      const historyLength = await page.evaluate(() => history.length)
      await page.keyboard.press('Escape')
      await expect(ui.dialog(page)).toHaveCount(0)
      await expect(ui.menuButton(page)).toBeFocused()
      expect(await bodyStyles(page)).toEqual(original)
      await settleModule(page, moduleUrl, outcome, pending.release)
      await expect(ui.dialog(page)).toHaveCount(0)
      await expect(ui.menuButton(page)).toBeFocused()
      expect(await bodyStyles(page)).toEqual(original)
      expect(page.url()).toBe(url)
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
      await openPanel(page, 'network')
      if (outcome === 'failure') {
        await expect(ui.dialog(page).getByRole('alert')).toBeVisible()
        await Promise.all([page.waitForNavigation(), ui.dialog(page).getByRole('button', { name: '重新加载页面', exact: true }).click()])
        await expectReaderImage(page, galleryFixtures.raw.bytes)
        await openPanel(page, 'network')
      }
      await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(ui.menuButton(page)).toBeFocused()
      expect(await bodyStyles(page)).toEqual(original)
      expect(page.url()).toBe(url)
      expect(await page.evaluate(() => history.length)).toBe(historyLength)
    } finally { pending.release() }
  })

  test(`late network ${outcome} leaves a replacement info modal in control`, async ({ page, galleryFixtures }) => {
    const pending = await holdModule(page, outcome)
    try {
      await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
      await expectReaderImage(page, galleryFixtures.raw.bytes)
      const original = await bodyStyles(page)
      await openPanel(page, 'network')
      const moduleUrl = await pending.request
      await page.keyboard.press('Escape')
      await openPanel(page, 'info')
      const dialog = ui.dialog(page)
      const close = ui.closePanel(page)
      await close.focus()
      const locked = await bodyStyles(page)
      const url = page.url()
      await settleModule(page, moduleUrl, outcome, pending.release)
      await expect(ui.dialog(page)).toHaveCount(1)
      await expect(close).toBeFocused()
      expect(await bodyStyles(page)).toEqual(locked)
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      }
      await page.keyboard.press('Escape')
      await expect(ui.menuButton(page)).toBeFocused()
      expect(await bodyStyles(page)).toEqual(original)
      expect(page.url()).toBe(url)
    } finally { pending.release() }
  })
}
