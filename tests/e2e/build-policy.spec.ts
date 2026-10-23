import { resolve } from 'node:path'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { test, expect } from './fixtures'
import { sourceUrl, FIXTURE_GATEWAYS } from './gateway-route'
import { expectDownloadBytes, expectReaderImage, openPanel, openReaderTools, ui } from './gallery-ui'
import { observeSwGalleryBlocks } from '../support/sw-gallery-evidence'
import { SW_GALLERY_BLOCK_PATH } from '../support/sw-gallery-policy'
import { SW_GALLERY_HTTP_PROVIDER } from '../support/sw-gallery-network'
import { exerciseSwPrivateSession } from './sw-private-session'
import { createPng } from '../fixtures/media'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

test.use({ allowDefaultGateways: true })
const preferenceKey = 'ipfs-gallery.preferences.v1'
const downloadName = (trustless: boolean) => trustless ? '下载经过验证的原始媒体' : '下载原始媒体'

function recordWorkerTerminalErrors(): void {
  const errors: string[] = []
  Reflect.set(window, 'swGalleryTerminalErrors', errors)
  const NativeWorker = Worker
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', event => {
        if (event.data?.type === 'error' && typeof event.data.error?.code === 'string') errors.push(event.data.error.code)
      })
    }
  }
}

test('source-free entry and a real identity media CID remain local in either build', async ({ page, network, expectedPolicy }) => {
  await page.goto('/')
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(values => values.length))).toBe(0)
  const bytes = createPng(1, 1, 7)
  const cid = CID.createV1(0x55, identity.digest(bytes)).toString()
  await page.goto(sourceUrl('unixfs', { cid, path: [] }, {}, []))
  await expectReaderImage(page, bytes)
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), bytes, downloadName(expectedPolicy.trustless))
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(values => values.length))).toBe(0)
  expect(network.router.events).toEqual([])
  expect(network.httpProvider.events).toEqual([])
  expect(network.bridge.routes).toEqual([])
})

test('compiled defaults, saved preferences and URL keep precedence without changing policy', async ({ page, galleryFixtures: fixtures, network, expectedPolicy }) => {
  const path = sourceUrl('unixfs', fixtures.raw.ref, {}, [])
  const evidence = await observeSwGalleryBlocks(page, fixtures.blocks, expectedPolicy)
  await page.goto(path)
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBeNull()
  await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page))).toHaveCount(expectedPolicy.defaultGateways.length)
  expect(await ui.gateways(ui.settingsDialog(page)).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value).filter(Boolean)))
    .toEqual(expectedPolicy.defaultGateways)
  await page.keyboard.press('Escape')
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes, downloadName(expectedPolicy.trustless))
  await evidence.finish()
  expect(evidence.cids).toContain(fixtures.raw.cid)
  const saved = { version: 1, layout: 'auto', sidebar: { desktop: true, mobile: false }, gateways: [FIXTURE_GATEWAYS.fast] }
  await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: preferenceKey, saved })
  let before = network.bridge.routes.length
  await page.goto(path)
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(network.bridge.routes.slice(before).map(route => new URL(route.url).origin)).toEqual(expect.arrayContaining([FIXTURE_GATEWAYS.fast]))
  expect(network.bridge.routes.slice(before).every(route => new URL(route.url).origin === FIXTURE_GATEWAYS.fast)).toBe(true)
  before = network.bridge.routes.length
  await page.goto(`${sourceUrl('unixfs', fixtures.raw.ref, {}, [FIXTURE_GATEWAYS.slow])}&trustless=${!expectedPolicy.trustless}`)
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(network.bridge.routes.slice(before).map(route => new URL(route.url).origin)).toEqual(expect.arrayContaining([FIXTURE_GATEWAYS.slow]))
  expect(network.bridge.routes.slice(before).every(route => new URL(route.url).origin === FIXTURE_GATEWAYS.slow)).toBe(true)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).gateways, preferenceKey)).toEqual(saved.gateways)
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes, downloadName(expectedPolicy.trustless))
  await evidence.finish()
  await page.evaluate(({ key, saved, mode }) => localStorage.setItem(key, JSON.stringify({ ...saved, trustless: mode })),
    { key: preferenceKey, saved, mode: !expectedPolicy.trustless })
  await page.goto(path)
  await expectReaderImage(page, fixtures.raw.bytes)
  await openPanel(page, 'network')
  await expect(ui.gateways(ui.settingsDialog(page))).toHaveCount(expectedPolicy.defaultGateways.length)
  expect(await ui.gateways(ui.settingsDialog(page)).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value).filter(Boolean)))
    .toEqual(expectedPolicy.defaultGateways)
  await page.keyboard.press('Escape')
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes, downloadName(expectedPolicy.trustless))
  await evidence.finish()
  expect(evidence.cids).toContain(fixtures.raw.cid)
})

for (const prefix of ['/', '/gallery/'] as const) {
  test.describe(`configured wrong-hash gateway at ${prefix}`, () => {
    test.use({ appPrefix: prefix, alternateGatewayMedia: true })
    test('only explicit non-strict compilation admits a different valid PNG through the private byte chain', async ({ page, galleryFixtures: fixtures, network, expectedPolicy }) => {
      if (expectedPolicy.trustless) {
        test.setTimeout(DEFAULT_LIMITS.blockTimeoutMs + 30_000)
        await page.addInitScript(recordWorkerTerminalErrors)
      }
      const blocks = new Map(fixtures.blocks)
      blocks.set(fixtures.raw.cid, { cid: CID.parse(fixtures.raw.cid), bytes: network.alternate })
      const evidence = await observeSwGalleryBlocks(page, blocks, expectedPolicy)
      const query = new URL(sourceUrl('unixfs', fixtures.raw.ref, {}, []), network.baseURL).search
      const rejected = expectedPolicy.trustless ? page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith(`${SW_GALLERY_BLOCK_PATH}${fixtures.raw.cid}`) && !response.ok(),
      { timeout: DEFAULT_LIMITS.blockTimeoutMs + 15_000 }) : undefined
      await page.goto(`${network.baseURL}${query}&trustless=${!expectedPolicy.trustless}`)
      if (expectedPolicy.trustless) {
        const response = await rejected!
        expect(response.fromServiceWorker()).toBe(true)
        expect(response.status()).toBe(502)
        await expect.poll(() => page.evaluate(() => Reflect.get(window, 'swGalleryTerminalErrors'))).toContain('INTEGRITY')
        await expect(page.getByRole('alert')).toBeVisible()
        expect(await ui.reader(page).getByRole('img').count()).toBe(0)
        await evidence.finish()
        expect(evidence.cids).toEqual([])
      } else {
        await expectReaderImage(page, network.alternate)
        await openReaderTools(page)
        await expectDownloadBytes(page, ui.readerTools(page), network.alternate, downloadName(false))
        await evidence.finish()
        expect(evidence.cids).toContain(fixtures.raw.cid)
      }
      expect([...network.slow.requests, ...network.fast.requests].some(request => request.cid === fixtures.raw.cid && request.status === 200)).toBe(true)
      expect(network.bridge.routes.every(request => expectedPolicy.defaultGateways.includes(new URL(request.url).origin))).toBe(true)
    })
  })
}

for (const transport of ['http', 'bitswap'] as const) {
  test.describe(`${transport} provider remains strict`, () => {
    test.use({ directTransport: transport })
    test('wrong-hash provider bytes are rejected before real configured-gateway fallback', async ({ page, galleryFixtures: fixtures, network, expectedPolicy }) => {
      if (transport === 'http') {
        network.fast.setMode({ kind: '429', retryAfter: '1' })
        network.httpProvider.setBlockMode(fixtures.raw.cid, { kind: 'response', status: 200, body: network.alternate,
          headers: { 'content-type': 'application/vnd.ipld.raw' } })
      } else network.provider!.setBlockMode(fixtures.raw.cid, { kind: 'corrupt' })
      const evidence = await observeSwGalleryBlocks(page, fixtures.blocks, expectedPolicy)
      const gateways = transport === 'bitswap' ? [SW_GALLERY_HTTP_PROVIDER, FIXTURE_GATEWAYS.fast] : [FIXTURE_GATEWAYS.fast]
      await page.goto(sourceUrl('unixfs', fixtures.raw.ref, {}, gateways))
      if (transport === 'http') {
        await expect.poll(() => network.httpProvider.events.some(event => event.cid === fixtures.raw.cid &&
          event.status === 200 && event.sentBytes === network.alternate.byteLength)).toBe(true)
        network.fast.setMode({ kind: 'correct' })
      }
      if (transport === 'bitswap') {
        // Inject corruption into the first retrieval only: non-strict gateway
        // results are not cached, so subsequent media reads rediscover providers.
        await network.provider!.waitForRecord(record => record.type === 'sent' && record.blocks.some(block => {
          const corrupted = fixtures.raw.bytes.slice()
          corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff
          return Buffer.from(block.data).equals(corrupted)
        }))
        network.router.setMode({ kind: 'empty' })
      }
      await expectReaderImage(page, fixtures.raw.bytes)
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes, downloadName(expectedPolicy.trustless))
      await evidence.finish()
      expect(evidence.cids).toContain(fixtures.raw.cid)
      if (transport === 'http') expect(network.httpProvider.events.some(event => event.cid === fixtures.raw.cid && event.status === 200 && event.sentBytes === network.alternate.byteLength)).toBe(true)
      else {
        const corrupted = fixtures.raw.bytes.slice()
        corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff
        expect(network.provider!.records.some(record => record.type === 'want' && record.cid === fixtures.raw.cid)).toBe(true)
        expect(network.provider!.records.some(record => record.type === 'sent' && record.blocks.some(block => Buffer.from(block.data).equals(corrupted)))).toBe(true)
        expect(network.provider!.instrumentationErrors).toEqual([])
      }
      expect(network.fast.requests.some(request => request.cid === fixtures.raw.cid && request.status === 200)).toBe(true)
    })
  })
}

test.describe('provider and configured gateway share an authority', () => {
  test.use({ directTransport: 'http', httpProviderAsGateway: true })
  test('hostname equality cannot exempt the actual provider branch', async ({ page, galleryFixtures: fixtures, network, expectedPolicy }) => {
    network.fast.setMode({ kind: '429', retryAfter: '1' })
    network.httpProvider.setBlockMode(fixtures.raw.cid, { kind: 'response', status: 200, body: network.alternate, headers: { 'content-type': 'application/vnd.ipld.raw' } })
    const evidence = await observeSwGalleryBlocks(page, fixtures.blocks, expectedPolicy)
    await page.goto(sourceUrl('unixfs', fixtures.raw.ref, {}, [SW_GALLERY_HTTP_PROVIDER]))
    await expect.poll(() => network.httpProvider.events.some(event => event.cid === fixtures.raw.cid &&
      event.status === 200 && event.sentBytes === network.alternate.byteLength)).toBe(true)
    network.fast.setMode({ kind: 'correct' })
    await expectReaderImage(page, fixtures.raw.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes, downloadName(expectedPolicy.trustless))
    await evidence.finish()
    expect(evidence.cids).toContain(fixtures.raw.cid)
    expect(network.httpProvider.events.some(event => event.cid === fixtures.raw.cid && event.status === 200 && event.sentBytes === network.alternate.byteLength)).toBe(true)
    expect(network.bridge.routes.some(request => new URL(request.url).origin === SW_GALLERY_HTTP_PROVIDER
      && request.headers.accept === 'application/vnd.ipld.raw')).toBe(true)
    expect(network.fast.requests.some(request => request.cid === fixtures.raw.cid && request.status === 200)).toBe(true)
  })
})

for (const realm of ['service-worker', 'dedicated-worker'] as const) {
  test.describe(`mixed ${realm} compilation`, () => {
    test.use(realm === 'service-worker'
      ? { serviceWorkerBuildDir: async ({ oppositeBuildDir }, use) => { await use(oppositeBuildDir) } }
      : { dedicatedWorkerBuildDir: async ({ oppositeBuildDir }, use) => { await use(oppositeBuildDir) } })
    test('the actual opposite-mode realm fails closed before content retrieval', async ({ page, galleryFixtures: fixtures, network, oppositeBuildDir }) => {
      await page.addInitScript(recordWorkerTerminalErrors)
      await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
      await expect(page.getByRole('alert')).toBeVisible()
      expect(await page.evaluate(() => Reflect.get(window, 'swGalleryTerminalErrors'))).toContain('INVALID_INPUT')
      expect(network.realmResponses.some(response => response.realm === realm && response.buildDir === resolve(oppositeBuildDir!) && response.bytes > 0)).toBe(true)
      expect(network.router.events).toEqual([])
      expect(network.bridge.routes).toEqual([])
      expect(network.httpProvider.events).toEqual([])
      expect(await ui.reader(page).getByRole('img').count()).toBe(0)
    })
  })
}

test('real private RPC rejects caller mode, pre-admission reads, second reads and ticket replay', async ({ page, galleryFixtures: fixtures, network, expectedPolicy }) => {
  await page.goto('/')
  const admitted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`${SW_GALLERY_BLOCK_PATH}${fixtures.raw.cid}`) && response.status() === 204)
  let reads = 0
  const result = await exerciseSwPrivateSession(page, fixtures.raw.cid, [FIXTURE_GATEWAYS.fast], expectedPolicy, stage => {
    if (stage === 'before-fetch') {
      expect(network.router.events).toEqual([])
      expect(network.bridge.routes).toEqual([])
      expect(network.httpProvider.events).toEqual([])
    } else if (stage === 'after-read') {
      reads = network.fast.requests.length
      expect(reads).toBeGreaterThan(0)
    } else expect(network.fast.requests).toHaveLength(reads)
  })
  expect((await admitted).fromServiceWorker()).toBe(true)
  expect(result.identity.policy).toEqual(expectedPolicy)
  for (const reply of [result.modeOpen, result.mismatchOpen, result.beforeFetch, result.extraMode, result.twice]) {
    expect(reply.ok).toBe(false)
    expect(reply.value).toBeUndefined()
    expect(reply.error?.code).toBe('INVALID_INPUT')
  }
  expect(result.status).toBe(204)
  expect(result.emptyHttp).toBe(true)
  expect(result.delivery.cid).toBe(fixtures.raw.cid)
  expect(result.delivery.keys).toEqual(['sessionId', 'bindingId', 'epoch', 'blockRequestId', 'cid', 'byteLength', 'bytes', 'policy'].sort())
  expect(result.delivery.byteLength).toBe(fixtures.raw.bytes.byteLength)
  expect(result.delivery.policy).toEqual(expectedPolicy)
  expect(Buffer.from(result.delivery.bytes)).toEqual(Buffer.from(fixtures.raw.bytes))
  expect(result.replayStatus).toBeGreaterThanOrEqual(400)
  expect(result.consumed.ok).toBe(true)
  expect(result.closeErrors).toEqual([])
  expect(network.fast.requests.some(request => request.cid === fixtures.raw.cid && request.status === 200)).toBe(true)
})
