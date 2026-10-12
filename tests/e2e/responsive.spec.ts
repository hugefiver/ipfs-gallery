import { importBytes } from 'ipfs-unixfs-importer'
import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { createPng } from '../fixtures/media'
import { ui, openReaderTools, openPanel, enterAlbum, screenshot, expectReaderImage, expectImageBytes, expectNoHorizontalOverflow } from './gallery-ui'
import { expectShortestColumns } from './album-geometry'

for (const [width, columns] of [[375, 2], [768, 3], [1280, 4], [1600, 5]] as const) {
  test(`viewport reader, overlays and real shortest-column album at ${width}px`, async ({ page, galleryFixtures }, testInfo) => {
    const dimensions = [[48, 96], [96, 48], [64, 64], [96, 32], [32, 96], [80, 64]] as const
    const entries = []
    for (let index = 0; index < 18; index += 1) {
      const [imageWidth, imageHeight] = dimensions[index % dimensions.length]!
      const bytes = createPng(imageWidth, imageHeight, 400 + index)
      const { cid } = await importBytes(bytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
      entries.push({ cid: cid.toV1().toString(), title: `比例-${index}.png`, type: 'image', width: imageWidth, height: imageHeight, bytes })
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify({ version: 1, items: entries.map(({ bytes, ...entry }) => { void bytes; return entry }) }))
    const manifest = await importBytes(manifestBytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
    await page.setViewportSize({ width, height: 900 })
    await page.goto(sourceUrl('meta', { cid: manifest.cid.toV1().toString(), path: [] }))
    await expectReaderImage(page, entries[0]!.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
    const menuBox = await ui.menuButton(page).boundingBox()
    expect(menuBox!.width).toBe(48)
    expect(menuBox!.height).toBe(48)
    const readerBox = await ui.reader(page).boundingBox()
    expect(readerBox).toEqual({ x: 0, y: 0, width, height: 900 })
    expect(await ui.reader(page).getByRole('img').evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
    await screenshot(page, testInfo, 'reader-default')
    await openReaderTools(page)
    expect(await ui.reader(page).boundingBox()).toEqual(readerBox)
    for (const control of [ui.closePanel(page), ui.next(page)]) {
      const box = await control.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    await screenshot(page, testInfo, 'reader-tools')
    await openPanel(page, 'network')
    await expect(ui.dialog(page)).toHaveCount(1)
    await expect(ui.dialog(page)).toHaveAttribute('aria-modal', 'true')
    await expectNoHorizontalOverflow(page)
    await screenshot(page, testInfo, 'network-panel')
    await page.keyboard.press('Escape')
    await enterAlbum(page)
    await expectImageBytes(ui.tileImage(page, entries[0]!.title), entries[0]!.bytes)
    const geometry = await expectShortestColumns(ui.album(page), ui.tiles(page), columns)
    await testInfo.attach('album-geometry', { body: JSON.stringify({ width, columns, ...geometry }), contentType: 'application/json' })
    expect(await ui.tiles(page).allTextContents()).toHaveLength(entries.length)
    for (let index = 0; index < entries.length; index += 1) await expect(ui.tiles(page).nth(index)).toHaveAccessibleName(new RegExp(entries[index]!.title.replace('.', '\\.')))
    await expectNoHorizontalOverflow(page)
    await screenshot(page, testInfo, 'album')
    await openPanel(page, 'source')
    await expect(ui.source(page)).toBeVisible()
    await screenshot(page, testInfo, 'source-panel')
    await page.keyboard.press('Escape')
    await page.goto(sourceUrl('meta', galleryFixtures.manifests.invalid.ref))
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await screenshot(page, testInfo, 'metadata-error')
  })
}

test('reader stays single through resizing; album geometry changes without a source reread', async ({ page, previewFixtures, network }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${previewFixtures.manifest.cid}`)).length
  const initial = sourceReads()
  const url = page.url()
  for (const width of [1600, 1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(ui.reader(page).getByRole('img')).toHaveCount(1)
    await expectNoHorizontalOverflow(page)
    expect(page.url()).toBe(url)
  }
  await enterAlbum(page)
  for (const [width, columns] of [[375, 2], [768, 3], [1280, 4], [1600, 5]] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expectShortestColumns(ui.album(page), ui.tiles(page), columns)
    expect(page.url()).toBe(url)
  }
  expect(sourceReads()).toBe(initial)
})
