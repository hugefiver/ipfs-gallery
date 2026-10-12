import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import { createGalleryFixtures } from '../fixtures/unixfs'
import { startTrustlessGateway } from '../support/trustless-gateway'
import { routeFixtureGateways, sourceUrl } from '../e2e/gateway-route'
import { ui, enterAlbum, openPanel, expectReaderImage, expectImageBytes, expectVideoBytes, observeVerifiedBlobs } from '../e2e/gallery-ui'

const dist = resolve(process.env.GALLERY_BUILD_DIR ?? '.reader-album-build')
const prefix = '/gallery/'
const mime: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
}
const csp = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' https:; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
let server: Server
let origin: string

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end()
      return
    }
    const path = resolve(dist, decodeURIComponent(pathname.slice(prefix.length) || 'index.html'))
    if (!path.startsWith(`${dist}${sep}`)) {
      response.writeHead(403).end()
      return
    }
    try {
      const bytes = await readFile(path)
      response.writeHead(200, {
        'Content-Type': mime[path.split('.').at(-1) ?? ''] ?? 'application/octet-stream',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
      }).end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing owned static server address')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
})

test('static subdirectory and documented CSP serve the app and real module Worker', async ({ page }) => {
  const exceptions: string[] = []
  const violations: string[] = []
  const workers: string[] = []
  page.on('pageerror', (error) => exceptions.push(error.message))
  page.on('worker', (worker) => workers.push(worker.url()))
  await page.exposeFunction('reportCspViolation', (directive: string) => violations.push(directive))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (window as unknown as { reportCspViolation: (value: string) => Promise<void> })
        .reportCspViolation(event.violatedDirective)
    })
  })
  await page.context().route('https://**/*', (route) => route.fulfill({
    status: 404,
    headers: { 'access-control-allow-origin': '*' },
    body: '',
  }))
  const cid = 'bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom'
  const response = await page.goto(`${origin}${prefix}?unixfs=${cid}`)
  expect(response?.status()).toBe(200)
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect.poll(() => workers.length).toBeGreaterThan(0)
  expect(workers.every((url) => url.startsWith(`${origin}${prefix}assets/`))).toBe(true)
  await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 30_000 })
  expect(exceptions).toEqual([])
  expect(violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('static subpath serves verified reader, menu-entered album and one lazy network modal', async ({ page, context }) => {
  const fixtures = await createGalleryFixtures()
  const gateway = await startTrustlessGateway(fixtures.blocks)
  const bridge = await routeFixtureGateways(context, { slow: gateway, fast: gateway })
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
  try {
    const search = new URL(sourceUrl('unixfs', fixtures.directories.json.ref), origin).search
    await page.goto(`${origin}${prefix}${search}`)
    await expectReaderImage(page, fixtures.raw.bytes)
    expect(page.workers().length).toBeGreaterThan(0)
    expect(page.workers().every(worker => worker.url().startsWith(`${origin}${prefix}assets/`))).toBe(true)
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
    expect(gateway.requests.some(request => request.status === 200)).toBe(true)
    expect(bridge.routes.every(route => new URL(route.url).searchParams.get('format') === 'raw')).toBe(true)
    expect(bridge.errors).toEqual([])
    expect(exceptions).toEqual([])
    expect(violations).toEqual([])
  } finally {
    await bridge.close()
    await gateway.close()
  }
})
