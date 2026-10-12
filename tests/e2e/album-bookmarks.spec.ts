import type { Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { importBytes } from 'ipfs-unixfs-importer'
import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { contentUri } from '../fixtures/unixfs'
import { ui, enterAlbum, openMenu, openPanel, submitSource, expectReaderImage, expectImageBytes } from './gallery-ui'

async function settleLayout(page: Page) {
  await ui.album(page).evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function bookmark(page: Page) {
  return ui.album(page).evaluate(element => {
    const viewport = element.getBoundingClientRect()
    const tiles = Array.from(element.querySelectorAll<HTMLButtonElement>('button[aria-label^="打开 "]'), tile => {
      const box = tile.getBoundingClientRect()
      return { id: tile.dataset.albumSelect!, name: tile.getAttribute('aria-label')!, offset: box.top - viewport.top, left: box.left, top: box.top, bottom: box.bottom }
    })
    const visible = tiles.filter(tile => tile.bottom > viewport.top && tile.top < viewport.bottom)
    const anchor = visible.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]!
    return { id: anchor.id, name: anchor.name, offset: anchor.offset, scrollTop: element.scrollTop, tiles }
  })
}

async function expectAnchorOffset(page: Page, anchor: { id: string; name: string; offset: number }) {
  const tile = ui.album(page).getByRole('button', { name: anchor.name, exact: true })
  expect(anchor.id).toBeTruthy()
  await expect(tile).toHaveCount(1)
  await expect(tile).toHaveAttribute('data-album-select', anchor.id)
  await expect.poll(async () => {
    const box = await tile.boundingBox()
    const root = await ui.album(page).boundingBox()
    return Math.abs(box!.y - root!.y - anchor.offset)
  }).toBeLessThanOrEqual(2)
}

for (const width of [375, 768, 1280, 1600]) {
  for (const zoom of [1, 2]) {
    test(`album content geometry and last tile remain reachable at ${width}px CSS zoom ${zoom}`, async ({ page, previewFixtures }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
      await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
      await page.evaluate(value => { document.documentElement.style.zoom = String(value) }, zoom)
      await enterAlbum(page)
      await settleLayout(page)
      const geometry = await ui.album(page).evaluate(root => {
        const list = root.querySelector('ul')!
        const style = getComputedStyle(root)
        const number = (token: string) => Number.parseFloat(style.getPropertyValue(token))
        const contentWidth = Number.parseFloat(getComputedStyle(list).width)
        const columns = contentWidth >= number('--album-column-5-min') ? 5 : contentWidth >= number('--album-column-4-min') ? 4 : contentWidth >= number('--album-column-3-min') ? 3 : 2
        const tiles = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-album-select]'))
        const gap = number('--album-gap')
        return { contentWidth, visualWidth: list.getBoundingClientRect().width, columns,
          tileWidth: Number.parseFloat(tiles[0]!.parentElement!.style.width), expectedTileWidth: (contentWidth - gap * (columns - 1)) / columns,
          actualColumns: new Set(tiles.map(tile => Math.round(tile.getBoundingClientRect().left))).size,
          horizontalOverflow: root.scrollWidth - root.clientWidth }
      })
      await testInfo.attach('album-content-geometry', { body: JSON.stringify({ width, zoom, ...geometry }), contentType: 'application/json' })
      expect(geometry.actualColumns).toBe(geometry.columns)
      expect(Math.abs(geometry.tileWidth - geometry.expectedTileWidth)).toBeLessThanOrEqual(0.02)
      expect(geometry.horizontalOverflow).toBe(0)
      const item = previewFixtures.items.at(-1)!
      const tile = ui.tile(page, item.title)
      await tile.focus()
      await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
      await settleLayout(page)
      await expect(tile).toBeFocused()
      await ui.album(page).hover({ position: { x: 4, y: 400 } })
      await page.mouse.wheel(0, 10000)
      await expect.poll(() => ui.album(page).evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop)).toBeLessThanOrEqual(1)
      await settleLayout(page)
      const bounds = await tile.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800)
      expect(await tile.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('album-last-tile.png') })
      await tile.click()
      await expectReaderImage(page, item.original.bytes)
    })
  }
}

for (const operation of ['sort', 'retained-filter', 'removed-filter', 'resize'] as const) {
  test(`deep album ${operation} preserves the anchor or its nearest prior vertical survivor`, async ({ page, galleryFixtures, previewFixtures, network }, testInfo) => {
    let manifest = previewFixtures.manifest.ref
    const removed = previewFixtures.items[16]!
    if (operation === 'removed-filter') {
      const bytes = new TextEncoder().encode(JSON.stringify({
        version: 1,
        title: '画册书签夹具',
        items: previewFixtures.items.map(item => ({
          cid: item.original.cid, title: item.title, type: 'image', width: 96, height: 64,
          thumbnail: { cid: item.thumbnail.cid }, tags: [item.id === removed.id ? '移除锚点' : '继续浏览'],
        })),
      }))
      const { cid } = await importBytes(bytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
      manifest = { cid: cid.toV1().toString(), path: [] }
    }
    await page.setViewportSize({ width: 375, height: 400 })
    await page.goto(sourceUrl('meta', manifest))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await enterAlbum(page)
    const distant = previewFixtures.items[18]!
    await ui.tile(page, distant.title).focus()
    await expectImageBytes(ui.tileImage(page, distant.title), distant.thumbnail.bytes)
    await settleLayout(page)
    if (operation === 'removed-filter') {
      await expectImageBytes(ui.tileImage(page, removed.title), removed.thumbnail.bytes)
      await settleLayout(page)
      const tile = await ui.tile(page, removed.title).boundingBox()
      const root = await ui.album(page).boundingBox()
      const adjustment = tile!.y - root!.y - 16
      await ui.album(page).evaluate((element, delta) => { element.scrollTop += delta }, adjustment)
      await settleLayout(page)
    }
    const before = await bookmark(page)
    expect(before.scrollTop).toBeGreaterThan(400)
    if (operation === 'removed-filter') expect(before.name).toBe(`打开 ${removed.title}`)
    const bookmarkPath = testInfo.outputPath('album-bookmark-before.json')
    await writeFile(bookmarkPath, JSON.stringify(before, null, 2))
    await testInfo.attach('album-bookmark-before', { path: bookmarkPath, contentType: 'application/json' })
    const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${manifest.cid}`)).length
    const reads = sourceReads()
    const historyLength = await page.evaluate(() => history.length)
    if (operation === 'resize') {
      expect(new Set(before.tiles.map(tile => Math.round(tile.left))).size).toBe(2)
      await page.setViewportSize({ width: 768, height: 400 })
      await expect.poll(() => ui.tiles(page).evaluateAll(tiles => new Set(tiles.map(tile => Math.round(tile.getBoundingClientRect().left))).size)).toBe(3)
    } else {
      await openPanel(page, 'filters')
      if (operation === 'sort') {
        await ui.sort(page).selectOption('name')
        await expect(ui.sort(page)).toHaveValue('name')
      } else if (operation === 'retained-filter') {
        const query = before.name.match(/预览-\d/)![0]
        await ui.search(page).fill(query)
        await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(query)
      } else {
        await ui.tag(page, '继续浏览').click()
        await expect.poll(() => new URL(page.url()).searchParams.getAll('tag')).toEqual(['继续浏览'])
      }
      expect(await ui.album(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
      expect(await ui.dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await settleLayout(page)
      await expect(ui.menuButton(page)).toBeFocused()
    }
    if (operation === 'removed-filter') {
      await expect(ui.album(page).getByRole('button', { name: before.name, exact: true })).toHaveCount(0)
      await expect(ui.tiles(page)).toHaveCount(previewFixtures.items.length - 1)
      const nearest = before.tiles.filter(tile => tile.name !== before.name).reduce((best, tile) =>
        Math.abs(tile.offset - before.offset) < Math.abs(best.offset - before.offset) ? tile : best)
      expect(nearest.name).not.toBe(`打开 ${previewFixtures.items[0]!.title}`)
      const item = previewFixtures.items.find(item => `打开 ${item.title}` === nearest.name)!
      await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
      await expectAnchorOffset(page, { id: nearest.id, name: nearest.name, offset: before.offset })
      const fallback = ui.tile(page, item.title)
      await expect(fallback).toBeVisible()
      expect(await ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(400)
      const box = await fallback.boundingBox()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(400)
      await fallback.click()
      await expectReaderImage(page, item.original.bytes)
      await expect(ui.menuButton(page)).toBeVisible()
    } else {
      await expectAnchorOffset(page, before)
      expect(await ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      if (operation === 'retained-filter') {
        for (let cycle = 0; cycle < 2; cycle += 1) {
          if (cycle) {
            await openPanel(page, 'filters')
            await ui.clearFilters(page).click()
            await page.keyboard.press('Escape')
            await expectAnchorOffset(page, before)
            await openPanel(page, 'filters')
            await ui.search(page).fill(before.name.match(/预览-\d/)![0])
            await page.keyboard.press('Escape')
            await expectAnchorOffset(page, before)
          }
          const tail = await ui.album(page).evaluate(root => {
            const list = root.querySelector('ul')!
            const style = getComputedStyle(root)
            const contentHeight = Math.max(0, ...Array.from(list.children, element => Number.parseFloat((element as HTMLElement).style.top) + Number.parseFloat((element as HTMLElement).style.height)))
            const listHeight = Number.parseFloat(getComputedStyle(list).height)
            const necessaryHeight = Math.max(contentHeight, root.scrollTop + root.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
            return { contentHeight, listHeight, necessaryHeight }
          })
          await testInfo.attach(`minimal-filter-tail-${cycle}`, { body: JSON.stringify(tail), contentType: 'application/json' })
          expect(Math.abs(tail.listHeight - tail.necessaryHeight)).toBeLessThanOrEqual(2)
        }
        await ui.album(page).evaluate(root => { root.scrollTop = 0 })
        await expect.poll(() => ui.album(page).evaluate(root => {
          const list = root.querySelector('ul')!
          const contentHeight = Math.max(0, ...Array.from(list.children, element => Number.parseFloat((element as HTMLElement).style.top) + Number.parseFloat((element as HTMLElement).style.height)))
          return Number.parseFloat(getComputedStyle(list).height) - contentHeight
        })).toBeLessThanOrEqual(1)
      }
    }
    expect(sourceReads()).toBe(reads)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })
}

for (const targetVisibility of ['visible', 'above-viewport'] as const) {
  test(`album re-entry focuses the current reader item over an older bookmark with a ${targetVisibility} target`, async ({ page, previewFixtures, network }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 400 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await enterAlbum(page)
    await settleLayout(page)
    const itemA = previewFixtures.items[18]!
    const targetIndex = targetVisibility === 'visible' ? 19 : 10
    const itemB = previewFixtures.items[targetIndex]!
    await ui.tile(page, itemA.title).focus()
    await expectImageBytes(ui.tileImage(page, itemA.title), itemA.thumbnail.bytes)
    await settleLayout(page)
    await expect(ui.tile(page, itemA.title)).toBeFocused()
    const before = await bookmark(page)
    expect(before.scrollTop).toBeGreaterThan(400)
    const root = await ui.album(page).boundingBox()
    const priorB = before.tiles.find(tile => tile.id === itemB.id)!
    if (targetVisibility === 'visible') {
      expect(priorB.top).toBeGreaterThanOrEqual(root!.y)
      expect(priorB.bottom).toBeLessThanOrEqual(root!.y + root!.height)
    } else {
      expect(priorB.bottom).toBeLessThan(root!.y)
    }
    const beforePath = testInfo.outputPath('album-current-item-before.json')
    await writeFile(beforePath, JSON.stringify({ itemA: itemA.id, itemB: itemB.id, targetVisibility, before }, null, 2))
    await testInfo.attach('album-current-item-before', { path: beforePath, contentType: 'application/json' })
    const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${previewFixtures.manifest.cid}`)).length
    const reads = sourceReads()
    const historyLength = await page.evaluate(() => history.length)
    await page.keyboard.press('Enter')
    await expectReaderImage(page, itemA.original.bytes)
    await expect(ui.reader(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
    const step = targetIndex > 18 ? 1 : -1
    for (let index = 18 + step; index !== targetIndex + step; index += step) {
      await page.keyboard.press(step > 0 ? 'ArrowRight' : 'ArrowLeft')
      await expect.poll(() => new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[index]!.id)
      await expect(ui.reader(page)).toBeFocused()
      await expect(ui.menuButton(page)).toBeVisible()
    }
    await expectReaderImage(page, itemB.original.bytes)
    const selectedUrl = page.url()
    const originalReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${itemB.original.cid}`)).length
    const originalReadCount = originalReads()
    await enterAlbum(page)
    await expectImageBytes(ui.tileImage(page, itemB.title), itemB.thumbnail.bytes)
    await settleLayout(page)
    const current = ui.tile(page, itemB.title)
    await expect(current).toBeFocused()
    await expect(current).toHaveAttribute('aria-current', 'true')
    await expect(current).toHaveAttribute('data-album-select', itemB.id)
    if (targetVisibility === 'visible') {
      await expectAnchorOffset(page, before)
    } else {
      await expect.poll(async () => {
        const box = await current.boundingBox()
        const viewport = await ui.album(page).boundingBox()
        return Math.abs(box!.y - viewport!.y)
      }).toBeLessThanOrEqual(2)
      expect(await ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      const box = await current.boundingBox()
      const viewport = await ui.album(page).boundingBox()
      expect(box!.y).toBeGreaterThanOrEqual(viewport!.y)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height)
    }
    expect(page.url()).toBe(selectedUrl)
    await page.keyboard.press('Enter')
    await expectReaderImage(page, itemB.original.bytes)
    await expect(ui.reader(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
    expect(page.url()).toBe(selectedUrl)
    expect(sourceReads()).toBe(reads)
    expect(originalReads()).toBe(originalReadCount)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })
}

test('an inert modal background scroll cannot overwrite the album bookmark or steal restored reader focus', async ({ page, previewFixtures, network }) => {
  const distant = previewFixtures.items[18]!
  await page.setViewportSize({ width: 375, height: 400 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, { item: distant.id }))
  await expectReaderImage(page, distant.original.bytes)
  await enterAlbum(page)
  await expectImageBytes(ui.tileImage(page, distant.title), distant.thumbnail.bytes)
  await settleLayout(page)
  await ui.album(page).evaluate(element => { element.scrollTop += 100 })
  await settleLayout(page)
  const currentBox = await ui.tile(page, distant.title).boundingBox()
  const viewport = await ui.album(page).boundingBox()
  expect(currentBox!.y).toBeGreaterThan(viewport!.y)
  expect(currentBox!.y + currentBox!.height).toBeLessThan(viewport!.y + viewport!.height)
  const before = await bookmark(page)
  expect(before.scrollTop).toBeGreaterThan(400)
  const url = page.url()
  const historyLength = await page.evaluate(() => history.length)
  const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${previewFixtures.manifest.cid}`)).length
  const reads = sourceReads()
  await openMenu(page)
  expect(await ui.album(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
  expect(await ui.album(page).evaluate(element => { element.scrollTop = 0; return element.scrollTop })).toBe(0)
  await settleLayout(page)
  expect(await ui.dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  await ui.readerAction(page).click()
  await expectReaderImage(page, distant.original.bytes)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(ui.reader(page)).toBeFocused()
  await enterAlbum(page)
  const anchor = previewFixtures.items.find(item => `打开 ${item.title}` === before.name)!
  await expectImageBytes(ui.tileImage(page, anchor.title), anchor.thumbnail.bytes)
  await expectAnchorOffset(page, before)
  expect(await ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(400)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
  expect(sourceReads()).toBe(reads)
})

test('a new source session starts at its own first item instead of reusing an earlier deep album bookmark', async ({ page, previewFixtures, galleryFixtures }) => {
  await page.setViewportSize({ width: 375, height: 400 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  const distant = previewFixtures.items[18]!
  await ui.tile(page, distant.title).focus()
  await expectImageBytes(ui.tileImage(page, distant.title), distant.thumbnail.bytes)
  expect(await ui.album(page).evaluate(element => element.scrollTop)).toBeGreaterThan(400)
  await submitSource(page, contentUri(galleryFixtures.manifests.standalone.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await enterAlbum(page)
  await expect(ui.tiles(page)).toHaveCount(2)
  await expect(ui.tile(page, '独立原始图片')).toHaveAttribute('aria-current', 'true')
  expect(await ui.album(page).evaluate(element => element.scrollTop)).toBe(0)
  await submitSource(page, contentUri(previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  await expectImageBytes(ui.tileImage(page, previewFixtures.items[0]!.title), previewFixtures.items[0]!.thumbnail.bytes)
  await settleLayout(page)
  await expect(ui.tile(page, previewFixtures.items[0]!.title)).toHaveAttribute('aria-current', 'true')
  await expect(ui.tile(page, previewFixtures.items[0]!.title)).toBeFocused()
  expect(await ui.album(page).evaluate(element => element.scrollTop)).toBe(0)
})

test('delayed verified ratios and modal resize preserve the pre-modal logical anchor through close and re-entry', async ({ page, previewFixtures, network }) => {
  await page.setViewportSize({ width: 375, height: 400 })
  for (const item of previewFixtures.items) {
    for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(item.thumbnail.cid, { kind: 'delay', milliseconds: 800 })
  }
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  const distant = previewFixtures.items[18]!
  await ui.tile(page, distant.title).focus()
  await settleLayout(page)
  const before = await bookmark(page)
  expect(before.scrollTop).toBeGreaterThan(400)
  await openMenu(page)
  await page.setViewportSize({ width: 768, height: 400 })
  const decoded = ui.album(page).getByRole('button', { name: `打开 ${distant.title}`, exact: true, includeHidden: true }).locator('..').locator('img')
  await expect.poll(() => decoded.evaluateAll(images => images.some(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 16))).toBe(true)
  await settleLayout(page)
  expect(await ui.dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeFocused()
  await expectAnchorOffset(page, before)
  await page.setViewportSize({ width: 375, height: 400 })
  await expectAnchorOffset(page, before)
  await openMenu(page)
  await ui.readerAction(page).click()
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  // The current item is above the bookmark and explicitly becomes the focus target on return.
  await expect(ui.tile(page, previewFixtures.items[0]!.title)).toBeFocused()
  await expect.poll(async () => (await ui.tile(page, previewFixtures.items[0]!.title).boundingBox())!.y).toBeLessThanOrEqual(2)
})

test('programmatic focus on re-entry does not scroll a partially visible bookmarked current tile', async ({ page, previewFixtures }) => {
  await page.setViewportSize({ width: 375, height: 400 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  const item = previewFixtures.items[18]!
  const tile = ui.tile(page, item.title)
  await tile.focus()
  await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
  await expect.poll(() => ui.album(page).evaluate(root => {
    const viewport = root.getBoundingClientRect()
    const visible = Array.from(root.querySelectorAll<HTMLLIElement>('[data-album-id]')).filter(tile => {
      const box = tile.getBoundingClientRect()
      return box.bottom > viewport.top && box.top < viewport.bottom
    })
    return visible.length > 0 && visible.every(tile => {
      const image = tile.querySelector('img')
      return image?.complete && image.naturalWidth === 16 && image.naturalHeight === 12
        && Math.abs(Number.parseFloat(tile.style.height) - Number.parseFloat(tile.style.width) * 3 / 4) <= 0.02
    })
  })).toBe(true)
  await settleLayout(page)
  await ui.album(page).evaluate((root, id) => {
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-album-select]')).find(element => element.dataset.albumSelect === id)!
    root.scrollTop += button.getBoundingClientRect().top - root.getBoundingClientRect().top + 20
  }, item.id)
  await settleLayout(page)
  const before = await bookmark(page)
  const current = before.tiles.find(tile => tile.id === item.id)!
  expect(current.top).toBeLessThan(0)
  expect(current.bottom).toBeGreaterThan(0)
  await page.keyboard.press('Enter')
  await expectReaderImage(page, item.original.bytes)
  await enterAlbum(page)
  await expect(tile).toBeFocused()
  await settleLayout(page)
  await expectAnchorOffset(page, before)
})

for (const target of ['tile', 'region', 'Tab', 'Shift+Tab'] as const) {
test(`a pending album entry focus yields to a newer ${target} focus before the animation frame`, async ({ page, previewFixtures }) => {
  await page.setViewportSize({ width: 375, height: 400 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await openMenu(page)
  const newer = previewFixtures.items[3]!
  if (target !== 'tile') await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const queued = new Map<number, FrameRequestCallback>()
    let sequence = 0
    window.requestAnimationFrame = callback => { queued.set(++sequence, callback); return sequence }
    window.cancelAnimationFrame = id => { queued.delete(id) }
    window.addEventListener('album-release-focus-frames', () => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
      for (const callback of queued.values()) request(callback)
    }, { once: true })
  })
  else await page.evaluate(id => {
    const observer = new MutationObserver(() => {
      const tile = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-album-select]')).find(element => element.dataset.albumSelect === id)
      if (!tile) return
      observer.disconnect()
      tile.focus()
    })
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
  }, newer.id)
  await ui.albumAction(page).click()
  const keyboardFocus = target === 'Tab' ? ui.tile(page, previewFixtures.items[1]!.title)
    : target === 'Shift+Tab' ? page.getByRole('main', { name: '影像相册', exact: true }) : undefined
  if (target === 'region') {
    await ui.album(page).click({ position: { x: 4, y: 200 } })
    await page.evaluate(() => window.dispatchEvent(new Event('album-release-focus-frames')))
  } else if (target === 'Tab' || target === 'Shift+Tab') {
    await ui.album(page).focus()
    await page.keyboard.press(target)
    if (target === 'Tab') await page.keyboard.press('Tab')
    await expect(keyboardFocus!).toBeFocused()
    await page.evaluate(() => window.dispatchEvent(new Event('album-release-focus-frames')))
  }
  await settleLayout(page)
  if (keyboardFocus) {
    await expect(keyboardFocus).toBeFocused()
    await settleLayout(page)
    await expect(keyboardFocus).toBeFocused()
    return
  }
  const focused = target === 'tile' ? ui.tile(page, newer.title) : ui.album(page)
  await expect(focused).toBeFocused()
  if (target === 'tile') await expectImageBytes(ui.tileImage(page, newer.title), newer.thumbnail.bytes)
  await settleLayout(page)
  await expect(focused).toBeFocused()
})
}
