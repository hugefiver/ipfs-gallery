import { test as base, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createGalleryFixtures, type GalleryFixtures } from '../fixtures/unixfs'
import { startSwGalleryNetwork, SW_GALLERY_BROWSER_ARGS, type SwGalleryNetwork } from '../support/sw-gallery-network'
import { createPreviewFixtures, type PreviewFixtures } from './preview-fixtures'
import { expectedSwGalleryPolicy, type SwGalleryTestOptions } from '../support/sw-gallery-policy'
import { createPng } from '../fixtures/media'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { createSwBoundaryPng } from '../support/sw-gallery-media'
import type { FixtureFile } from '../fixtures/unixfs'
import { observeVerifiedBlobs } from './gallery-ui'

type NetworkFixture = SwGalleryNetwork & { boundary?: FixtureFile; alternate: Uint8Array }

export const test = base.extend<SwGalleryTestOptions & { network: NetworkFixture; boundaryBlock: 'none' | '2MiB' | '4MiB'; allowDefaultGateways: boolean; directTransport: 'none' | 'bitswap' | 'http'; appPrefix: '/' | '/gallery/'; mediaObservation: void; surfaceDiagnostics: void }, { galleryFixtures: GalleryFixtures; previewFixtures: PreviewFixtures }>({
  serviceWorkers: 'allow',
  launchOptions: { args: SW_GALLERY_BROWSER_ARGS },
  directTransport: ['none', { option: true }],
  appPrefix: ['/', { option: true }],
  boundaryBlock: ['none', { option: true }],
  expectedPolicy: [expectedSwGalleryPolicy(), { option: true }],
  galleryBuildDir: [undefined, { option: true }],
  oppositeBuildDir: [undefined, { option: true }],
  serviceWorkerBuildDir: [undefined, { option: true }],
  dedicatedWorkerBuildDir: [undefined, { option: true }],
  alternateGatewayMedia: [false, { option: true }],
  httpProviderAsGateway: [false, { option: true }],
  baseURL: async ({ network }, use) => { await use(network.baseURL) },
  proxy: async ({ network }, use) => { await use({ server: network.proxy.proxyUrl, bypass: '<-loopback>' }) },
  allowDefaultGateways: [false, { option: true }],
  mediaObservation: [async ({ context }, use) => {
    await observeVerifiedBlobs(context)
    await use(undefined)
  }, { auto: true }],
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
  network: [async ({ galleryFixtures, previewFixtures, allowDefaultGateways, directTransport, appPrefix, boundaryBlock,
    expectedPolicy, galleryBuildDir, serviceWorkerBuildDir, dedicatedWorkerBuildDir, alternateGatewayMedia, httpProviderAsGateway }, use) => {
    void previewFixtures
    const blocks = alternateGatewayMedia || boundaryBlock !== 'none' ? new Map(galleryFixtures.blocks) : galleryFixtures.blocks
    const alternate = createPng(32, 24, 197)
    if (alternateGatewayMedia) blocks.set(galleryFixtures.raw.cid, { cid: CID.parse(galleryFixtures.raw.cid), bytes: alternate })
    let boundary: FixtureFile | undefined
    if (boundaryBlock !== 'none') {
      const bytes = createSwBoundaryPng(boundaryBlock === '2MiB' ? 2 : 4)
      const cid = CID.createV1(0x55, await sha256.digest(bytes))
      boundary = { cid: cid.toString(), ref: { cid: cid.toString(), path: [] }, bytes }
      blocks.set(cid.toString(), { cid, bytes })
    }
    const network = await startSwGalleryNetwork(blocks, {
      prefix: appPrefix,
      buildDir: galleryBuildDir,
      serviceWorkerBuildDir,
      dedicatedWorkerBuildDir,
      httpProviderAsGateway,
      transport: directTransport,
      additionalGateways: allowDefaultGateways ? expectedPolicy.defaultGateways : [],
    })
    try {
      await use(Object.assign(network, { boundary, alternate }))
      expect(network.unexpectedRequests).toEqual([])
      expect(network.bridge.errors).toEqual([])
    } finally {
      await network.close()
    }
  }, { auto: true }],
})

export { expect }
