import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { ui, openReaderTools, openPanel, expectReaderImage, screenshot, expectDownloadBytes, enterAlbum, submitSource } from './gallery-ui'
import { importBytes } from 'ipfs-unixfs-importer'
import { contentUri } from '../fixtures/unixfs'
import type { Page, TestInfo } from '@playwright/test'

async function verifyMenuPng(page: Page, testInfo: TestInfo, name: string, alpha: number) {
  await expect.poll(() => ui.menuButton(page).evaluate(element => {
    const rgba = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number)
    return rgba[3] ?? 1
  })).toBeCloseTo(alpha, 2)
  const png = await page.screenshot({ path: testInfo.outputPath(`${name}-composite.png`) })
  const result = await page.evaluate(async base64 => {
    const menu = document.querySelector<HTMLButtonElement>('.reader-menu-trigger')!
    const style = getComputedStyle(menu)
    const box = menu.getBoundingClientRect()
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const x = Math.round(box.x + 8), y = Math.round(box.y + 8)
    const actual = Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(document.querySelector<HTMLImageElement>('.reader-stage img')!, 0, 0, innerWidth, innerHeight)
    const below = Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = style.backgroundColor
    context.fillRect(0, 0, 1, 1)
    const background = Array.from(context.getImageData(0, 0, 1, 1).data)
    const a = background[3]! / 255
    const expected = below.map((channel, index) => Math.round(background[index]! * a + channel * (1 - a)))
    const luminance = (channels: number[]) => channels.reduce((sum, value, index) => {
      const channel = value / 255
      return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!
    }, 0)
    const contrast = [style.color].map(color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
      const foreground = Array.from(context.getImageData(0, 0, 1, 1).data)
      const ink = actual.map((channel, index) => foreground[index]! * foreground[3]! / 255 + channel * (1 - foreground[3]! / 255))
      return (Math.max(luminance(ink), luminance(actual)) + .05) / (Math.min(luminance(ink), luminance(actual)) + .05)
    })
    return { actual, below, background, expected, contrast, alpha: a, opacity: style.opacity, filter: style.backdropFilter, shadow: style.boxShadow }
  }, png.toString('base64'))
  await testInfo.attach(name, { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.alpha).toBeCloseTo(alpha, 2)
  expect(result.opacity).toBe('1')
  for (const ratio of result.contrast) expect(ratio).toBeGreaterThanOrEqual(3)
  for (let channel = 0; channel < 3; channel += 1) {
    const lower = result.background[channel]! * result.alpha
    const upper = lower + 255 * (1 - result.alpha)
    expect(result.actual[channel]!).toBeGreaterThanOrEqual(Math.floor(lower) - 2)
    expect(result.actual[channel]!).toBeLessThanOrEqual(Math.ceil(upper) + 2)
    if (!name.startsWith('checker')) expect(Math.abs(result.actual[channel]! - result.expected[channel]!)).toBeLessThanOrEqual(2)
  }
}

test('persistent menu, portal DOM keyboard boundary and single close focus', async ({ page, previewFixtures }, testInfo) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await expect(page.getByRole('button')).toHaveCount(1)
  await expect(ui.menuButton(page)).toBeVisible()
  await ui.reader(page).getByRole('img').click()
  await expect(page.getByRole('button')).toHaveCount(1)
  await ui.reader(page).focus()
  await page.keyboard.press('Tab')
  await expect(ui.menuButton(page)).toBeFocused()
  await openReaderTools(page)
  await expect(ui.next(page)).toBeFocused()
  await expect(ui.previous(page)).toBeDisabled()
  await ui.zoomIn(page).click()
  await expect(ui.readerTools(page).getByRole('status', { name: '缩放比例' })).toHaveText('150%')
  await ui.readerInfo(page).focus()
  await page.keyboard.press('Tab')
  await expect(ui.back(page)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(ui.readerInfo(page)).toBeFocused()
  await ui.readerInfo(page).dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
  await ui.readerInfo(page).dispatchEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true })
  await expect(ui.readerTools(page)).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.escapedPortalKey = 'false'
    document.body.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.documentElement.dataset.escapedPortalKey = 'true'
    }, { once: true })
  })
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.documentElement.dataset.escapedPortalKey)).toBe('false')
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeFocused()
  await screenshot(page, testInfo, 'reader-persistent-menu')
})

test('tools reuse media and source, download exact bytes, Album handoff is explicit', async ({ page, previewFixtures, network }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const original = await ui.reader(page).getByRole('img').elementHandle()
  const reads = network.bridge.routes.length
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), previewFixtures.items[0]!.original.bytes)
  await page.keyboard.press('Escape')
  expect(await original!.evaluate(element => element.isConnected)).toBe(true)
  expect(network.bridge.routes).toHaveLength(reads)
  await enterAlbum(page)
  await openReaderTools(page)
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await expect(ui.readerTools(page)).toBeVisible()
  await ui.next(page).click()
  await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.reader(page)).toBeFocused()
  await original!.dispose()
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`menu states retain contrast over bright, dark and high-contrast media with ${reducedMotion} motion`, async ({ page, galleryFixtures }, testInfo) => {
    await page.emulateMedia({ reducedMotion })
    await page.setViewportSize({ width: 375, height: 375 })
    for (const backdrop of ['bright', 'dark', 'checker'] as const) {
      const pixels = await page.evaluate(async backdrop => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 128
        const context = canvas.getContext('2d')!
        context.fillStyle = backdrop === 'dark' ? '#000' : '#fff'
        context.fillRect(0, 0, 128, 128)
        if (backdrop === 'checker') {
          context.fillStyle = '#000'
          for (let y = 0; y < 128; y += 8) for (let x = 0; x < 128; x += 8) if ((x + y) % 16 === 0) context.fillRect(x, y, 8, 8)
        }
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      }, backdrop)
      const bytes = Uint8Array.from(pixels)
      const { cid } = await importBytes(bytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
      await page.goto(sourceUrl('cid', { cid: cid.toV1().toString(), path: [] }))
      await expectReaderImage(page, bytes)
      const menu = ui.menuButton(page)
      await page.mouse.move(300, 300)
      await verifyMenuPng(page, testInfo, `${backdrop}-default-${reducedMotion}`, .88)
      await screenshot(page, testInfo, `${backdrop}-default-${reducedMotion}`)
      await menu.hover()
      await verifyMenuPng(page, testInfo, `${backdrop}-hover-${reducedMotion}`, .98)
      await screenshot(page, testInfo, `${backdrop}-hover-${reducedMotion}`)
      await ui.reader(page).focus()
      await page.keyboard.press('Tab')
      await expect(menu).toBeFocused()
      const contrast = await menu.evaluate(element => {
        const style = getComputedStyle(element)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        const rgba = (color: string) => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const luminance = (channels: number[]) => channels.reduce((sum, value, index) => {
          const c = value / 255
          return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!
        }, 0)
        const ratio = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
        const background = rgba(style.backgroundColor)
        const icon = rgba(style.color)
        const focus = rgba(style.outlineColor)
        const composites = [0, 255].map(shade => background.slice(0, 3).map(channel => channel * background[3]! / 255 + shade * (1 - background[3]! / 255)))
        const box = element.getBoundingClientRect()
        const svg = element.querySelector('svg')!.getBoundingClientRect()
        return { icon: composites.map(bg => ratio(icon.slice(0, 3), bg)), focus: composites.map(bg => ratio(focus.slice(0, 3), bg)), alpha: { icon: icon[3], focus: focus[3] }, outline: parseFloat(style.outlineWidth), menu: { width: box.width, height: box.height }, svg: { width: svg.width, height: svg.height } }
      })
      await testInfo.attach(`${backdrop}-contrast-${reducedMotion}`, { body: JSON.stringify(contrast), contentType: 'application/json' })
      for (const ratio of [...contrast.icon, ...contrast.focus]) expect(ratio).toBeGreaterThanOrEqual(3)
      expect(contrast.alpha).toEqual({ icon: 255, focus: 255 })
      expect(contrast.outline).toBe(2)
      expect(contrast.menu).toEqual({ width: 48, height: 48 })
      expect(contrast.svg).toEqual({ width: 20, height: 20 })
      await verifyMenuPng(page, testInfo, `${backdrop}-focus-${reducedMotion}`, .98)
      await screenshot(page, testInfo, `${backdrop}-focus-${reducedMotion}`)
      const box = await menu.boundingBox()
      await page.mouse.move(box!.x + 24, box!.y + 24)
      await page.mouse.down()
      await verifyMenuPng(page, testInfo, `${backdrop}-pressed-${reducedMotion}`, 1)
      await screenshot(page, testInfo, `${backdrop}-pressed-${reducedMotion}`)
      await page.mouse.up()
      await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
      await page.keyboard.press('Escape')
      await expect(menu).toBeFocused()
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), bytes)
      await page.keyboard.press('Escape')
    }
  })
}

test('copy failure preserves the full value; late old-item and old-source results do not change current tools or focus', async ({ page, previewFixtures, galleryFixtures }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } })
  })
  await openReaderTools(page)
  await ui.readerTools(page).getByRole('button', { name: '复制原始地址', exact: true }).click()
  await expect(ui.readerTools(page).getByRole('status').filter({ hasText: '复制失败' })).toContainText(contentUri(previewFixtures.items[0]!.original.ref))
  for (const replacement of ['item', 'source'] as const) {
    await page.evaluate(() => {
      Reflect.set(window, 'resolveReaderCopy', undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(resolve => Reflect.set(window, 'resolveReaderCopy', resolve)) } })
    })
    await ui.readerTools(page).getByRole('button', { name: '复制 CID', exact: true }).click()
    if (replacement === 'item') {
      await ui.next(page).click()
      await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
      await openReaderTools(page)
    } else {
      await submitSource(page, contentUri(galleryFixtures.manifests.standalone.ref))
      await expectReaderImage(page, galleryFixtures.raw.bytes)
      await openPanel(page, 'source')
    }
    const focused = await page.evaluateHandle(() => document.activeElement)
    await page.evaluate(() => Reflect.get(window, 'resolveReaderCopy')())
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(await focused.evaluate(element => element === document.activeElement)).toBe(true)
    await expect(ui.dialog(page).locator('.reader-notice[role="status"]')).toHaveCount(0)
    await focused.dispose()
  }
})

test('download failure is recoverable; same-item feedback survives closing tools and selection clears it', async ({ page, previewFixtures }, testInfo) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await page.evaluate(() => {
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      HTMLAnchorElement.prototype.click = click
      throw new Error('download dispatch denied')
    }
  })
  await openReaderTools(page)
  await ui.download(ui.readerTools(page)).click()
  await expect(ui.readerTools(page).getByRole('status').filter({ hasText: '下载失败' })).toBeVisible()
  await expect(ui.download(ui.readerTools(page))).toBeEnabled()
  await screenshot(page, testInfo, 'download-failure')
  await expectDownloadBytes(page, ui.readerTools(page), previewFixtures.items[0]!.original.bytes)
  await expect(ui.download(ui.readerTools(page))).toBeDisabled()
  await page.keyboard.press('Escape')
  await openReaderTools(page)
  await expect(ui.download(ui.readerTools(page))).toBeEnabled()
  await expect(ui.readerTools(page).getByRole('status').filter({ hasText: '已开始下载' })).toBeVisible()
  await screenshot(page, testInfo, 'download-success')
  await expectDownloadBytes(page, ui.readerTools(page), previewFixtures.items[0]!.original.bytes)
  await ui.next(page).click()
  await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
  await openReaderTools(page)
  await expect(ui.readerTools(page).locator('.reader-notice[role="status"]')).toHaveCount(0)
  await expect(ui.download(ui.readerTools(page))).toBeEnabled()
})
