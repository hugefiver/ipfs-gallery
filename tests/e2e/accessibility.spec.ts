import type { Locator, TestInfo } from '@playwright/test'
import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { ui, openReaderTools, openMenu, openPanel, enterAlbum, selectAlbumItem, expectReaderImage, expectImageBytes, expectDownloadBytes } from './gallery-ui'

async function expectVisibleToolEntry(tool: Locator, testInfo: TestInfo, gatewayOrigins: string[]) {
  await expect(tool).toBeFocused()
  const measure = () => tool.evaluate(element => {
    const box = element.getBoundingClientRect()
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const bounds = parent.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + parent.clientLeft)
        clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth)
      }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + parent.clientTop)
        clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight)
      }
      if (parent.matches('[role="dialog"]')) break
    }
    const points = [[box.left + box.width / 2, box.top + box.height / 2],
      [box.left + 6, box.top + 6], [box.right - 6, box.top + 6],
      [box.left + 6, box.bottom - 6], [box.right - 6, box.bottom - 6]]
    const stage = document.querySelector('[data-reader-stage]')?.getBoundingClientRect()
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      clip,
      fullyVisible: box.left >= clip.left && box.right <= clip.right && box.top >= clip.top && box.bottom <= clip.bottom,
      hittable: points.every(([x, y]) => element.contains(document.elementFromPoint(x!, y!))),
      toolsScrollTop: element.closest('.gallery-drawer-content')?.scrollTop,
      pageScroll: { x: scrollX, y: scrollY },
      stageUnchanged: stage?.left === 0 && stage.top === 0 && stage.width === innerWidth && stage.height === innerHeight,
    }
  })
  let geometry = await measure()
  try {
    await expect.poll(async () => {
      geometry = await measure()
      return geometry.fullyVisible && geometry.hittable
    }).toBe(true)
  } finally {
    await testInfo.attach('tool-entry-geometry', { body: JSON.stringify({ ...geometry, gatewayOrigins }), contentType: 'application/json' })
    await testInfo.attach('tool-entry-screen', { body: await tool.page().screenshot(), contentType: 'image/png' })
  }
  expect(geometry.box.width).toBeGreaterThanOrEqual(44)
  expect(geometry.box.height).toBeGreaterThanOrEqual(44)
  expect(geometry.fullyVisible).toBe(true)
  expect(geometry.hittable).toBe(true)
  expect(geometry.toolsScrollTop).toBeGreaterThan(0)
  expect(geometry.pageScroll).toEqual({ x: 0, y: 0 })
  expect(geometry.stageUnchanged).toBe(true)
  return geometry.box
}

test('short reader tools Tab focuses a fully visible, hittable details control', async ({ page, galleryFixtures, network }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 240 })
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.json.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await ui.reader(page).focus()
  await expect(page.getByRole('button')).toHaveCount(1)
  await openReaderTools(page)
  for (let index = 0; index < 12 && !await ui.readerInfo(page).evaluate(element => element === document.activeElement); index += 1) await page.keyboard.press('Tab')
  const box = await expectVisibleToolEntry(ui.readerInfo(page), testInfo, [network.slow.origin, network.fast.origin])
  await page.mouse.click(box.left + box.width / 2, box.top + box.height / 2)
  await expect(ui.dialog(page)).toHaveAccessibleName('影像信息')
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ui.reader(page)).toBeFocused()
  await expect(page.getByRole('button')).toHaveCount(1)
})

test('short reader menu download entry focuses a fully visible, hittable download control', async ({ page, galleryFixtures, network }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 240 })
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.json.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await ui.reader(page).focus()
  await page.keyboard.press('Tab')
  await expect(ui.menuButton(page)).toBeFocused()
  await page.keyboard.press('Enter')
  const menuDownload = ui.dialog(page).getByRole('button', { name: '阅读工具与下载', exact: true })
  for (let index = 0; index < 12 && !await menuDownload.evaluate(element => element === document.activeElement); index += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(menuDownload).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(ui.readerTools(page)).toBeVisible()
  for (let index = 0; index < 12 && !await ui.download(ui.readerTools(page)).evaluate(element => element === document.activeElement); index += 1) await page.keyboard.press('Tab')
  const box = await expectVisibleToolEntry(ui.download(ui.readerTools(page)), testInfo, [network.slow.origin, network.fast.origin])
  const pending = page.waitForEvent('download')
  await page.mouse.click(box.left + box.width / 2, box.top + box.height / 2)
  const download = await pending
  expect(await download.failure()).toBeNull()
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(galleryFixtures.raw.bytes)
})

test('default reader exposes instructions and one persistent menu in Tab and AX', async ({ page, context, galleryFixtures }) => {
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.json.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await expect(ui.reader(page)).toHaveAttribute('tabindex', '0')
  await expect(ui.reader(page)).toHaveAccessibleDescription(/Enter|M|菜单|工具/)
  await expect(page.getByRole('button')).toHaveCount(1)
  const cdp = await context.newCDPSession(page)
  try {
    const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] }
    expect(tree.nodes.filter(node => !node.ignored && node.role?.value === 'button').map(node => node.name?.value)).toEqual(['菜单'])
    expect(tree.nodes.filter(node => !node.ignored && ['heading', 'toolbar', 'textbox'].includes(node.role?.value ?? ''))).toEqual([])
    expect(tree.nodes.some(node => !node.ignored && node.role?.value === 'region' && node.name?.value.startsWith('阅读区：'))).toBe(true)
  } finally { await cdp.detach() }
  await ui.reader(page).focus()
  await page.keyboard.press('Tab')
  await expect(ui.menuButton(page)).toBeVisible()
  await expect(ui.menuButton(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ui.reader(page)).toBeFocused()
  await expect(page.getByRole('button')).toHaveCount(1)
  await page.keyboard.press('Tab')
  expect(await page.getByRole('button').evaluateAll(elements => elements.some(element => element === document.activeElement))).toBe(true)
})

test('M and stage Enter open menu; Escape closes exactly one layer without history back', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('unixfs', galleryFixtures.directories.json.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  const url = page.url()
  const historyLength = await page.evaluate(() => history.length)
  await ui.reader(page).focus()
  await page.keyboard.press('Enter')
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.dialog(page)).toHaveAttribute('aria-modal', 'true')
  expect(await ui.reader(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
  for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
    await page.keyboard.press(key)
    expect(await ui.dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeVisible()
  await expect(ui.reader(page)).toBeFocused()
  await page.keyboard.press('m')
  await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

test('menu replaces its modal with network content, which closes to the visible menu trigger', async ({ page, galleryFixtures }) => {
  await page.goto(sourceUrl('cid', galleryFixtures.raw.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await openMenu(page)
  await ui.panelAction(page, 'network').click()
  await expect(ui.settingsDialog(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(ui.dialog(page).getByRole('dialog')).toHaveCount(0)
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    expect(await ui.settingsDialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeFocused()
  await expect(ui.dialog(page)).toHaveCount(0)
})

test('keyboard album selection focuses the reader without re-revealing chrome; return restores tile focus', async ({ page, previewFixtures, network }) => {
  await page.setViewportSize({ width: 375, height: 480 })
  const item = previewFixtures.items[18]!
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(item.original.cid, { kind: 'delay', milliseconds: 800 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await enterAlbum(page)
  const tile = ui.tile(page, item.title)
  await tile.focus()
  await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
  await expect(tile).toBeFocused()
  const scroll = await ui.album(page).evaluate(element => element.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  const anchor = await ui.tiles(page).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { name: element.getAttribute('aria-label')!, top: box.top, bottom: box.bottom }
  }).filter(box => box.bottom > 0 && box.top < innerHeight).sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0]!)
  const historyLength = await page.evaluate(() => history.length)
  await page.keyboard.press('Enter')
  await expect(ui.reader(page)).toBeFocused()
  await expectReaderImage(page, item.original.bytes)
  await expect(ui.menuButton(page)).toBeVisible()
  expect(new URL(page.url()).searchParams.get('item')).toBe(item.id)
  await enterAlbum(page)
  await expectImageBytes(ui.tileImage(page, item.title), item.thumbnail.bytes)
  await expect(tile).toBeFocused()
  await expect(tile).toHaveAttribute('aria-current', 'true')
  const restoredAnchor = await ui.album(page).getByRole('button', { name: anchor.name, exact: true }).boundingBox()
  expect(Math.abs(restoredAnchor!.y - anchor.top)).toBeLessThanOrEqual(2)
  await page.setViewportSize({ width: 768, height: 480 })
  await expect.poll(async () => {
    const box = await ui.album(page).getByRole('button', { name: anchor.name, exact: true }).boundingBox()
    return Math.abs(box!.y - anchor.top)
  }).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

for (const width of [375, 1280]) {
  test(`download keeps its visible label in its native accessible name at ${width}px`, async ({ page, context, previewFixtures }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const item = previewFixtures.items[0]!
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, item.original.bytes)
    await openReaderTools(page)
    const button = ui.download(ui.readerTools(page))
    const visibleLabel = (await button.innerText()).replace(/\s+/gu, ' ').trim()
    expect(visibleLabel.length).toBeGreaterThan(0)
    const cdp = await context.newCDPSession(page)
    let accessibleName: string | undefined
    try {
      const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] }
      const name = await button.getAttribute('aria-label') ?? visibleLabel
      const matches = tree.nodes.filter(node => !node.ignored && node.role?.value === 'button' && node.name?.value === name)
      expect(matches).toHaveLength(1)
      accessibleName = matches[0]!.name!.value.replace(/\s+/gu, ' ').trim()
    } finally { await cdp.detach() }
    await testInfo.attach('native-label-in-name', { body: JSON.stringify({ width, visibleLabel, accessibleName }), contentType: 'application/json' })
    expect(accessibleName).toContain(visibleLabel)
    await expectDownloadBytes(page, ui.readerTools(page), item.original.bytes)
    await selectAlbumItem(page, previewFixtures.items[1]!.title)
    await openPanel(page, 'info')
    await expect(ui.dialog(page)).toHaveCount(1)
  })
}
