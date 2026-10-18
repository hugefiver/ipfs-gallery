import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FIXTURE_GATEWAYS, sourceUrl } from './gateway-route'
import { expectedSwGalleryPolicy } from '../support/sw-gallery-policy'
import { ui, openPanel, enterAlbum, enterReader, selectAlbumItem, expectReaderImage } from './gallery-ui'

const key = 'ipfs-gallery.preferences.v1'
const unrelatedKey = 'fixture.unrelated-owner'
const defaults = { version: 1, layout: 'auto', sidebar: { desktop: true, mobile: false }, gateways: [] }
const DEFAULT_GATEWAYS = expectedSwGalleryPolicy().defaultGateways
type StorageFault = 'getter' | 'read' | 'write' | 'delete'

declare global {
  interface Window {
    preferenceTestIO: { method: 'set' | 'remove'; key: string }[]
    preferenceTestRead: () => string | null
    preferenceTestFault: StorageFault | undefined
  }
}

async function instrumentStorage(page: Page, record?: string, fault?: StorageFault): Promise<void> {
  await page.addInitScript(({ key, unrelatedKey, record, fault }) => {
    const store = window.localStorage
    const originalGet = Storage.prototype.getItem
    const originalSet = Storage.prototype.setItem
    const originalRemove = Storage.prototype.removeItem
    if (!sessionStorage.getItem('fixture.preferences.seeded')) {
      if (record !== undefined) originalSet.call(store, key, record)
      originalSet.call(store, unrelatedKey, 'keep')
      sessionStorage.setItem('fixture.preferences.seeded', 'true')
    }
    window.preferenceTestIO = []
    window.preferenceTestFault = fault
    window.preferenceTestRead = () => originalGet.call(store, key)
    Storage.prototype.getItem = function (name) {
      if (name === key && window.preferenceTestFault === 'read') throw new DOMException('Denied', 'SecurityError')
      return originalGet.call(this, name)
    }
    Storage.prototype.setItem = function (name, value) {
      window.preferenceTestIO.push({ method: 'set', key: name })
      if (name === key && window.preferenceTestFault === 'write') throw new DOMException('Quota', 'QuotaExceededError')
      return originalSet.call(this, name, value)
    }
    Storage.prototype.removeItem = function (name) {
      window.preferenceTestIO.push({ method: 'remove', key: name })
      if (name === key && window.preferenceTestFault === 'delete') throw new DOMException('Denied', 'SecurityError')
      return originalRemove.call(this, name)
    }
    if (fault === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError') } })
  }, { key, unrelatedKey, record, fault })
}

async function savedRecord(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const value = window.preferenceTestRead()
    return value === null ? null : JSON.parse(value) as unknown
  })
}

async function openSettings(page: Page) {
  await openPanel(page, 'network')
  const settings = ui.settingsDialog(page)
  await expect(settings).toBeVisible()
  return settings
}

test('preferences default off; mode, chrome, item and reload never implicitly persist content', async ({ page, previewFixtures }) => {
  await instrumentStorage(page)
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const settings = await openSettings(page)
  await expect(ui.remember(settings)).not.toBeChecked()
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await selectAlbumItem(page, previewFixtures.items[3]!.title)
  await expect(ui.menuButton(page)).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
  await page.reload()
  await expectReaderImage(page, previewFixtures.items[3]!.original.bytes)
  await expect(ui.menuButton(page)).toBeVisible()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
})

test('no-source network write failure stays visible through explicit apply and can retry without implicitly saving URL gateways', async ({ page, network }) => {
  await instrumentStorage(page, undefined, 'write')
  await page.goto(`/?gateway=${encodeURIComponent(FIXTURE_GATEWAYS.fast)}`)
  await expect(ui.source(page)).toBeVisible()
  const settings = await openSettings(page)
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
  await ui.remember(settings).check()
  await expect(settings).toBeVisible()
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'alert')
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'set', key }])
  await ui.gateways(settings).first().fill(FIXTURE_GATEWAYS.slow)
  await ui.saveSettings(settings).click()
  await expect.poll(() => new URL(page.url()).searchParams.getAll('gateway')).toEqual([FIXTURE_GATEWAYS.slow])
  await expect(settings).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'alert')
  await expect(ui.remember(settings)).toBeChecked()
  await expect(ui.saveSettings(settings)).toBeFocused()
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'set', key }, { method: 'set', key }])
  await page.evaluate(() => { window.preferenceTestFault = undefined })
  await ui.saveSettings(settings).click()
  await expect(settings).toHaveCount(0)
  expect(await savedRecord(page)).toEqual({ ...defaults, gateways: [FIXTURE_GATEWAYS.slow] })
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(network.bridge.routes).toEqual([])
  expect(new URL(page.url()).searchParams.has('cid') || new URL(page.url()).searchParams.has('meta') || new URL(page.url()).searchParams.has('unixfs')).toBe(false)
})

test('no-source successful opt-in and clear keep the network panel visible without privately saving the URL gateway', async ({ page, network }) => {
  await instrumentStorage(page)
  await page.goto(`/?gateway=${encodeURIComponent(FIXTURE_GATEWAYS.fast)}`)
  await expect(ui.source(page)).toBeVisible()
  const settings = await openSettings(page)
  const url = page.url()
  await ui.remember(settings).check()
  await expect(settings).toBeVisible()
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  expect(await savedRecord(page)).toEqual(defaults)
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'set', key }])
  await ui.clearSaved(settings).click()
  await expect(settings).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  await expect(ui.remember(settings)).not.toBeChecked()
  await expect(ui.clearSaved(settings)).toBeFocused()
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'set', key }, { method: 'remove', key }])
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(page.url()).toBe(url)
  expect(network.bridge.routes).toEqual([])
})

test('no-source network clear failure keeps its feedback and delete retry in the same modal without promoting the URL gateway', async ({ page, network }) => {
  const local = { ...defaults, layout: 'dual', sidebar: { desktop: false, mobile: true }, gateways: [FIXTURE_GATEWAYS.slow] }
  await instrumentStorage(page, JSON.stringify(local), 'delete')
  await page.goto(`/?gateway=${encodeURIComponent(FIXTURE_GATEWAYS.fast)}`)
  await expect(ui.source(page)).toBeVisible()
  const settings = await openSettings(page)
  const url = page.url()
  await ui.clearSaved(settings).click()
  await expect(settings).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'alert')
  await expect(ui.remember(settings)).not.toBeChecked()
  await expect(ui.clearSaved(settings)).toBeFocused()
  const retry = settings.getByRole('button', { name: '重试删除已保存设置', exact: true })
  await expect(retry).toBeVisible()
  expect(await savedRecord(page)).toEqual(local)
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }])
  expect(page.url()).toBe(url)
  await page.evaluate(() => { window.preferenceTestFault = undefined })
  await retry.click()
  await expect(settings).toBeVisible()
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }, { method: 'remove', key }])
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(page.url()).toBe(url)
  expect(network.bridge.routes).toEqual([])
})

test('no-source clear of a non-default saved configuration keeps its focused network action and restores only owned defaults', async ({ page, network }) => {
  await instrumentStorage(page, JSON.stringify({ ...defaults, layout: 'single', sidebar: { desktop: false, mobile: true }, gateways: [FIXTURE_GATEWAYS.slow] }))
  await page.goto(`/?gateway=${encodeURIComponent(FIXTURE_GATEWAYS.fast)}`)
  await expect(ui.source(page)).toBeVisible()
  const settings = await openSettings(page)
  const url = page.url()
  await ui.clearSaved(settings).click()
  await expect(settings).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  await expect(ui.remember(settings)).not.toBeChecked()
  await expect(ui.clearSaved(settings)).toBeFocused()
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }])
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(page.url()).toBe(url)
  expect(network.bridge.routes).toEqual([])
  await ui.remember(settings).check()
  await expect(settings).toBeVisible()
  expect(await savedRecord(page)).toEqual(defaults)
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }, { method: 'set', key }])
  expect(page.url()).toBe(url)
  expect(network.bridge.routes).toEqual([])
})

test('opt-in saves only v1 fields; applying gateways excludes disabled drafts and private state', async ({ page, previewFixtures, network }) => {
  await instrumentStorage(page)
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  let settings = await openSettings(page)
  await ui.remember(settings).check()
  expect(await savedRecord(page)).toEqual(defaults)
  await settings.getByRole('button', { name: '添加网关', exact: true }).click()
  await settings.getByRole('textbox', { name: '网关 2 HTTPS 地址', exact: true }).fill('https://disabled-draft.gallery-fixture.net')
  await settings.getByRole('checkbox', { name: '启用网关 2', exact: true }).uncheck()
  await ui.saveSettings(settings).click()
  await expect(ui.settingsDialog(page)).toHaveCount(0)
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await page.setViewportSize({ width: 375, height: 812 })
  const beforeSelection = await page.evaluate(() => window.preferenceTestIO.length)
  await selectAlbumItem(page, previewFixtures.items[4]!.title)
  await expectReaderImage(page, previewFixtures.items[4]!.original.bytes)
  await openPanel(page, 'filters')
  await ui.search(page).fill('预览-04')
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('预览-04')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.preferenceTestIO.length)).toBe(beforeSelection)
  const expected = { ...defaults, gateways: [FIXTURE_GATEWAYS.fast] }
  expect(await savedRecord(page)).toEqual(expected)
  await page.reload()
  await expectReaderImage(page, previewFixtures.items[4]!.original.bytes)
  await expect(ui.menuButton(page)).toBeVisible()
  expect(await savedRecord(page)).toEqual(expected)
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
  settings = await openSettings(page)
  await expect(ui.remember(settings)).toBeChecked()
  await expect(ui.gateways(settings)).toHaveCount(1)
  await expect(ui.gateways(settings).first()).toHaveValue(FIXTURE_GATEWAYS.fast)
  expect(network.bridge.routes.every(route => new URL(route.url).origin === FIXTURE_GATEWAYS.fast)).toBe(true)
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual([unrelatedKey, key].sort())
})

for (const layout of ['auto', 'single', 'dual']) {
  test(`saved ${layout} and both sidebar values remain unchanged without revealing tools`, async ({ page, previewFixtures }) => {
    const record = { ...defaults, layout, sidebar: { desktop: false, mobile: true }, gateways: [FIXTURE_GATEWAYS.fast] }
    await instrumentStorage(page, JSON.stringify(record))
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, []))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await expect(ui.reader(page).getByRole('img')).toHaveCount(1)
    await expect(ui.menuButton(page)).toBeVisible()
    await enterAlbum(page)
    await enterReader(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(ui.menuButton(page)).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await savedRecord(page)).toEqual(record)
    expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
    expect(new URL(page.url()).searchParams.getAll('gateway')).toEqual([])
  })
}

test('saved gateway is effective before the first request without URL injection', async ({ page, previewFixtures, network }) => {
  await instrumentStorage(page, JSON.stringify({ ...defaults, layout: 'single', gateways: [FIXTURE_GATEWAYS.fast] }))
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, []))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  expect(network.bridge.routes.length).toBeGreaterThan(0)
  expect(network.bridge.routes.every(route => new URL(route.url).origin === FIXTURE_GATEWAYS.fast)).toBe(true)
  expect(network.slow.requests).toHaveLength(0)
  expect(new URL(page.url()).searchParams.getAll('gateway')).toEqual([])
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
  const settings = await openSettings(page)
  await expect(ui.gateways(settings).first()).toHaveValue(FIXTURE_GATEWAYS.fast)
})

test('URL gateway overrides disk; chrome, mode and remember do not promote it, explicit apply does', async ({ page, previewFixtures, network }) => {
  const local = { ...defaults, gateways: [FIXTURE_GATEWAYS.slow] }
  await instrumentStorage(page, JSON.stringify(local))
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  expect(network.slow.requests).toHaveLength(0)
  expect(network.bridge.routes.every(route => new URL(route.url).origin === FIXTURE_GATEWAYS.fast)).toBe(true)
  await enterAlbum(page)
  await enterReader(page)
  expect(await savedRecord(page)).toEqual(local)
  let settings = await openSettings(page)
  await ui.remember(settings).uncheck()
  expect(await savedRecord(page)).toBeNull()
  await ui.remember(settings).check()
  expect(await savedRecord(page)).toEqual(local)
  await expect(ui.gateways(settings).first()).toHaveValue(FIXTURE_GATEWAYS.fast)
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, []))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  expect(network.slow.requests.length).toBeGreaterThan(0)
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  settings = await openSettings(page)
  await ui.saveSettings(settings).click()
  await expect(ui.settingsDialog(page)).toHaveCount(0)
  expect(await savedRecord(page)).toEqual({ ...local, gateways: [FIXTURE_GATEWAYS.fast] })
  const slow = network.slow.requests.length
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, []))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  expect(network.slow.requests.length).toBe(slow)
})

test('clear removes only the owned record and keeps the explicit URL gateway', async ({ page, previewFixtures, network }) => {
  await instrumentStorage(page, JSON.stringify({ ...defaults, layout: 'single', sidebar: { desktop: false, mobile: true }, gateways: [FIXTURE_GATEWAYS.slow] }))
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const url = page.url()
  const settings = await openSettings(page)
  await ui.clearSaved(settings).click()
  await expect(ui.remember(settings)).not.toBeChecked()
  await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }])
  expect(page.url()).toBe(url)
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await page.reload()
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  expect(network.slow.requests).toHaveLength(0)
})

test('turning remember off preserves memory, removes only the owned key and stops writes', async ({ page, previewFixtures }) => {
  await instrumentStorage(page, JSON.stringify({ ...defaults, layout: 'dual', gateways: [FIXTURE_GATEWAYS.fast] }))
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const settings = await openSettings(page)
  await ui.remember(settings).uncheck()
  await settings.getByRole('button', { name: '取消', exact: true }).click()
  await enterAlbum(page)
  await enterReader(page)
  expect(await savedRecord(page)).toBeNull()
  expect(await page.evaluate(name => localStorage.getItem(name), unrelatedKey)).toBe('keep')
  expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([{ method: 'remove', key }])
  await page.reload()
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await expect(ui.remember(await openSettings(page))).not.toBeChecked()
})

const invalidRecords = [
  ['malformed JSON', '{'],
  ['unknown version', JSON.stringify({ ...defaults, version: 2, layout: 'single' })],
  ['unknown private field', JSON.stringify({ ...defaults, layout: 'single', item: 'private-content-id' })],
  ['invalid layout', JSON.stringify({ ...defaults, layout: 'grid' })],
  ['non-boolean sidebar', JSON.stringify({ ...defaults, layout: 'single', sidebar: { desktop: 'false', mobile: false } })],
  ['oversized record', ' '.repeat(40 * 1024 + 1)],
  ['illegal gateway', JSON.stringify({ ...defaults, layout: 'single', gateways: ['http://127.0.0.1/private'] })],
  ['unsafe key', '{"version":1,"layout":"single","sidebar":{"desktop":false,"mobile":true},"gateways":[],"__proto__":{}}'],
] as const
for (const [name, record] of invalidRecords) {
  test(`${name} fails as a complete record without automatic rewrite`, async ({ page, previewFixtures }) => {
    await instrumentStorage(page, record)
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const settings = await openSettings(page)
    await expect(ui.remember(settings)).not.toBeChecked()
    await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'alert')
    expect(await page.evaluate(() => window.preferenceTestRead())).toBe(record)
    expect(await page.evaluate(() => window.preferenceTestIO)).toEqual([])
    await ui.remember(settings).check()
    expect(await savedRecord(page)).toEqual(defaults)
    await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'status')
  })
}

for (const fault of ['getter', 'read', 'write', 'delete'] as const) {
  test(`storage ${fault} failure is honest and leaves in-memory browsing usable`, async ({ page, previewFixtures }) => {
    const record = fault === 'delete' ? JSON.stringify({ ...defaults, gateways: [FIXTURE_GATEWAYS.fast] }) : undefined
    await instrumentStorage(page, record, fault)
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const settings = await openSettings(page)
    if (fault === 'delete') await ui.remember(settings).uncheck()
    else if (fault === 'write') {
      await ui.remember(settings).check()
      await ui.gateways(settings).first().fill(FIXTURE_GATEWAYS.slow)
      await ui.saveSettings(settings).click()
      await expect(settings).toBeVisible()
      await expect.poll(() => new URL(page.url()).searchParams.getAll('gateway')).toEqual([FIXTURE_GATEWAYS.slow])
    }
    await expect(ui.storageStatus(settings)).toHaveAttribute('role', 'alert')
    await expect(ui.remember(settings)).toBeChecked({ checked: fault === 'write' })
    expect(await page.evaluate(() => window.preferenceTestRead())).toBe(record ?? null)
    const ioCount = await page.evaluate(() => window.preferenceTestIO.length)
    await settings.getByRole('button', { name: '取消', exact: true }).click()
    await enterAlbum(page)
    await enterReader(page)
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    expect(await page.evaluate(() => window.preferenceTestIO.length)).toBe(ioCount)
    const reopened = await openSettings(page)
    await expect(ui.storageStatus(reopened)).toHaveAttribute('role', 'alert')
    expect(await page.evaluate(() => window.preferenceTestIO.length)).toBe(ioCount)
    if (fault === 'delete') {
      await reopened.getByRole('button', { name: '重试删除已保存设置', exact: true }).click()
      await expect(ui.storageStatus(reopened)).toHaveAttribute('role', 'alert')
      expect(await page.evaluate(() => window.preferenceTestRead())).toBe(record)
    }
  })
}

test('invalid explicit URL gateway fails closed rather than using a saved preference', async ({ page, previewFixtures, network }) => {
  await instrumentStorage(page, JSON.stringify({ ...defaults, gateways: [FIXTURE_GATEWAYS.fast] }))
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, ['http://127.0.0.1/private']))
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(ui.reader(page)).toHaveCount(0)
  expect(network.bridge.routes).toEqual([])
  expect(network.slow.requests.length + network.fast.requests.length).toBe(0)
})

test.describe('explicit default gateways', () => {
  test.use({ allowDefaultGateways: true })
  test('restore defaults applies only final defaults without an intermediate saved-gateway request', async ({ page, previewFixtures, network }) => {
    await instrumentStorage(page, JSON.stringify({ ...defaults, gateways: [FIXTURE_GATEWAYS.slow] }))
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, {}, [FIXTURE_GATEWAYS.fast]))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const before = network.bridge.routes.length
    const settings = await openSettings(page)
    await settings.getByRole('button', { name: '恢复默认并应用', exact: true }).click()
    await expect(ui.settingsDialog(page)).toHaveCount(0)
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    expect(await savedRecord(page)).toEqual(defaults)
    await expect.poll(() => network.bridge.routes.length).toBeGreaterThan(before)
    expect(network.bridge.routes.slice(before).every(route => DEFAULT_GATEWAYS.includes(new URL(route.url).origin))).toBe(true)
    expect(network.slow.requests).toHaveLength(0)
    const gateways = new URL(page.url()).searchParams.getAll('gateway')
    expect(gateways.length === 0 || JSON.stringify(gateways) === JSON.stringify(DEFAULT_GATEWAYS)).toBe(true)
  })
})
