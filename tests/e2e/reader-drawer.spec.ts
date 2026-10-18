import { test, expect } from './fixtures'
import { sourceUrl } from './gateway-route'
import { ui, openMenu, openPanel, openReaderTools, enterAlbum, enterReader, expectReaderImage, expectDownloadBytes, screenshot } from './gallery-ui'
import type { CDPSession } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

async function touchTap(cdp: CDPSession, x: number, y: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y, radiusX: 1, radiusY: 1, force: 1 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`left sidebar same-position toggle and outside close preserve media with ${reducedMotion} motion`, async ({ page, previewFixtures, network }, testInfo) => {
    await page.emulateMedia({ reducedMotion })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const image = await ui.reader(page).getByRole('img').elementHandle()
    const stage = await ui.reader(page).boundingBox()
    const menu = await ui.menuButton(page).boundingBox()
    const reads = network.bridge.routes.length
    await expect(page.getByRole('button')).toHaveCount(1)
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await ui.menuButton(page).click()
      await expect(ui.dialog(page)).toHaveAccessibleName('菜单')
      await expect(ui.menuButton(page)).toHaveCount(1)
      expect(await ui.menuButton(page).boundingBox()).toEqual(menu)
      await expect.poll(async () => (await ui.dialog(page).locator('.gallery-drawer-surface').boundingBox())!.x).toBe(0)
      const geometry = await ui.dialog(page).locator('.gallery-drawer-surface').boundingBox()
      expect(geometry!.width).toBeLessThan(375)
      await screenshot(page, testInfo, `sidebar-open-${reducedMotion}-${cycle}`)
      await ui.menuButton(page).click()
      await expect(ui.dialog(page)).toHaveCount(0)
      await expect(ui.menuButton(page)).toBeFocused()
    }
    for (const panel of ['source', 'filters', 'info', 'network'] as const) {
      await openPanel(page, panel)
      await page.mouse.click(370, 700)
      await expect(ui.dialog(page)).toHaveCount(0)
      await expect(ui.menuButton(page)).toBeFocused()
    }
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), previewFixtures.items[0]!.original.bytes)
    await ui.closePanel(page).click()
    expect(await image!.evaluate(element => element.isConnected)).toBe(true)
    expect(await ui.reader(page).boundingBox()).toEqual(stage)
    expect(network.bridge.routes).toHaveLength(reads)
    await image!.dispose()
    await screenshot(page, testInfo, `sidebar-closed-${reducedMotion}`)
  })
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`trusted touch rapid reversals and backdrop consume without media action with ${reducedMotion} motion`, async ({ page, previewFixtures, network }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const url = page.url(), reads = network.bridge.routes.length
    const box = (await ui.menuButton(page).boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await page.evaluate(() => {
        Reflect.set(window, 'sidebarPointers', [])
        document.addEventListener('pointerdown', event => {
          const target = event.target as Element
          Reflect.get(window, 'sidebarPointers').push({ trusted: event.isTrusted, type: event.pointerType, target: target.closest('[data-menu-trigger]') ? 'toggle' : target.closest('.MuiBackdrop-root') ? 'backdrop' : 'media-or-content' })
        })
      })
      for (let input = 0; input < 7; input += 1) {
        await touchTap(cdp, box.x + box.width / 2, box.y + box.height / 2)
        await expect(ui.dialog(page)).toHaveCount(input % 2 === 0 ? 1 : 0)
        expect(await ui.menuButton(page).boundingBox()).toEqual(box)
      }
      await screenshot(page, testInfo, `touch-sidebar-open-${reducedMotion}`)
      await touchTap(cdp, 370, 700)
      await expect(ui.dialog(page)).toHaveCount(0)
      const pointers = await page.evaluate(() => Reflect.get(window, 'sidebarPointers'))
      expect(pointers).toEqual([...Array.from({ length: 7 }, () => ({ trusted: true, type: 'touch', target: 'toggle' })), { trusted: true, type: 'touch', target: 'backdrop' }])
      await testInfo.attach('trusted-touch-hit-targets', { body: JSON.stringify(pointers), contentType: 'application/json' })
      expect(page.url()).toBe(url)
      expect(network.bridge.routes).toHaveLength(reads)
      await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
      await expect(ui.menuButton(page)).toBeFocused()
      await screenshot(page, testInfo, `touch-sidebar-closed-${reducedMotion}`)
    } finally { await cdp.detach() }
  })
}

test('source and network drafts remain through sidebar replacement, close and reopen without reads', async ({ page, previewFixtures, network }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const reads = network.bridge.routes.length
  await openPanel(page, 'source')
  await ui.source(page).fill('未提交的来源草稿')
  await ui.closePanel(page).click()
  await openPanel(page, 'network')
  await ui.gateways(ui.settingsDialog(page)).first().fill('https://draft.gallery-fixture.net')
  await ui.closePanel(page).click()
  await openPanel(page, 'source')
  await expect(ui.source(page)).toHaveValue('未提交的来源草稿')
  await ui.closePanel(page).click()
  await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page)).first()).toHaveValue('https://draft.gallery-fixture.net')
  expect(network.bridge.routes).toHaveLength(reads)
})

for (const width of [320, 375, 768, 1280, 2000]) {
  test(`empty Material sidebar is one full-height surface at ${width}px`, async ({ page, network }, testInfo) => {
    await page.setViewportSize({ width, height: 1125 })
    await page.goto('/')
    await expect(ui.source(page)).toBeFocused()
    const surface = ui.dialog(page).locator('.gallery-drawer-surface')
    await expect.poll(async () => (await surface.boundingBox())?.x).toBe(0)
    const stage = (await ui.surface(page).boundingBox())!
    expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: width === 320 ? 296 : 320, height: stage.height })
    const title = await ui.dialog(page).getByRole('heading', { level: 2 }).evaluate(element => ({ size: getComputedStyle(element).fontSize, family: getComputedStyle(element).fontFamily, weight: getComputedStyle(element).fontWeight }))
    expect(title.size).toBe('20px'); expect(title.weight).toBe('500'); expect(title.family).toContain('Noto Sans SC')
    expect(await surface.evaluate(element => ({ color: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }))).toEqual({ color: 'rgba(255, 255, 255, 0.9)', radius: '0px' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await screenshot(page, testInfo, `empty-source-${width}`)
    const png = await page.screenshot()
    const pixels = await page.evaluate(async bytes => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      try {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
        return { sidebar: Array.from(context.getImageData(3, Math.floor(image.height * .7), 1, 1).data), main: Array.from(context.getImageData(image.width - 5, Math.floor(image.height * .5), 1, 1).data) }
      } finally { URL.revokeObjectURL(url) }
    }, Array.from(png))
    for (let channel = 0; channel < 3; channel += 1) {
      const composite = Math.round(255 * .9 + pixels.main[channel]! * .1)
      expect(Math.abs(pixels.sidebar[channel]! - composite)).toBeLessThanOrEqual(2)
      expect(pixels.main[channel]!).toBeLessThanOrEqual(24)
    }
    expect(pixels.sidebar[3]).toBe(255); expect(pixels.main[3]).toBe(255)
    await testInfo.attach('surface-geometry-pixels', { body: JSON.stringify({ width, box: await surface.boundingBox(), title, pixels }), contentType: 'application/json' })
    await ui.closePanel(page).click()
    await expect(ui.dialog(page)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '打开一个影像来源', exact: true })).toBeVisible()
    await screenshot(page, testInfo, `empty-main-${width}`)
    expect(network.bridge.routes).toHaveLength(0)
  })
}

for (const width of [375, 768, 1280]) {
  test(`real media and every Material panel retain one width at ${width}px`, async ({ page, previewFixtures, network }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
    await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
    const stage = await ui.reader(page).boundingBox(), reads = network.bridge.routes.length
    await screenshot(page, testInfo, `reader-${width}`)
    for (const panel of ['menu', 'source', 'filters', 'info', 'network', 'readerTools'] as const) {
      if (panel === 'menu') await openMenu(page)
      else if (panel === 'readerTools') await openReaderTools(page)
      else await openPanel(page, panel)
      if (panel === 'network') await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
      const surface = ui.dialog(page).locator('.gallery-drawer-surface')
      await expect.poll(async () => (await surface.boundingBox())?.x).toBe(0)
      expect(await surface.boundingBox()).toEqual({ x: 0, y: 0, width: 320, height: 900 })
      expect(await ui.reader(page).boundingBox()).toEqual(stage)
      await screenshot(page, testInfo, `${panel}-${width}`)
      if (panel === 'readerTools') await expectDownloadBytes(page, ui.readerTools(page), previewFixtures.items[0]!.original.bytes)
    }
    expect(network.bridge.routes).toHaveLength(reads)
  })
}

for (const motion of ['180ms', '.18s']) {
test(`normal close keeps integral 320px toolbar and body paint with ${motion}; rapid reopen retains the new active panel`, async ({ page, previewFixtures }, testInfo) => {
  await page.clock.install()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await page.evaluate(value => document.documentElement.style.setProperty('--motion-panel', value, 'important'), motion)
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await openMenu(page)
  await expect.poll(async () => (await ui.dialog(page).locator('.gallery-drawer-surface').boundingBox())?.x).toBe(0)
  const menuRows = await ui.dialog(page).locator('.gallery-menu button').allTextContents()
  expect(menuRows.length).toBeGreaterThan(0)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await page.evaluate(() => {
    const surface = document.querySelector('.gallery-drawer-surface')!
    Reflect.set(window, 'sidebarExitEnvironment', { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, motion: getComputedStyle(document.documentElement).getPropertyValue('--motion-panel'), transition: getComputedStyle(surface).transition, openingX: surface.getBoundingClientRect().x })
    document.querySelector('[data-menu-trigger]')!.addEventListener('click', event => Reflect.set(window, 'sidebarExitTrustedClick', event.isTrusted), { once: true })
    surface.addEventListener('transitionrun', event => {
      if ((event as TransitionEvent).propertyName !== 'transform') return
      const animation = surface.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'transform')
      if (!animation) return
      animation.pause()
      animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2
      Reflect.set(window, 'sidebarExitAnimation', animation)
    }, { once: true })
  })
  await ui.menuButton(page).click()
  await expect(ui.dialog(page)).toHaveCount(0)
  await writeFile(testInfo.outputPath('normal-exit-diagnostics.json'), JSON.stringify(await page.evaluate(() => ({
    environment: Reflect.get(window, 'sidebarExitEnvironment'),
    trustedClick: Reflect.get(window, 'sidebarExitTrustedClick'),
    transition: getComputedStyle(document.querySelector('.gallery-drawer-surface')!).transition,
  }))))
  await expect.poll(() => page.evaluate(() => !!Reflect.get(window, 'sidebarExitAnimation'))).toBe(true)
  const observation = await page.evaluate(() => {
    const animation = Reflect.get(window, 'sidebarExitAnimation') as Animation
    const duration = Number(animation.effect!.getComputedTiming().duration)
    const surface = document.querySelector('.gallery-drawer-surface')!, dialog = document.querySelector('#gallery-panel')!
    const frames = [0, .25, .5, .75].map(progress => {
      animation.currentTime = duration * progress
      return { time: duration * progress, width: surface.getBoundingClientRect().width, x: surface.getBoundingClientRect().x, title: document.querySelector('#gallery-panel-title')!.textContent, menuRows: Array.from(surface.querySelectorAll('.gallery-menu button'), button => button.textContent ?? ''), inactive: dialog.getAttribute('aria-hidden') === 'true' && dialog.hasAttribute('inert') }
    })
    animation.currentTime = duration / 2
    return { environment: Reflect.get(window, 'sidebarExitEnvironment'), trustedClick: Reflect.get(window, 'sidebarExitTrustedClick'), duration, frames }
  })
  await writeFile(testInfo.outputPath('normal-exit-diagnostics.json'), JSON.stringify(observation))
  const cdp = await page.context().newCDPSession(page)
  try {
    const midframe = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const path = testInfo.outputPath('normal-exit-midframe.png')
    await writeFile(path, Buffer.from(midframe.data, 'base64'))
    await testInfo.attach('normal-exit-midframe', { path, contentType: 'image/png' })
  } finally { await cdp.detach() }
  const { frames } = observation
  expect(observation.trustedClick).toBe(true)
  expect(observation.duration).toBe(180)
  expect(frames.some(frame => frame.x < 0 && frame.x > -320)).toBe(true)
  for (const frame of frames) { expect(frame.width).toBe(320); expect(frame.title).toBe('菜单'); expect(frame.menuRows).toEqual(menuRows); expect(frame.inactive).toBe(true) }
  await testInfo.attach('normal-exit-frames', { body: JSON.stringify(frames), contentType: 'application/json' })
  await writeFile(testInfo.outputPath('normal-exit-frames.json'), JSON.stringify(frames))
  await page.evaluate(() => (Reflect.get(window, 'sidebarExitAnimation') as Animation).play())
  await page.clock.runFor(observation.duration)
  await page.clock.resume()
  await openReaderTools(page)
  await ui.closePanel(page).click()
  await expect(ui.dialog(page)).toHaveCount(0)
  expect(await page.locator('.reader-tools-exit-paint').textContent()).toContain(previewFixtures.items[0]!.title)
  await ui.menuButton(page).click()
  await ui.panelAction(page, 'source').click()
  await ui.source(page).fill('新的未提交草稿')
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 200)))
  await expect(ui.source(page)).toHaveValue('新的未提交草稿')
  await expect(ui.source(page)).toBeFocused()
  await screenshot(page, testInfo, 'rapid-reopen-source')
})
}

test('safe-area stays inside the full-height sidebar while menu and Source recovery remain hittable', async ({ page, previewFixtures }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty('--safe-top', '44px'); root.style.setProperty('--safe-bottom', '34px'); root.style.setProperty('--safe-left', '20px')
  })
  const menu = (await ui.menuButton(page).boundingBox())!
  expect(menu).toMatchObject({ x: 32, y: 56, width: 48, height: 48 })
  await openPanel(page, 'source')
  const surface = ui.dialog(page).locator('.gallery-drawer-surface')
  await expect.poll(async () => (await surface.boundingBox())?.x).toBe(0)
  expect(await surface.boundingBox()).toMatchObject({ x: 0, y: 0, width: 320, height: (await ui.surface(page).boundingBox())!.height })
  expect(await ui.back(page).boundingBox()).toEqual(menu)
  await ui.source(page).fill('保留的来源草稿')
  for (const control of [ui.back(page), ui.closePanel(page), ui.source(page)]) {
    const geometry = await control.evaluate(element => {
      const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { width: box.width, height: box.height, top: box.top, bottom: box.bottom, owned: !!hit && element.contains(hit) }
    })
    expect(geometry.width).toBeGreaterThanOrEqual(44); expect(geometry.height).toBeGreaterThanOrEqual(44)
    expect(geometry.top).toBeGreaterThanOrEqual(44); expect(geometry.bottom).toBeLessThanOrEqual(812 - 34); expect(geometry.owned).toBe(true)
  }
  await screenshot(page, testInfo, 'safe-area-source')
  await writeFile(testInfo.outputPath('safe-area-geometry.json'), JSON.stringify({ surface: await surface.boundingBox(), menu, input: await ui.source(page).boundingBox(), close: await ui.closePanel(page).boundingBox(), stage: await ui.surface(page).boundingBox() }))
  await page.mouse.click(372, 400)
  await expect(ui.dialog(page)).toHaveCount(0)
  await expect(ui.menuButton(page)).toBeFocused()
  await openPanel(page, 'source')
  await expect(ui.source(page)).toHaveValue('保留的来源草稿')
  await expect(ui.source(page)).toBeFocused()
})

test('Source and Network drafts survive Reader Album handoffs; explicit Network cancel restores committed rows', async ({ page, previewFixtures, network }) => {
  await page.goto(sourceUrl('meta', previewFixtures.manifest.ref))
  await expectReaderImage(page, previewFixtures.items[0]!.original.bytes)
  const sourceReads = () => network.bridge.routes.filter(route => new URL(route.url).pathname.endsWith(`/${previewFixtures.manifest.cid}`)).length
  const reads = sourceReads()
  expect(reads).toBeGreaterThan(0)
  await openPanel(page, 'source'); await ui.source(page).fill('跨模式来源草稿')
  await enterAlbum(page); await openPanel(page, 'source'); await expect(ui.source(page)).toHaveValue('跨模式来源草稿')
  await openPanel(page, 'network')
  const committed = await ui.gateways(ui.settingsDialog(page)).first().inputValue()
  await ui.gateways(ui.settingsDialog(page)).first().fill('https://draft.gallery-fixture.net')
  await enterReader(page); await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page)).first()).toHaveValue('https://draft.gallery-fixture.net')
  await ui.settingsDialog(page).getByRole('button', { name: '取消', exact: true }).click()
  await openPanel(page, 'network'); await expect(ui.gateways(ui.settingsDialog(page)).first()).toHaveValue(committed)
  expect(sourceReads()).toBe(reads)
})
