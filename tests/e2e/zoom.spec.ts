import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { ui, openReaderTools, openPanel, enterAlbum, expectReaderImage, expectImageBytes, expectVideoBytes, expectDownloadBytes, expectNoHorizontalOverflow, screenshot } from './gallery-ui'
import type { BrowserContext, CDPSession, Locator, Page } from '@playwright/test'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const browserZoomTest = test.extend({
  context: async ({ playwright, headless, network }, use, testInfo) => {
    const profile = testInfo.outputPath('owned-browser-profile')
    const receipt = testInfo.outputPath('owned-browser.json')
    await writeFile(receipt, JSON.stringify({ profile, owner: testInfo.testId, closed: false }))
    await mkdir(profile)
    let context: BrowserContext | undefined
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        channel: 'chrome', headless, serviceWorkers: 'allow', baseURL: network.baseURL,
        args: ['--disable-extensions', '--disable-sync', ...network.chromiumArgs],
      })
      await use(context)
    }
    finally {
      await context?.close()
      const resolved = await realpath(profile)
      expect(basename(resolved)).toBe('owned-browser-profile')
      expect(dirname(resolved)).toBe(await realpath(testInfo.outputDir))
      await rm(resolved, { recursive: true })
      await writeFile(receipt, JSON.stringify({ profile, owner: testInfo.testId, closed: true, removed: true }))
    }
  },
})

async function setBrowserZoom(page: Page, factor: number) {
  const settings = await page.context().newPage()
  try {
    await settings.goto('chrome://settings/appearance')
    await settings.evaluate(value => new Promise<void>(resolve => Reflect.get(globalThis, 'chrome').settingsPrivate.setDefaultZoom(value, resolve)), factor)
  } finally { await settings.close() }
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 480 })
})

async function zoom200(page: Page) {
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function reachable(control: Locator, scroll = true) {
  if (scroll) await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
  const geometry = await control.evaluate(element => {
    const box = element.getBoundingClientRect()
    const scale = Number(getComputedStyle(document.documentElement).zoom)
    const hits = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => {
      const hit = document.elementFromPoint(box.left + box.width * x!, box.top + box.height * y!)
      return { owned: !!hit && element.contains(hit), target: hit?.outerHTML.slice(0, 250) }
    })
    let visible = { left: Math.max(0, box.left), right: Math.min(innerWidth, box.right), top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom) }
    const clips = []
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const bounds = ancestor.getBoundingClientRect()
      const clip = {
        left: bounds.left + Number.parseFloat(style.borderLeftWidth) * scale,
        right: bounds.right - Number.parseFloat(style.borderRightWidth) * scale,
        top: bounds.top + Number.parseFloat(style.borderTopWidth) * scale,
        bottom: bounds.bottom - Number.parseFloat(style.borderBottomWidth) * scale,
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        visible = { ...visible, left: Math.max(visible.left, clip.left), right: Math.min(visible.right, clip.right) }
        clips.push({ axis: 'x', ...clip })
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        visible = { ...visible, top: Math.max(visible.top, clip.top), bottom: Math.min(visible.bottom, clip.bottom) }
        clips.push({ axis: 'y', ...clip })
      }
      if (ancestor.matches('[role="dialog"]')) break
    }
    return { name: element.getAttribute('aria-label') ?? element.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width / scale, height: box.height / scale, visibleWidth: Math.max(0, visible.right - visible.left) / scale, visibleHeight: Math.max(0, visible.bottom - visible.top) / scale, clips, viewportWidth: innerWidth, viewportHeight: innerHeight, hits }
  })
  await test.info().attach('target-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.width).toBeGreaterThanOrEqual(44)
  expect(geometry.height).toBeGreaterThanOrEqual(44)
  expect(geometry.visibleWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(44)
  expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(44)
  expect(geometry.visibleWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.width - 0.5)
  expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.height - 0.5)
  expect(geometry.hits.every(hit => hit.owned), JSON.stringify(geometry)).toBe(true)
}

async function nativeVideoControlsExposed(video: Locator) {
  const geometry = await video.evaluate(element => {
    const box = element.getBoundingClientRect()
    const scale = Number(getComputedStyle(document.documentElement).zoom)
    const points = [20 * scale, box.width / 4, box.width / 2, box.width * 3 / 4, box.width - 20 * scale].flatMap(x =>
      [12, 24].map(inset => {
        const y = box.bottom - inset * scale
        const hit = document.elementFromPoint(box.left + x, y)
        return { x: box.left + x, y, owned: !!hit && element.contains(hit), target: hit?.outerHTML.slice(0, 250) }
      }))
    return { left: box.left, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, points }
  })
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.points.every(point => point.owned), JSON.stringify(geometry)).toBe(true)
}

async function clickNativeVideoControl(page: Page, cdp: CDPSession, selector: string) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  type Node = typeof root
  const findVideo = (node: Node): Node | undefined => node.nodeName === 'VIDEO' ? node : node.children?.map(findVideo).find(Boolean)
  const shadow = findVideo(root)?.shadowRoots?.find(node => node.shadowRootType === 'user-agent')
  expect(shadow).toBeDefined()
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow!.nodeId, selector })
  expect(nodeId).not.toBe(0)
  const { object } = await cdp.send('DOM.resolveNode', { nodeId })
  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, display: getComputedStyle(this).display } }',
      returnByValue: true,
    })
    const point = result.value as { x: number; y: number; width: number; height: number; display: string }
    expect(point.display).not.toBe('none')
    expect(point.width).toBeGreaterThan(0)
    expect(point.height).toBeGreaterThan(0)
    // The UA shadow tree is inspection-only; activation is a real pointer action.
    const hit = await cdp.send('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true })
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: -1 })
    const owns = (node: Node): boolean => node.backendNodeId === hit.backendNodeId || !!node.children?.some(owns)
    expect(owns(node), JSON.stringify({ selector, point, hit })).toBe(true)
    await page.mouse.click(point.x, point.y)
  } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId! }) }
}

test('320x240 keeps every reader tool and menu control at least 44px and physically hittable', async ({ page, previewFixtures }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 240 })
  const current = previewFixtures.items[1]!
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, { item: current.id }))
  await expectReaderImage(page, current.original.bytes)
  await reachable(ui.menuButton(page))
  await openReaderTools(page)
  for (const control of [ui.closePanel(page), ui.next(page), ui.previous(page), ui.zoomIn(page), ui.resetZoom(page), ui.download(ui.readerTools(page))]) await expect(control).toBeVisible()
  for (const control of await ui.readerTools(page).getByRole('button').all()) await reachable(control)
  await screenshot(page, testInfo, 'reader-short-screen')
  await ui.next(page).click()
  await expectReaderImage(page, previewFixtures.items[2]!.original.bytes)
  await ui.menuButton(page).click()
  await expect(ui.dialog(page)).toHaveCount(1)
  for (const control of await ui.dialog(page).getByRole('button').all()) await reachable(control)
  await screenshot(page, testInfo, 'menu-short-screen')
  await ui.albumAction(page).click()
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(0)
})

test('320x480 at 200% keeps long-name reader navigation and menu reachable', async ({ page, previewFixtures }, testInfo) => {
  const last = previewFixtures.items.at(-1)!
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, { item: last.id }))
  await expectReaderImage(page, last.original.bytes)
  await zoom200(page)
  await openReaderTools(page)
  await expectNoHorizontalOverflow(page)
  for (const control of await ui.readerTools(page).getByRole('button').all()) await reachable(control)
  await reachable(ui.previous(page))
  await ui.previous(page).click()
  await expectReaderImage(page, previewFixtures.items.at(-2)!.original.bytes)
  await openReaderTools(page)
  await reachable(ui.next(page))
  await ui.next(page).click()
  await expectReaderImage(page, last.original.bytes)
  await reachable(ui.menuButton(page))
  await screenshot(page, testInfo, 'reader-zoom')
  await ui.menuButton(page).click()
  await expect(ui.dialog(page)).toHaveCount(1)
  for (const control of await ui.dialog(page).getByRole('button').all()) await reachable(control)
  await screenshot(page, testInfo, 'menu-zoom')
  await ui.closePanel(page).click()
  await expect(ui.menuButton(page)).toBeFocused()
})

browserZoomTest('320x480 at 200% scrolls the full 44px video info and download targets into view without covering native controls', async ({ page, context, galleryFixtures, network }, testInfo) => {
  await page.goto(sourceUrl('cid', galleryFixtures.video.ref))
  const video = ui.reader(page).locator('video')
  await expectVideoBytes(video, galleryFixtures.video.bytes)
  const reads = network.bridge.routes.length
  const url = page.url()
  const historyLength = await page.evaluate(() => history.length)
  await zoom200(page)
  await reachable(ui.menuButton(page))
  await nativeVideoControlsExposed(video)
  await openReaderTools(page)
  await expectNoHorizontalOverflow(page)
  const info = ui.readerInfo(page)
  await reachable(info)
  await screenshot(page, testInfo, 'video-info-target-zoom')
  await info.click()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.dialog(page)).toHaveAttribute('aria-modal', 'true')
  expect(await ui.reader(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
  await reachable(ui.closePanel(page))
  await ui.closePanel(page).click()
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeFocused()
  await openReaderTools(page)
  const download = ui.download(ui.readerTools(page))
  await reachable(download)
  await screenshot(page, testInfo, 'video-download-target-zoom')
  await expectDownloadBytes(page, ui.readerTools(page), galleryFixtures.video.bytes)
  for (const control of await ui.readerTools(page).getByRole('button').all()) await reachable(control)
  await page.keyboard.press('Escape')
  await nativeVideoControlsExposed(video)
  // CSS zoom stresses application geometry; native popovers use real browser zoom.
  await page.evaluate(() => { document.documentElement.style.zoom = '1' })
  await setBrowserZoom(page, 2)
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight, cssZoom: getComputedStyle(document.documentElement).zoom, pinch: visualViewport!.scale }))).toEqual({ width: 160, height: 240, cssZoom: '1', pinch: 1 })
  for (const control of await page.getByRole('button').all()) await reachable(control)
  await nativeVideoControlsExposed(video)
  await screenshot(page, testInfo, 'video-real-browser-200')
  await video.focus()
  for (const key of ['ArrowLeft', 'ArrowRight', 'm', 'Enter']) await page.keyboard.press(key)
  await expect(ui.reader(page)).toHaveCount(1)
  await expect(ui.menuButton(page)).toBeVisible()
  expect(page.url()).toBe(url)
  await video.evaluate((element: HTMLVideoElement) => element.pause())
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)
  await page.keyboard.press('ArrowLeft')
  const cdp = await context.newCDPSession(page)
  try {
    const box = await video.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 20)
    const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
    await clickNativeVideoControl(page, cdp, '[pseudo="-internal-media-controls-button-panel"] [pseudo="-webkit-media-controls-play-button"]')
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before)
    await video.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)
  } finally { if (!page.isClosed()) await cdp.detach() }
  await expectVideoBytes(video, galleryFixtures.video.bytes)
  await expectNoHorizontalOverflow(page)
  expect(network.bridge.routes).toHaveLength(reads)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

test('pending source cancel and retry stay reachable at 200% through real Worker requests', async ({ page, previewFixtures, network }, testInfo) => {
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(previewFixtures.manifest.cid, { kind: 'delay', milliseconds: 15000 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expect.poll(() => [...network.slow.requests, ...network.fast.requests].some(request => request.cid === previewFixtures.manifest.cid)).toBe(true)
  await zoom200(page)
  await reachable(ui.cancelSource(page))
  await expectNoHorizontalOverflow(page)
  await screenshot(page, testInfo, 'pending-source-zoom')
  await ui.cancelSource(page).click()
  await expect(page.getByRole('heading', { name: '读取已取消', exact: true })).toBeVisible()
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(previewFixtures.manifest.cid, undefined)
  const retry = page.getByRole('button', { name: '重新读取', exact: true })
  await reachable(retry)
  await retry.click()
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await expectNoHorizontalOverflow(page)
})

test('album and all tool panels reflow at 200% without clipping close or recovery controls', async ({ page, previewFixtures }, testInfo) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await zoom200(page)
  await enterAlbum(page)
  await expectNoHorizontalOverflow(page)
  const last = ui.tile(page, previewFixtures.items.at(-1)!.title)
  await last.focus()
  await expect(last).toBeFocused()
  for (const item of previewFixtures.items.slice(-6)) await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const album = ui.album(page)
  const scroll = await album.evaluate(element => {
    const box = element.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    return { x, y, delta: element.scrollHeight * Number(getComputedStyle(document.documentElement).zoom), owned: element.contains(document.elementFromPoint(x, y)) }
  })
  expect(scroll.owned).toBe(true)
  await page.mouse.move(scroll.x, scroll.y)
  await page.mouse.wheel(0, scroll.delta)
  await expect.poll(() => album.evaluate(element => element.scrollTop >= element.scrollHeight - element.clientHeight - 1)).toBe(true)
  await reachable(last, false)
  await screenshot(page, testInfo, 'album-last-zoom')
  await last.click()
  await expectReaderImage(page, previewFixtures.items.at(-1)!.original.bytes)
  for (const panel of ['source', 'filters', 'info', 'network'] as const) {
    await openPanel(page, panel)
    await expect(ui.dialog(page)).toHaveCount(1)
    expect(await ui.dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await reachable(ui.closePanel(page))
    await expectNoHorizontalOverflow(page)
    await screenshot(page, testInfo, `${panel}-zoom`)
    if (panel === 'network') {
      const remember = ui.remember(ui.settingsDialog(page))
      await remember.scrollIntoViewIfNeeded()
      await remember.check()
      await expect(remember).toBeChecked()
      const clear = ui.clearSaved(ui.settingsDialog(page))
      await reachable(clear)
      await clear.click()
      await expect(remember).not.toBeChecked()
      expect(await page.evaluate(() => localStorage.getItem('ipfs-gallery.preferences.v1'))).toBeNull()
      const cancel = ui.settingsDialog(page).getByRole('button', { name: '取消', exact: true })
      await reachable(cancel)
      await cancel.click()
    } else await ui.closePanel(page).click()
    await expect(ui.menuButton(page)).toBeFocused()
  }
})
