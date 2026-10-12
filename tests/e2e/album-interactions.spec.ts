import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { READER_GESTURE_THRESHOLDS } from '../../src/hooks/readerInteraction'
import { ui, enterAlbum, expectReaderImage, expectImageBytes, expectVideoBytes } from './gallery-ui'

test.describe('album pointer sequences', () => {
  test.use({ hasTouch: true })

  test.beforeEach(async ({ page, previewFixtures }) => {
    await page.setViewportSize({ width: 375, height: 480 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await enterAlbum(page)
    await page.keyboard.press('Escape')
    await expect(ui.album(page)).toBeVisible()
    await expect(ui.menuButton(page)).toHaveCount(0)
  })

  test('native touch scrolling keeps the album, current item and hidden chrome unchanged', async ({ page, context, previewFixtures, network }) => {
    const url = page.url()
    const before = await ui.album(page).evaluate(element => element.scrollTop)
    const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${previewFixtures.manifest.cid}`)).length
    const initialReads = sourceReads()
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 330, id: 1 }] })
      for (const y of [290, 230, 170, 90]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y, id: 1 }] })
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect.poll(() => ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(before)
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
      expect(sourceReads()).toBe(initialReads)
    } finally { await cdp.detach() }
  })

  test('horizontal swipes are not reader navigation or chrome toggles in the album', async ({ page, context }) => {
    const url = page.url()
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 290, y: 70, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 70, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
    } finally { await cdp.detach() }
  })

  test('a drag returning to its starting point is not a tile click or gutter chrome toggle', async ({ page, previewFixtures }) => {
    const url = page.url()
    const box = await ui.tile(page, previewFixtures.items[0]!.title).boundingBox()
    for (const point of [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, { x: 4, y: 200 }]) {
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.mouse.move(point.x, point.y + READER_GESTURE_THRESHOLDS.movement * 2, { steps: 3 })
      await page.mouse.move(point.x, point.y, { steps: 3 })
      await page.mouse.up()
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
    }
  })

  test('long presses on a tile or gutter do not select media or reveal tools; a fresh mouse click still works', async ({ page, previewFixtures }) => {
    const url = page.url()
    const tile = ui.tile(page, previewFixtures.items[0]!.title)
    const box = await tile.boundingBox()
    for (const point of [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, { x: 4, y: 200 }]) {
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      await page.waitForTimeout(READER_GESTURE_THRESHOLDS.longPressMs + 50)
      await page.mouse.up()
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
    }
    await page.mouse.click(4, 200)
    await expect(ui.menuButton(page)).toBeVisible()
    expect(page.url()).toBe(url)
    await page.keyboard.press('Escape')
    await tile.click()
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
  })

  test('cancelled pointers suppress late clicks and context-menu suppression does not block keyboard activation', async ({ page, context, previewFixtures }) => {
    const url = page.url()
    const first = previewFixtures.items[0]!
    const tile = ui.tile(page, first.title)
    const box = await tile.boundingBox()
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + 30, y: box!.y + 30, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      await tile.dispatchEvent('click', { detail: 1, bubbles: true })
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
      await tile.dispatchEvent('contextmenu', { bubbles: true })
      await tile.focus()
      await page.keyboard.press('Enter')
      await expectReaderImage(page, first.original.bytes)
      expect(new URL(page.url()).searchParams.get('item')).toBe(first.id)
      await expect(ui.menuButton(page)).toBeVisible()
    } finally { await cdp.detach() }
  })

  test('stationary multi-touch does not become a tile activation or chrome tap', async ({ page, context, previewFixtures }) => {
    const url = page.url()
    const first = previewFixtures.items[0]!
    const box = await ui.tile(page, first.title).boundingBox()
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
        { x: box!.x + 30, y: box!.y + 30, id: 1 },
        { x: box!.x + 80, y: box!.y + 30, id: 2 },
      ] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(ui.album(page)).toBeVisible()
      await expect(ui.menuButton(page)).toHaveCount(0)
      expect(page.url()).toBe(url)
      await ui.tile(page, first.title).tap()
      await expectReaderImage(page, first.original.bytes)
      await expect(ui.menuButton(page)).toBeVisible()
    } finally { await cdp.detach() }
  })
})

test.describe('album blank-space touch', () => {
  test.use({ hasTouch: true })

  test('native touch taps on generous album blank space toggle chrome without selecting media', async ({ page, galleryFixtures }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 480 })
    await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
    await expectReaderImage(page, galleryFixtures.raw.bytes)
    await enterAlbum(page)
    await page.keyboard.press('Escape')
    const album = ui.album(page)
    await expect(ui.tiles(page)).toHaveCount(1)
    await expectImageBytes(ui.tiles(page).locator('..').locator('img'), galleryFixtures.raw.bytes)
    const box = await album.boundingBox()
    const tile = await ui.tiles(page).boundingBox()
    const bottom = tile!.y + tile!.height
    expect(box!.y + box!.height - bottom).toBeGreaterThan(80)
    const point = { x: box!.x + box!.width / 2, y: (bottom + box!.y + box!.height) / 2 }
    type ObservedAlbum = HTMLElement & { touchTargets: { type: string; pointerType: string; trusted: boolean; targetIsBlank: boolean }[] }
    await album.evaluate(element => {
      const observed = element as ObservedAlbum
      observed.touchTargets = []
      for (const type of ['pointerdown', 'click']) element.addEventListener(type, event => {
        const target = event.target
        observed.touchTargets.push({ type: event.type, pointerType: (event as PointerEvent).pointerType, trusted: event.isTrusted,
          targetIsBlank: target instanceof Element && element.contains(target) && !target.closest('button,video,[data-album-id]') })
      }, true)
    })
    const url = page.url()
    await page.touchscreen.tap(point.x, point.y)
    await expect(ui.menuButton(page)).toBeVisible()
    await page.touchscreen.tap(point.x, point.y)
    await expect(ui.menuButton(page)).toHaveCount(0)
    await expect(album).toBeVisible()
    expect(page.url()).toBe(url)
    const targets = await album.evaluate(element => (element as ObservedAlbum).touchTargets)
    expect(targets).toEqual(['pointerdown', 'click', 'pointerdown', 'click'].map(type => ({ type, pointerType: 'touch', trusted: true, targetIsBlank: true })))
    await testInfo.attach('native-touch-targets', { body: JSON.stringify({ point, targets }), contentType: 'application/json' })
  })
})

test('album video controls keep native playback and keys without selecting a reader item', async ({ page, galleryFixtures }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.json.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await enterAlbum(page)
  await ui.tile(page, '短片影像').scrollIntoViewIfNeeded()
  await page.keyboard.press('Escape')
  const video = ui.tile(page, '短片影像').locator('..').locator('video')
  await expectVideoBytes(video, galleryFixtures.video.bytes)
  const url = page.url()
  await video.focus()
  for (const key of ['ArrowLeft', 'ArrowRight', 'm']) await page.keyboard.press(key)
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.menuButton(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  const keyboardStart = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await video.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(keyboardStart)
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.menuButton(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)
  const pointerStart = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  const box = await video.boundingBox()
  await video.click({ position: { x: 20, y: box!.height - 30 } })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(pointerStart)
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.menuButton(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  await video.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true)
})

test('album retry is independent of tile selection and consumes no chrome command', async ({ page, galleryFixtures, network }) => {
  for (const gateway of [network.slow, network.fast]) {
    gateway.setBlockMode(galleryFixtures.thumbnail.cid, { kind: '404' })
    gateway.setBlockMode(galleryFixtures.dagPb.cid, { kind: '404' })
  }
  await page.goto(sourceUrl('unixfs', galleryFixtures.thumbnailGallery.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await enterAlbum(page)
  await page.keyboard.press('Escape')
  const retry = ui.album(page).getByRole('button', { name: '重试 第二原图', exact: true })
  await expect(retry).toBeVisible()
  const originalReads = () => [...network.slow.requests, ...network.fast.requests].filter(record => record.method === 'GET' && record.cid === galleryFixtures.dagPb.cid)
  expect(originalReads().map(record => record.status)).toEqual([404, 404])
  const url = page.url()
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(galleryFixtures.dagPb.cid, undefined)
  await retry.click()
  await expectImageBytes(ui.tileImage(page, '第二原图'), galleryFixtures.dagPb.bytes)
  expect(originalReads()).toHaveLength(3)
  expect(originalReads().filter(record => record.status === 200)).toHaveLength(1)
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.menuButton(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
})
