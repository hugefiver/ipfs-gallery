import { importBytes } from 'ipfs-unixfs-importer'
import { test, expect } from './fixtures'
import { writeFile } from 'node:fs/promises'
import { sourceUrl } from './gateway-route'
import { createPng, createUndecodablePng } from '../fixtures/media'
import { contentUri } from '../fixtures/unixfs'
import { ui, openReaderTools, openPanel, submitSource, expectReaderImage, expectImageBytes, expectDownloadBytes, screenshot } from './gallery-ui'
import { captureMediaLifecycle, mediaEvents } from './media-lifecycle'
import type { CDPSession, Locator, Page } from '@playwright/test'

async function touchVisibleTarget(page: Page, control: Locator, session?: CDPSession) {
  await expect(control).toBeVisible()
  await expect(control).toBeEnabled()
  await control.evaluate(element => {
    const box = element.getBoundingClientRect(), viewport = visualViewport!
    if (box.left < viewport.offsetLeft || box.top < viewport.offsetTop || box.right > viewport.offsetLeft + viewport.width || box.bottom > viewport.offsetTop + viewport.height) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    }
  })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const handle = await control.elementHandle()
  expect(handle).not.toBeNull()
  const point = await control.evaluate(element => {
    const box = element.getBoundingClientRect()
    const viewport = visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    element.removeAttribute('data-test-touch-target')
    element.addEventListener('pointerdown', event => {
      element.setAttribute('data-test-touch-target', event.isTrusted && element.contains(event.target as Node) ? 'owned' : 'other')
    }, { once: true })
    return { x: x - left, y: y - top, owned: element.contains(document.elementFromPoint(x, y)), inViewport: x >= left && y >= top && x <= left + (viewport?.width ?? innerWidth) && y <= top + (viewport?.height ?? innerHeight) }
  })
  expect(point.owned, JSON.stringify(point)).toBe(true)
  expect(point.inViewport, JSON.stringify(point)).toBe(true)
  // Touch input uses visual-viewport coordinates; DOM hit-testing uses layout coordinates.
  const cdp = session ?? await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally { if (!session) await cdp.detach() }
  expect(await handle!.evaluate(element => element.getAttribute('data-test-touch-target'))).toBe('owned')
  await handle!.evaluate(element => element.removeAttribute('data-test-touch-target'))
  await handle!.dispose()
}

async function readerTransform(page: Page) {
  return ui.reader(page).getByRole('img', { includeHidden: true }).evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { scale: matrix.a, x: matrix.e, y: matrix.f }
  })
}

async function openTouchReaderTools(page: Page, cdp: CDPSession) {
  if (await ui.dialog(page).count()) await page.keyboard.press('Escape')
  await touchVisibleTarget(page, ui.menuButton(page), cdp)
  await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
  await touchVisibleTarget(page, ui.dialog(page).getByRole('button', { name: '阅读工具与下载', exact: true }), cdp)
  await expect(ui.readerTools(page)).toBeVisible()
}

test('ordinary clicks preserve the single menu; tools zoom without changing stage geometry or stealing focus', async ({ page, previewFixtures }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const image = ui.reader(page).getByRole('img')
  const geometry = await ui.reader(page).boundingBox()
  await expect(page.getByRole('button')).toHaveCount(1)
  await image.click()
  await expect(page.getByRole('button')).toHaveCount(1)
  await openReaderTools(page)
  for (const control of [ui.next(page), ui.previous(page), ui.zoomIn(page), ui.resetZoom(page), ui.download(ui.readerTools(page))]) await expect(control).toBeVisible()
  expect(await ui.reader(page).boundingBox()).toEqual(geometry)
  await ui.zoomIn(page).click()
  expect(new URL(page.url()).searchParams.has('item')).toBe(false)
  await expect(ui.zoomIn(page)).toBeFocused()
  await page.waitForTimeout(1500)
  await expect(ui.zoomIn(page)).toBeFocused()
  await ui.resetZoom(page).click()
  await page.keyboard.press('Escape')
  await image.click()
  await expect(page.getByRole('button')).toHaveCount(1)
  await expect(ui.reader(page)).toBeFocused()
})

test('consecutive arrows and modal navigation focus the new stage with a persistent menu', async ({ page, previewFixtures }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const historyLength = await page.evaluate(() => history.length)
  await ui.reader(page).focus()
  for (const index of [1, 2]) {
    await page.keyboard.press('ArrowRight')
    await expectReaderImage(page, previewFixtures.items[index]!.original.bytes)
    expect(new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[index]!.id)
    await expect(ui.reader(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
  }
  await openReaderTools(page)
  await ui.next(page).click()
  await expectReaderImage(page, previewFixtures.items[3]!.original.bytes)
  await expect(ui.reader(page)).toBeFocused()
  await expect(ui.menuButton(page)).toBeVisible()
  await openReaderTools(page)
  await ui.next(page).press('Enter')
  await expectReaderImage(page, previewFixtures.items[4]!.original.bytes)
  await expect(ui.reader(page)).toBeFocused()
  await expect(ui.menuButton(page)).toBeVisible()
  await ui.reader(page).getByRole('img').click()
  await expect(ui.menuButton(page)).toBeVisible()
  await expect(ui.reader(page)).toBeFocused()
  expect(new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[4]!.id)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

for (const boundary of ['first', 'last'] as const) {
  test(`modal navigation closes to the new stage and disables the ${boundary} boundary on reopening`, async ({ page, previewFixtures }) => {
    const initial = previewFixtures.items[boundary === 'first' ? 1 : previewFixtures.items.length - 2]!
    const target = boundary === 'first' ? previewFixtures.items[0]! : previewFixtures.items.at(-1)!
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref, { item: initial.id }))
    await expectReaderImage(page, initial.original.bytes)
    const historyLength = await page.evaluate(() => history.length)
    await openReaderTools(page)
    const control = boundary === 'first' ? ui.previous(page) : ui.next(page)
    await control.click()
    await expectReaderImage(page, target.original.bytes)
    await expect(ui.reader(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('item')).toBe(target.id)
    await openReaderTools(page)
    await expect(control).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(ui.menuButton(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(ui.menuButton(page)).toBeVisible()
    await expect(ui.reader(page)).toBeFocused()
    const url = page.url()
    await page.keyboard.press(boundary === 'first' ? 'ArrowLeft' : 'ArrowRight')
    await expect(ui.reader(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })
}

for (const focus of ['menu-trigger', 'modal-search'] as const) {
  test(`late original completion preserves an intervening ${focus} focus after reader replacement`, async ({ page, previewFixtures, network }) => {
    const second = previewFixtures.items[1]!
    for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(second.original.cid, { kind: 'delay', milliseconds: 3000 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const historyLength = await page.evaluate(() => history.length)
    await openReaderTools(page)
    await ui.next(page).click()
    const pendingRequest = () => [...network.slow.requests, ...network.fast.requests].find(request => request.method === 'GET' && request.cid === second.original.cid && request.completedAt === undefined)
    await expect.poll(pendingRequest).toBeDefined()
    if (focus === 'modal-search') {
      await openPanel(page, 'filters')
      await ui.search(page).click()
      expect(pendingRequest()).toBeDefined()
      await expectImageBytes(ui.reader(page).getByRole('img', { includeHidden: true }), second.original.bytes)
      await expect(ui.dialog(page)).toHaveCount(1)
      await expect(ui.search(page)).toBeFocused()
      expect(await ui.reader(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
      await page.keyboard.press('Escape')
    } else {
      await ui.menuButton(page).focus()
      expect(pendingRequest()).toBeDefined()
      await expectReaderImage(page, second.original.bytes)
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(ui.menuButton(page)).toBeFocused()
    await expect(ui.menuButton(page)).toBeVisible()
    await expect(ui.dialog(page)).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('item')).toBe(second.id)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })
}

test('replacing a source during a pending reader original cancels its consumer and preserves the new session focus', async ({ page, previewFixtures, galleryFixtures, network }) => {
  const pendingItem = previewFixtures.items[1]!
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(pendingItem.original.cid, { kind: 'delay', milliseconds: 3000 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await openReaderTools(page)
  await ui.next(page).click()
  const pendingRequest = () => [...network.slow.requests, ...network.fast.requests].find(request => request.method === 'GET' && request.cid === pendingItem.original.cid && request.completedAt === undefined)
  await expect.poll(pendingRequest).toBeDefined()
  const pending = pendingRequest()!
  expect(pending.completedAt).toBeUndefined()
  const historyLength = await page.evaluate(() => history.length)
  await submitSource(page, contentUri(galleryFixtures.manifests.standalone.ref))
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  await expect(ui.menuButton(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(0)
  const newUrl = page.url()
  expect(new URL(newUrl).searchParams.get('meta')).toContain(galleryFixtures.manifests.standalone.cid)
  expect(new URL(newUrl).searchParams.has('item')).toBe(false)
  await expect(ui.menuButton(page)).toBeVisible()
  await ui.menuButton(page).focus()
  await expect.poll(() => pending.completedAt).toBeDefined()
  expect(pending.aborted).toBe(true)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(ui.menuButton(page)).toBeFocused()
  await expectReaderImage(page, galleryFixtures.raw.bytes)
  expect(page.url()).toBe(newUrl)
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1)
})

test('editing, IME composition and text selection do not trigger global reader commands', async ({ page, previewFixtures }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const url = page.url()
  await openPanel(page, 'source')
  const source = ui.source(page)
  await source.fill('正在输入的新来源')
  await source.dispatchEvent('compositionstart')
  await source.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })
  await source.dispatchEvent('keydown', { key: 'm', code: 'KeyM', isComposing: true, bubbles: true })
  await source.dispatchEvent('compositionend')
  expect(page.url()).toBe(url)
  await expect(ui.dialog(page)).toHaveCount(1)
  await expect(source).toHaveValue('正在输入的新来源')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await ui.reader(page).dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', isComposing: true, bubbles: true })
  await ui.reader(page).dispatchEvent('keydown', { key: 'm', code: 'KeyM', isComposing: true, bubbles: true })
  expect(page.url()).toBe(url)
  await expect(ui.menuButton(page)).toBeVisible()
  await ui.reader(page).evaluate(element => {
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    editable.setAttribute('role', 'textbox')
    editable.setAttribute('aria-label', '测试编辑目标')
    editable.textContent = '可编辑文本'
    element.append(editable)
    editable.focus()
  })
  const editable = page.getByRole('textbox', { name: '测试编辑目标', exact: true })
  for (const key of ['m', 'ArrowRight', 'Enter']) await editable.press(key)
  expect(page.url()).toBe(url)
  await expect(ui.menuButton(page)).toBeVisible()
  await editable.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  await ui.reader(page).dispatchEvent('click', { detail: 1, bubbles: true })
  await page.waitForTimeout(350)
  await expect(ui.menuButton(page)).toBeVisible()
  await editable.evaluate(element => { window.getSelection()?.removeAllRanges(); element.remove() })
})

test('double-click zoom and cancelled or dragged pointer sequences do not flip chrome or select twice', async ({ page, previewFixtures }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const image = ui.reader(page).getByRole('img')
  await image.dblclick()
  await expect(ui.menuButton(page)).toBeVisible()
  const box = await image.boundingBox()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  const url = page.url()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 80, y + 20, { steps: 8 })
  await page.mouse.up()
  expect(page.url()).toBe(url)
  await expect(ui.menuButton(page)).toBeVisible()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await image.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true })
  await page.mouse.up()
  await page.waitForTimeout(350)
  expect(page.url()).toBe(url)
  await expect(ui.menuButton(page)).toBeVisible()
})

test('reader loading completion preserves the menu explicitly opened during the pending original', async ({ page, previewFixtures, network }) => {
  const first = previewFixtures.items[0]!
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(first.original.cid, { kind: 'delay', milliseconds: 900 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expect(ui.reader(page)).toBeVisible()
  await ui.reader(page).focus()
  await page.keyboard.press('m')
  await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
  const focused = await ui.dialog(page).getByRole('button').filter({ hasText: '阅读 · 当前模式' }).elementHandle()
  await expectImageBytes(ui.reader(page).getByRole('img', { includeHidden: true }), first.original.bytes)
  expect(await focused!.evaluate(element => element === document.activeElement)).toBe(true)
  await focused!.dispose()
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeFocused()
})

test('a pending reader item is cancelled on arrow selection and cannot replace the next item', async ({ page, previewFixtures, network }) => {
  const first = previewFixtures.items[0]!
  const second = previewFixtures.items[1]!
  for (const gateway of [network.slow, network.fast]) gateway.setBlockMode(first.original.cid, { kind: 'delay', milliseconds: 1500 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expect(ui.reader(page)).toBeVisible()
  const pendingRequest = () => [...network.slow.requests, ...network.fast.requests].find(request => request.method === 'GET' && request.cid === first.original.cid)
  await expect.poll(pendingRequest).toBeDefined()
  const pending = pendingRequest()!
  await openReaderTools(page)
  await ui.next(page).click()
  await expectReaderImage(page, second.original.bytes)
  await expect.poll(() => pending.completedAt).toBeDefined()
  expect(pending.aborted).toBe(true)
  expect(new URL(page.url()).searchParams.get('item')).toBe(second.id)
  await expect(ui.menuButton(page)).toBeVisible()
  await expect(ui.reader(page).getByRole('img')).toHaveCount(1)
})

test('a truncated PNG header is rejected before native decoding and cannot be downloaded', async ({ page, galleryFixtures }) => {
  await captureMediaLifecycle(page)
  const bytes = createPng(32, 24, 500).slice(0, 33)
  const { cid } = await importBytes(bytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
  await page.goto(sourceUrl('cid', { cid: cid.toV1().toString(), path: [] }))
  await expect(ui.readerSurface(page).getByRole('alert')).toBeVisible()
  await expect(ui.reader(page).getByRole('img')).toHaveCount(0)
  expect(await mediaEvents(page)).toEqual([])
  await openReaderTools(page)
  await expect(ui.download(ui.readerTools(page))).toBeDisabled()
})

test('a hash-valid but undecodable PNG fails once, retries explicitly and downloads the exact verified bytes', async ({ page, galleryFixtures }) => {
  await captureMediaLifecycle(page)
  const bytes = createUndecodablePng(32, 24, 500)
  expect(bytes).toHaveLength(2408)
  const { cid } = await importBytes(bytes, galleryFixtures.store, { cidVersion: 1, rawLeaves: true })
  await page.goto(sourceUrl('cid', { cid: cid.toV1().toString(), path: [] }))
  await expect(ui.readerSurface(page).getByRole('alert')).toBeVisible()
  await expect(ui.reader(page).getByRole('img')).toHaveCount(0)
  expect((await mediaEvents(page)).filter(event => event.type === 'error')).toHaveLength(1)
  const failed = await mediaEvents(page)
  await page.waitForTimeout(350)
  expect(await mediaEvents(page)).toEqual(failed)
  await ui.readerSurface(page).getByRole('button', { name: '重试原始媒体', exact: true }).click()
  await expect.poll(async () => (await mediaEvents(page)).filter(event => event.type === 'error').length).toBe(2)
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), bytes)
  await ui.menuButton(page).click()
  const notice = page.locator('.reader-state .reader-notice')
  await expect(notice).toBeVisible()
  await expect(notice).not.toBeEmpty()
  const contrast = await notice.evaluate(element => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
    const foreground = rgb(getComputedStyle(element).color)
    let background = [0, 0, 0, 0]
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const color = rgb(getComputedStyle(parent).backgroundColor)
      if ((color[3] ?? 1) === 1) { background = color; break }
    }
    const luminance = (color: number[]) => color.slice(0, 3).map(channel => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
    const light = luminance(foreground), dark = luminance(background)
    return { foreground, background, ratio: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) }
  })
  expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(4.5)
  await writeFile(test.info().outputPath('reader-notice-contrast.json'), JSON.stringify(contrast))
})

test.describe('touch reader commands', () => {
  test.use({ hasTouch: true })
  test('a fit-scale mouse drag released over the menu leaves arrows and a fresh tap usable', async ({ page, previewFixtures }) => {
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
    const image = await ui.reader(page).getByRole('img').boundingBox()
    const button = await ui.menuButton(page).boundingBox()
    await page.mouse.move(image!.x + image!.width / 2, image!.y + image!.height / 2)
    await page.mouse.down()
    await page.mouse.move(button!.x + button!.width / 2, button!.y + button!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
    await ui.reader(page).focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[1]!.id)
    await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
    await ui.reader(page).getByRole('img').tap()
    await expect(ui.menuButton(page)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[1]!.id)
    await openReaderTools(page)
    await ui.next(page).click()
    await expectReaderImage(page, previewFixtures.items[2]!.original.bytes)
    await expect(ui.menuButton(page)).toBeVisible()
  })

  test('tap keeps the menu; unzoomed swipe selects once; pinch and pan keep the current item', async ({ page, context, previewFixtures, network }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const historyLength = await page.evaluate(() => history.length)
    await page.touchscreen.tap(180, 300)
    await expect(ui.menuButton(page)).toBeVisible()
    await page.keyboard.press('Escape')
    const cdp = await context.newCDPSession(page)
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 290, y: 300, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 304, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
      expect(new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[1]!.id)
      await expect(ui.menuButton(page)).toBeVisible()
      const selected = page.url()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 300, id: 1 }, { x: 230, y: 300, id: 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 60, y: 300, id: 1 }, { x: 270, y: 300, id: 2 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      expect(page.url()).toBe(selected)
      await expect(ui.menuButton(page)).toBeVisible()
      await test.step('reveal accessible reader tools after native pinch and zoom once', async () => {
        await openTouchReaderTools(page, cdp)
        const before = await readerTransform(page)
        expect(before.scale).toBeGreaterThan(1)
        expect(await page.evaluate(() => visualViewport!.scale)).toBeGreaterThan(1)
        await touchVisibleTarget(page, ui.zoomIn(page), cdp)
        await expect.poll(async () => (await readerTransform(page)).scale).toBeGreaterThan(before.scale)
        expect(page.url()).toBe(selected)
        await expect(ui.readerTools(page)).toBeVisible()
        await screenshot(page, testInfo, 'native-pinch-tools')
      })
      await page.keyboard.press('Escape')
      const beforePan = await readerTransform(page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y: 330, id: 3 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 350, id: 3 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      expect(page.url()).toBe(selected)
      await expect(ui.menuButton(page)).toBeVisible()
      await expect.poll(async () => (await readerTransform(page)).x).toBeLessThan(beforePan.x)
      expect((await readerTransform(page)).scale).toBe(beforePan.scale)
      const reads = network.bridge.routes.length
      await openTouchReaderTools(page, cdp)
      await touchVisibleTarget(page, ui.readerInfo(page), cdp)
      await expect(ui.dialog(page)).toHaveCount(1)
      expect(await ui.reader(page).evaluate(element => !!element.closest('[inert]'))).toBe(true)
      await screenshot(page, testInfo, 'native-pinch-info')
      await touchVisibleTarget(page, ui.closePanel(page), cdp)
      await expect(ui.dialog(page)).toHaveCount(0)
      await expect(ui.menuButton(page)).toBeFocused()
      await touchVisibleTarget(page, ui.menuButton(page), cdp)
      await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
      await page.evaluate(() => document.addEventListener('pointerdown', event => {
        Reflect.set(window, 'nativeSidebarOutside', { trusted: event.isTrusted, type: event.pointerType, backdrop: (event.target as Element).closest('.MuiBackdrop-root') !== null })
      }, { once: true }))
      const outside = await page.evaluate(() => ({ x: visualViewport!.width - 3, y: visualViewport!.height / 2 }))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: outside.x, y: outside.y, id: 1 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(ui.dialog(page)).toHaveCount(0)
      expect(await page.evaluate(() => Reflect.get(window, 'nativeSidebarOutside'))).toEqual({ trusted: true, type: 'touch', backdrop: true })
      await expect(ui.menuButton(page)).toBeFocused()
      expect(page.url()).toBe(selected)
      await expectReaderImage(page, previewFixtures.items[1]!.original.bytes)
      expect(network.bridge.routes).toHaveLength(reads)
    } finally { if (!page.isClosed()) await cdp.detach() }
    await touchVisibleTarget(page, ui.menuButton(page))
    await expect(ui.dialog(page)).toHaveCount(1)
    await touchVisibleTarget(page, ui.albumAction(page))
    await expect(ui.album(page)).toBeVisible()
    await expect(ui.dialog(page)).toHaveCount(0)
    await screenshot(page, testInfo, 'native-pinch-album')
    await touchVisibleTarget(page, ui.tile(page, previewFixtures.items[2]!.title))
    await expectReaderImage(page, previewFixtures.items[2]!.original.bytes)
    expect(new URL(page.url()).searchParams.get('item')).toBe(previewFixtures.items[2]!.id)
    await expect(ui.menuButton(page)).toBeVisible()
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
  })
})
