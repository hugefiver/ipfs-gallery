import { expect, test } from '../e2e/fixtures'
import { sourceUrl } from '../e2e/gateway-route'
import { ui, enterAlbum, openPanel, expectReaderImage, expectImageBytes, expectVideoBytes, observeVerifiedBlobs } from '../e2e/gallery-ui'

test.use({ appPrefix: '/gallery/' })

test('static subdirectory and documented CSP serve the app and real module Worker', async ({ page, network, context }) => {
  const exceptions: string[] = []
  const violations: string[] = []
  const workers: string[] = []
  page.on('pageerror', error => exceptions.push(error.message))
  page.on('worker', worker => workers.push(worker.url()))
  await page.exposeFunction('reportCspViolation', (directive: string) => violations.push(directive))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      void (window as unknown as { reportCspViolation: (value: string) => Promise<void> }).reportCspViolation(event.violatedDirective)
    })
  })
  network.slow.setMode({ kind: '404' })
  network.fast.setMode({ kind: '404' })
  const cid = 'bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom'
  const search = new URL(sourceUrl('unixfs', { cid, path: [] }), network.baseURL).search
  const response = await page.goto(`${network.baseURL}${search}`)
  expect(response?.status()).toBe(200)
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect.poll(() => workers.length).toBeGreaterThan(0)
  expect(workers.every(url => url.startsWith(`${network.baseURL}assets/`))).toBe(true)
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 30_000 })
  const registration = await page.evaluate(async () => ({ scope: (await navigator.serviceWorker.getRegistration())?.scope, controller: navigator.serviceWorker.controller?.scriptURL }))
  expect(registration.scope).toBe(network.baseURL)
  expect(registration.controller).toBe(`${network.baseURL}ipfs-service-worker.js`)
  const scriptHeaders = await page.evaluate(async () => {
    const result = await fetch('./ipfs-service-worker.js')
    return { status: result.status, csp: result.headers.get('content-security-policy'), mime: result.headers.get('content-type') }
  })
  expect(scriptHeaders.status).toBe(200)
  expect(scriptHeaders.mime).toContain('javascript')
  expect(scriptHeaders.csp).toContain("connect-src 'self' https: wss:")
  const sibling = await context.newPage()
  try {
    await sibling.goto(new URL('/sibling/', network.baseURL).href)
    expect(await sibling.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  } finally { await sibling.close() }
  expect(exceptions).toEqual([])
  expect(violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('static subpath serves verified reader, menu-entered album and one lazy network modal', async ({ page, galleryFixtures: fixtures, network }) => {
  const exceptions: string[] = []
  const violations: string[] = []
  page.on('pageerror', error => exceptions.push(error.message))
  await observeVerifiedBlobs(page)
  await page.exposeFunction('deploymentCspViolation', (directive: string) => violations.push(directive))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      void (window as unknown as { deploymentCspViolation: (value: string) => Promise<void> }).deploymentCspViolation(event.violatedDirective)
    })
  })
  const search = new URL(sourceUrl('unixfs', fixtures.directories.json.ref), network.baseURL).search
  await page.goto(`${network.baseURL}${search}`)
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(page.workers().length).toBeGreaterThan(0)
  expect(page.workers().every(worker => worker.url().startsWith(`${network.baseURL}assets/`))).toBe(true)
  await enterAlbum(page)
  await expectImageBytes(ui.tileImage(page, '琥珀影像'), fixtures.raw.bytes)
  const videoTile = ui.tile(page, '短片影像')
  await videoTile.scrollIntoViewIfNeeded()
  await expectVideoBytes(videoTile.locator('..').locator('video'), fixtures.video.bytes)
  await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(ui.menuButton(page)).toBeFocused()
  expect([...network.slow.requests, ...network.fast.requests].some(request => request.status === 200)).toBe(true)
  expect(network.bridge.routes.every(route => new URL(route.url).searchParams.get('format') === 'raw')).toBe(true)
  expect(network.bridge.errors).toEqual([])
  expect(exceptions).toEqual([])
  expect(violations).toEqual([])
})
