import { test, expect } from './fixtures'
import { FIXTURE_GATEWAYS, sourceUrl } from './gateway-route'
import { ui, openReaderTools, openPanel, enterAlbum, submitSource, selectAlbumItem, expectReaderImage, expectImageBytes, expectVideoBytes, expectDownloadBytes } from './gallery-ui'

test('empty source panel is automatic and submits a real CID through the Worker', async ({ page, galleryFixtures, network }) => {
  await page.goto(sourceUrl('cid', []))
  await expect(ui.source(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  expect(network.slow.requests.length + network.fast.requests.length).toBe(0)
  await submitSource(page, galleryFixtures.raw.cid)
  await expect.poll(() => new URL(page.url()).searchParams.get('unixfs') ?? new URL(page.url()).searchParams.get('cid')).toContain(galleryFixtures.raw.cid)
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await expect(ui.menuButton(page)).toBeVisible()
  expect(page.workers().length).toBeGreaterThan(0)
})

test('history return to an empty location reopens and focuses the source panel without new media requests', async ({ page, galleryFixtures, network }) => {
  await page.goto(sourceUrl('cid', []))
  await expect(ui.source(page)).toBeVisible()
  await expect(ui.source(page)).toBeFocused()
  const emptyUrl = page.url()
  await submitSource(page, galleryFixtures.raw.cid)
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  const reads = network.bridge.routes.length
  await page.goBack()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.source(page)).toBeVisible()
  await expect(ui.source(page)).toBeFocused()
  await expect(ui.source(page)).toHaveValue('')
  await expect(ui.reader(page)).toHaveCount(0)
  expect(page.url()).toBe(emptyUrl)
  expect(network.bridge.routes).toHaveLength(reads)
  await page.goForward()
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeVisible()
})

for (const format of ['json', 'yaml', 'toml'] as const) {
  for (const mode of ['auto', 'explicit'] as const) {
    test(`${mode} ${format} metadata resolves nested relative paths and treats untrusted text safely`, async ({ page, galleryFixtures, network }) => {
      const directory = galleryFixtures.directories[format]
      const manifest = galleryFixtures.manifests[format]
      await page.goto(mode === 'auto' ? sourceUrl('unixfs', directory.ref) : sourceUrl('meta', manifest.ref))
      await expectReaderImage(page, galleryFixtures.raw.bytes)
      await expect(page).toHaveTitle(new RegExp(galleryFixtures.expected.title))
      await openPanel(page, 'source')
      await expect(ui.dialog(page).getByText(galleryFixtures.expected.description, { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await enterAlbum(page)
      for (const title of [...galleryFixtures.expected.imageTitles, galleryFixtures.expected.videoTitle]) {
        await ui.tile(page, title).scrollIntoViewIfNeeded()
        await expect(ui.tile(page, title)).toBeVisible()
      }
      await ui.tile(page, '琥珀影像').scrollIntoViewIfNeeded()
      await expectImageBytes(ui.tileImage(page, '琥珀影像'), directory.files['media/琥珀.png']!.bytes)
      await ui.tile(page, '蓝色影像').scrollIntoViewIfNeeded()
      await expectImageBytes(ui.tileImage(page, '蓝色影像'), directory.files['media/nested/无扩展名']!.bytes)
      await selectAlbumItem(page, '蓝色影像')
      await expectReaderImage(page, galleryFixtures.dagPb.bytes)
      expect(await page.evaluate(() => Reflect.get(window, 'fixtureExecuted'))).toBeUndefined()
      expect(page.workers().length).toBeGreaterThan(0)
      const records = [...network.slow.requests, ...network.fast.requests].filter(record => record.method === 'GET')
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        expect(new URL(record.url, 'http://fixture.invalid').searchParams.get('format')).toBe('raw')
        expect(record.headers.accept).toContain('application/vnd.ipld.raw')
        expect(record.headers.cookie).toBeUndefined()
        expect(record.headers.referer).toBeUndefined()
        expect(record.cid && galleryFixtures.blocks.has(record.cid)).toBe(true)
      }
    })
  }
}

test('extensionless metadata resolves parent-relative paths inside the real CID root', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('meta', galleryFixtures.manifests.extensionless.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await selectAlbumItem(page, '嵌套无扩展名')
  await expectReaderImage(page, galleryFixtures.dagPb.bytes)
})

test('pasted gateway links extract content without contacting or adopting their host', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('cid', []))
  await submitSource(page, `https://unconfigured.gallery-fixture.net/ipfs/${galleryFixtures.raw.cid}`)
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  expect(new URL(page.url()).searchParams.getAll('gateway')).toEqual([FIXTURE_GATEWAYS.slow, FIXTURE_GATEWAYS.fast])
})

test('bare metadata CID reads explicit roots without guessing a parent directory', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('meta', galleryFixtures.manifests.standalone.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await selectAlbumItem(page, '独立 DAG-PB 图片')
  await expectReaderImage(page, galleryFixtures.dagPb.bytes)
})

test('multiple CID roots include raw, DAG-PB, multiblock and extensionless media', async ({ page, galleryFixtures }) => {
  const extensionless = galleryFixtures.directories.nested.files['album/nested/无扩展名']!
  await page.goto(sourceUrl('cid', [galleryFixtures.raw.ref, galleryFixtures.dagPb.ref, galleryFixtures.multiblock.ref, extensionless.ref]))
  const expected = [galleryFixtures.raw, galleryFixtures.dagPb, galleryFixtures.multiblock, extensionless]
  for (let index = 0; index < expected.length; index += 1) {
    await enterAlbum(page)
    await expect(ui.tiles(page)).toHaveCount(4)
    await ui.tiles(page).nth(index).scrollIntoViewIfNeeded()
    await ui.tiles(page).nth(index).click()
    await expectReaderImage(page, expected[index]!.bytes)
  }
})

test('nested traversal includes extensionless media and playable verified video with native commands', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('unixfs', { ...galleryFixtures.directories.nested.ref, path: ['album'] }))
  await enterAlbum(page)
  for (const title of ['first.png', '无扩展名', 'clip.webm']) await expect(ui.tile(page, title)).toHaveCount(1)
  await selectAlbumItem(page, '无扩展名')
  await expectReaderImage(page, galleryFixtures.dagPb.bytes)
  await selectAlbumItem(page, 'clip.webm')
  const video = ui.reader(page).locator('video')
  await expectVideoBytes(video, galleryFixtures.video.bytes)
  const selection = new URL(page.url()).searchParams.get('item')
  await video.focus()
  for (const key of ['ArrowLeft', 'ArrowRight', 'm', 'Enter']) await page.keyboard.press(key)
  expect(new URL(page.url()).searchParams.get('item')).toBe(selection)
  const videoBox = await video.boundingBox()
  await video.click({ position: { x: 20, y: videoBox!.height - 16 } })
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false)
  await video.evaluate((element: HTMLVideoElement) => element.pause())
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), galleryFixtures.video.bytes)
})

test('forced HAMT exposes all filenames without duplicate shard entries', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.hamt.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await enterAlbum(page)
  for (const path of galleryFixtures.expected.hamtPaths) await expect(ui.tile(page, path)).toHaveCount(1)
  await expect(ui.tiles(page)).toHaveCount(galleryFixtures.expected.hamtPaths.length)
  await ui.tile(page, 'frame-19.png').scrollIntoViewIfNeeded()
  await expectImageBytes(ui.tileImage(page, 'frame-19.png'), galleryFixtures.dagPb.bytes)
  await selectAlbumItem(page, 'frame-19.png')
  await expectReaderImage(page, galleryFixtures.dagPb.bytes)
  await openReaderTools(page)
  await expect(ui.next(page)).toBeDisabled()
})

test('invalid authoritative metadata does not silently select YAML; directory browse is explicit', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.invalid.ref))
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(ui.reader(page)).toHaveCount(0)
  await page.getByRole('button', { name: /按目录浏览/ }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('browse')).toBe('1')
  await enterAlbum(page)
  await expect(ui.tile(page, '琥珀.png')).toHaveCount(1)
  await expect(ui.tile(page, '无扩展名')).toHaveCount(1)
  await selectAlbumItem(page, '琥珀.png')
  await expectReaderImage(page, galleryFixtures.raw.bytes)
})

test('explicit invalid metadata reports failure instead of fabricated media', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('meta', galleryFixtures.manifests.invalid.ref))
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(ui.reader(page)).toHaveCount(0)
})
