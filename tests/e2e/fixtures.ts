import { test as base, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createGalleryFixtures, type GalleryFixtures } from '../fixtures/unixfs'
import { startTrustlessGateway, type TrustlessGateway } from '../support/trustless-gateway'
import { routeFixtureGateways } from './gateway-route'
import { createPreviewFixtures, type PreviewFixtures } from './preview-fixtures'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'

type NetworkFixture = {
  slow: TrustlessGateway
  fast: TrustlessGateway
  bridge: Awaited<ReturnType<typeof routeFixtureGateways>>
  unexpectedRequests: string[]
}

export const test = base.extend<{ network: NetworkFixture; allowDefaultGateways: boolean; surfaceDiagnostics: void }, { galleryFixtures: GalleryFixtures; previewFixtures: PreviewFixtures }>({
  serviceWorkers: 'block',
  allowDefaultGateways: [false, { option: true }],
  surfaceDiagnostics: [async ({ page }, use, testInfo) => {
    const errors: string[] = []
    const failedRequests: { url: string; error: string | undefined }[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
    await use(undefined)
    if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return
    const domPath = testInfo.outputPath('production-dom.html')
    await writeFile(domPath, await page.content())
    await testInfo.attach('production-dom', { path: domPath, contentType: 'text/html' })
    const state = await page.evaluate(() => ({
      url: location.href,
      scripts: Array.from(document.scripts, script => script.src).filter(Boolean),
      modules: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\/assets\/.+\.(js|css)(?:\?|$)/.test(name)),
      focus: document.activeElement?.outerHTML,
      viewport: { width: innerWidth, height: innerHeight },
      visualViewport: visualViewport && { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, top: visualViewport.offsetTop, left: visualViewport.offsetLeft },
      surfaces: Array.from(document.querySelectorAll('main, section[aria-label], [role="region"][aria-label]'), element => {
        const box = element.getBoundingClientRect()
        return { tag: element.tagName, label: element.getAttribute('aria-label'), x: box.x, y: box.y, width: box.width, height: box.height, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
      }),
      controls: Array.from(document.querySelectorAll('button'), element => {
        const box = element.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { text: element.textContent, label: element.getAttribute('aria-label'), x: box.x, y: box.y, width: box.width, height: box.height, hit: !!hit && element.contains(hit) }
      }),
      dialogs: Array.from(document.querySelectorAll('dialog'), element => ({ open: element.open, html: element.outerHTML })),
    }))
    const statePath = testInfo.outputPath('production-state.json')
    await writeFile(statePath, JSON.stringify({ ...state, workers: page.workers().map(worker => worker.url()), errors, failedRequests }, null, 2))
    await testInfo.attach('production-state', { path: statePath, contentType: 'application/json' })
    const screenPath = testInfo.outputPath('production-screen.png')
    await page.screenshot({ path: screenPath })
    await testInfo.attach('production-screen', { path: screenPath, contentType: 'image/png' })
  }, { auto: true }],
  galleryFixtures: [async ({ browserName }, use) => {
    void browserName
    await use(await createGalleryFixtures())
  }, { scope: 'worker' }],
  previewFixtures: [async ({ galleryFixtures }, use) => {
    await use(await createPreviewFixtures(galleryFixtures))
  }, { scope: 'worker' }],
  network: [async ({ context, baseURL, galleryFixtures, previewFixtures, allowDefaultGateways }, use) => {
    void previewFixtures
    if (!baseURL) throw new Error('Fixture retrieval requires an isolated application baseURL')
    const appOrigin = new URL(baseURL).origin
    if (new URL(baseURL).port === '4173') throw new Error('Fixture tests must not use the user preview')
    const external = (url: URL) => ['http:', 'https:'].includes(url.protocol) && url.origin !== appOrigin
    const slow = await startTrustlessGateway(galleryFixtures.blocks, { kind: 'delay', milliseconds: 40 })
    let fast: TrustlessGateway | undefined
    let bridge: Awaited<ReturnType<typeof routeFixtureGateways>> | undefined
    const unexpectedRequests: string[] = []
    const denyExternal = async (route: import('@playwright/test').Route) => {
      unexpectedRequests.push(route.request().url())
      await route.abort('blockedbyclient')
    }
    try {
      fast = await startTrustlessGateway(galleryFixtures.blocks)
      // Never allow a broken URL/configuration test to hit a public gateway.
      await context.route(external, denyExternal)
      bridge = await routeFixtureGateways(context, { slow, fast }, allowDefaultGateways ? DEFAULT_GATEWAYS : [])
      await use({ slow, fast, bridge, unexpectedRequests })
      expect(unexpectedRequests).toEqual([])
      expect(bridge.errors).toEqual([])
    } finally {
      await bridge?.close()
      await context.unroute(external, denyExternal)
      await Promise.all([slow.close(), fast?.close()])
    }
  }, { auto: true }],
})

export { expect }
