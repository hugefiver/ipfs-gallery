import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { FIXTURE_GATEWAYS, sourceUrl } from './gateway-route'
import { enterAlbum, expectDownloadBytes, expectImageBytes, expectReaderImage, openPanel, openReaderTools, selectAlbumItem, submitSource, ui } from './gallery-ui'
import { SW_GALLERY_BLOCK_PATH as BLOCK_PATH, SW_GALLERY_HEADERS as HEADERS } from '../support/sw-gallery-policy'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { observeSwGalleryBlocks } from '../support/sw-gallery-evidence'
import { createPng } from '../fixtures/media'
import { decode as decodeDagPb } from '@ipld/dag-pb'

for (const prefix of ['/', '/gallery/'] as const) {
  test.describe(`real SW Bitswap at ${prefix}`, () => {
    test.use({ directTransport: 'bitswap', appPrefix: prefix })

    test('router → WSS Bitswap renders and downloads multiblock UnixFS with every gateway blocked', async ({ page, galleryFixtures: fixtures, network }) => {
      network.slow.setMode({ kind: '404' })
      network.fast.setMode({ kind: '404' })
      const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
      const search = new URL(sourceUrl('unixfs', fixtures.directories.json.ref), network.baseURL).search
      await page.goto(`${network.baseURL}${search}`)
      await expectReaderImage(page, fixtures.raw.bytes)
      expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${network.baseURL}ipfs-service-worker.js`)
      await enterAlbum(page)
      await selectAlbumItem(page, fixtures.expected.imageTitles[2]!)
      await expectReaderImage(page, fixtures.multiblock.bytes)
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), fixtures.multiblock.bytes)
      await evidence.finish()
      expect(evidence.cids).toContain(fixtures.directories.json.ref.cid)
      expect(evidence.cids).toContain(fixtures.multiblock.cid)
      const children = decodeDagPb(fixtures.blocks.get(fixtures.multiblock.cid)!.bytes).Links.map(link => link.Hash.toV1().toString())
      expect(evidence.cids.some(cid => children.includes(cid))).toBe(true)
      expect(network.router.events.some(event => event.status === 200 && event.cid === fixtures.directories.json.ref.cid)).toBe(true)
      expect(network.provider!.records.some(record => record.type === 'want' && record.cid === fixtures.multiblock.cid)).toBe(true)
      expect(network.provider!.records.some(record => record.type === 'sent' && record.payloadBytes > 0)).toBe(true)
      expect(network.provider!.instrumentationErrors).toEqual([])
      expect(network.httpProvider.events).toEqual([])
      expect([...network.slow.requests, ...network.fast.requests].every(request => request.status === 404 || request.aborted)).toBe(true)

    })
  })
}

test.describe('real SW peer isolation', () => {
  test.use({ directTransport: 'bitswap' })

  test('an active peer asks for verified A without receiving content while paused B still completes', async ({ page, galleryFixtures: fixtures, network }) => {
    const provider = network.provider!
    const a = fixtures.raw
    const b = fixtures.dagPb
    const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
    const bindings = new Set<string | undefined>()
    page.on('request', request => {
      if (new URL(request.url()).pathname.includes(`/${BLOCK_PATH}`)) bindings.add(request.headers()[HEADERS.bindingId.toLowerCase()])
    })
    network.slow.setMode({ kind: '404' })
    network.fast.setMode({ kind: '404' })
    provider.setBlockMode(b.cid, { kind: 'pause' })
    await page.goto(sourceUrl('meta', fixtures.manifests.standalone.ref))
    await expectReaderImage(page, a.bytes)
    await evidence.finish()
    expect(evidence.cids).toContain(a.cid)
    expect(provider.records.some(record => record.type === 'want' && record.cid === a.cid)).toBe(true)
    expect(provider.records.some(record => record.type === 'sent' && record.blocks.some(block => Buffer.from(block.data).equals(a.bytes)))).toBe(true)
    expect(bindings.size).toBe(1)
    const binding = [...bindings][0]
    expect(binding).toBeTruthy()
    const aWants = provider.records.filter(record => record.type === 'want' && record.cid === a.cid).length
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), a.bytes)
    expect(provider.records.filter(record => record.type === 'want' && record.cid === a.cid)).toHaveLength(aWants)
    await ui.next(page).click()
    await page.keyboard.press('Escape')
    await provider.waitForRecord(record => record.type === 'want' && record.cid === b.cid)
    await provider.waitForRecord(record => record.type === 'store:read' && record.cid === b.cid && record.mode === 'pause')
    expect([...bindings]).toEqual([binding])
    const connection = provider.records.findLast(record => record.type === 'connection:open')
    if (connection?.type !== 'connection:open') throw new Error('Missing active provider connection')
    const peer = connection.peerId
    const activeConnections = () => provider.records.reduce((count, record) =>
      'peerId' in record && record.peerId === peer ? count + (record.type === 'connection:open' ? 1 : record.type === 'connection:close' ? -1 : 0) : count, 0)
    expect(activeConnections()).toBe(1)
    const probeStart = provider.records.length
    const { peerIdFromString } = await import('@libp2p/peer-id')
    const reverse = provider.requestBlockFromPeer(CID.parse(a.cid), peerIdFromString(peer), AbortSignal.timeout(2000))
      .then(bytes => ({ bytes, error: undefined }), (error: unknown) => ({ bytes: undefined, error }))
    await provider.waitForRecord(record => provider.records.indexOf(record) >= probeStart && record.type === 'sent'
      && record.wants.some(want => want.cid === a.cid && !want.cancel))
    expect(activeConnections()).toBe(1)
    const result = await reverse
    expect(result.bytes).toBeUndefined()
    expect(result.error).toBeDefined()
    expect(provider.records.slice(probeStart).filter(record => record.type === 'received' && record.payloadBytes > 0)).toEqual([])
    expect(activeConnections()).toBe(1)
    expect(provider.records.slice(probeStart).filter(record => record.type === 'connection:open')).toEqual([])
    provider.setBlockMode(b.cid, undefined)
    provider.release(b.cid)
    await expectReaderImage(page, b.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), b.bytes)
    await evidence.finish()
    expect(evidence.cids).toContain(b.cid)
    expect([...bindings]).toEqual([binding])
    expect(provider.records.some(record => record.type === 'sent' && record.blocks.some(block => Buffer.from(block.data).equals(fixtures.blocks.get(b.cid)!.bytes)))).toBe(true)
    expect(provider.records.slice(probeStart).filter(record => record.type === 'received' && record.payloadBytes > 0)).toEqual([])
    expect(provider.instrumentationErrors).toEqual([])
    expect([...network.slow.requests, ...network.fast.requests].every(request => request.status === 404 || request.aborted)).toBe(true)
  })

  test('unsafe provider addresses are rejected without dialing and verified fallback still succeeds', async ({ page, galleryFixtures: fixtures, network }) => {
    const id = network.provider!.peerId.toString()
    network.router.setProviders(fixtures.raw.cid, [{ Schema: 'peer', ID: id, Protocols: ['transport-bitswap'], Addrs: [
      `/ip4/127.0.0.1/tcp/443/wss/p2p/${id}`, `/dns4/localhost/tcp/443/wss/p2p/${id}`,
      `/dns4/provider.test/tcp/443/wss/p2p/${id}`, `/dns4/provider.invalid/tcp/443/wss/p2p/${id}`,
    ] }])
    await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
    await expectReaderImage(page, fixtures.raw.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes)
    expect(network.provider!.records.filter(record => record.type === 'connection:open' || record.type === 'want')).toEqual([])
    expect(network.httpProvider.events).toEqual([])
    expect(network.bridge.routes.length).toBeGreaterThan(0)
    expect(network.unexpectedRequests).toEqual([])
  })
})

for (const [transport, boundaryBlock] of [['bitswap', '2MiB'], ['http', '4MiB']] as const) {
  test.describe(`${transport} legal single-block boundary`, () => {
    test.use({ directTransport: transport, boundaryBlock })
    test('the actual SW block, rendered image and downloaded original retain every byte', async ({ page, network }) => {
      const fixture = network.boundary!
      const evidence = await observeSwGalleryBlocks(page, new Map([[fixture.cid, { cid: CID.parse(fixture.cid), bytes: fixture.bytes }]]))
      network.slow.setMode({ kind: '404' })
      network.fast.setMode({ kind: '404' })
      const delivered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${BLOCK_PATH}${fixture.cid}`) && response.ok())
      await page.goto(sourceUrl('unixfs', fixture.ref))
      await expectReaderImage(page, fixture.bytes)
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), fixture.bytes)
      const response = await delivered
      expect(response.fromServiceWorker()).toBe(true)
      expect(response.status()).toBe(204)
      await evidence.finish()
      expect(evidence.cids).toContain(fixture.cid)
      if (transport === 'bitswap') {
        expect(network.provider!.records.some(record => record.type === 'sent' && record.blocks.some(block => Buffer.from(block.data).equals(fixture.bytes)))).toBe(true)
        expect(network.provider!.instrumentationErrors).toEqual([])
      } else {
        expect(network.httpProvider.events.some(event => event.cid === fixture.cid && event.sentBytes === fixture.bytes.byteLength && event.status === 200)).toBe(true)
      }
      expect([...network.slow.requests, ...network.fast.requests].every(request => request.status === 404 || request.aborted)).toBe(true)
    })
  })
}

test.describe('direct HTTPS provider', () => {
  test.use({ directTransport: 'http' })

  test('verified provider HTTP bytes succeed while configured gateways are unavailable', async ({ page, galleryFixtures: fixtures, network }) => {
    const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
    network.slow.setMode({ kind: '404' })
    network.fast.setMode({ kind: '404' })
    await page.goto(sourceUrl('unixfs', fixtures.multiblock.ref))
    await expectReaderImage(page, fixtures.multiblock.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), fixtures.multiblock.bytes)
    await evidence.finish()
    expect(evidence.cids).toContain(fixtures.multiblock.cid)
    const children = decodeDagPb(fixtures.blocks.get(fixtures.multiblock.cid)!.bytes).Links.map(link => link.Hash.toV1().toString())
    expect(evidence.cids.some(cid => children.includes(cid))).toBe(true)
    expect(network.httpProvider.events.filter(event => event.status === 200).length).toBeGreaterThan(1)
    expect([...network.slow.requests, ...network.fast.requests].every(request => request.status === 404 || request.aborted)).toBe(true)
  })

  test('a wrong-hash provider cannot reach the exporter and falls back to verified gateways', async ({ page, galleryFixtures: fixtures, network }) => {
    network.httpProvider.setMode({ kind: 'corrupt' })
    network.slow.setMode({ kind: 'delay', milliseconds: 100, then: { kind: '404' } })
    network.fast.setMode({ kind: 'delay', milliseconds: 4000 })
    const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
    await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
    await expectReaderImage(page, fixtures.raw.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes)
    await evidence.finish()
    expect(evidence.cids).toContain(fixtures.raw.cid)
    const direct = network.httpProvider.events.find(event => event.cid === fixtures.raw.cid && event.status === 200)
    expect(direct?.completedAt).toBeDefined()
    const fallback = [...network.slow.requests, ...network.fast.requests].filter(record => record.cid === fixtures.raw.cid)
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback.some(record => record.status === 200 && record.completedAt! >= direct!.completedAt!)).toBe(true)
  })

  for (const failure of ['redirect', 'oversize-length'] as const) {
    test(`${failure} provider response is rejected before verified gateway fallback`, async ({ page, galleryFixtures: fixtures, network }) => {
      network.slow.setMode({ kind: 'delay', milliseconds: 100, then: { kind: '404' } })
      network.fast.setMode({ kind: 'delay', milliseconds: 4000 })
      network.httpProvider.setMode(failure === 'redirect'
        ? { kind: 'redirect', location: `https://unconfigured.gallery-fixture.net/ipfs/${fixtures.raw.cid}?format=raw` }
        : { kind: 'response', status: 200, body: Uint8Array.of(0), headers: { 'content-type': 'application/vnd.ipld.raw', 'content-length': String(DEFAULT_LIMITS.maxBlockBytes + 1) } })
      const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
      await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
      await expectReaderImage(page, fixtures.raw.bytes)
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes)
      await evidence.finish()
      expect(evidence.cids).toContain(fixtures.raw.cid)
      expect(network.httpProvider.events.some(event => event.cid === fixtures.raw.cid)).toBe(true)
      expect(network.bridge.routes.some(request => new URL(request.url).pathname.endsWith(`/${fixtures.raw.cid}`))).toBe(true)
      expect(network.proxy.events.some(event => event.target === 'unconfigured.gallery-fixture.net:443')).toBe(false)
    })
  }
})

test('malformed delegated provider metadata cannot prevent verified explicit fallback', async ({ page, galleryFixtures: fixtures, network }) => {
  network.router.setMode({ kind: 'malformed' })
  await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
  await expectReaderImage(page, fixtures.raw.bytes)
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes)
  expect(network.router.events.some(event => event.status === 200)).toBe(true)
  expect(network.bridge.routes.some(request => new URL(request.url).pathname.endsWith(`/${fixtures.raw.cid}`))).toBe(true)
  expect(network.httpProvider.events).toEqual([])
})

test('empty router uses explicit fallback and HTTP-date Retry-After cools down the failing gateway', async ({ page, galleryFixtures: fixtures, network }) => {
  network.slow.setMode({ kind: '429', retryAfter: new Date(Date.now() + 60_000).toUTCString() })
  await page.goto(sourceUrl('unixfs', fixtures.directories.json.ref))
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(network.slow.requests.some(record => record.status === 429)).toBe(true)
  const attempts = network.slow.requests.length
  await enterAlbum(page)
  await expectImageBytes(ui.tileImage(page, fixtures.expected.imageTitles[2]!), fixtures.multiblock.bytes)
  expect(network.slow.requests).toHaveLength(attempts)
  expect(network.fast.requests.some(record => record.status === 200 && record.cid === fixtures.multiblock.cid)).toBe(true)
  expect(network.router.events.some(event => event.status === 200)).toBe(true)
})

test('ordinary empty entry and identity CID make no content-network request', async ({ page, network }) => {
  await page.goto('/')
  await expect(page.locator('#root')).not.toBeEmpty()
  await openPanel(page, 'network')
  await expect(ui.settingsDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(registrations => registrations.length))).toBe(0)
  expect(network.appRequests.some(url => url.includes('ipfs-service-worker'))).toBe(false)
  expect(network.router.events).toEqual([])
  expect(network.httpProvider.events).toEqual([])
  expect(network.bridge.routes).toEqual([])
  const bytes = createPng(1, 1, 7)
  const cid = CID.createV1(0x55, identity.digest(bytes)).toString()
  await submitSource(page, cid)
  await expectReaderImage(page, bytes)
  await openReaderTools(page)
  await expectDownloadBytes(page, ui.readerTools(page), bytes)
  expect(network.router.events).toEqual([])
  expect(network.httpProvider.events).toEqual([])
  expect(network.bridge.routes).toEqual([])
})

test('same CID in different tabs keeps configurations and cancellation isolated', async ({ page, context, galleryFixtures: fixtures, network }) => {
  network.slow.setMode({ kind: 'delay', milliseconds: 15_000 })
  network.fast.setMode({ kind: 'delay', milliseconds: 700 })
  const other = await context.newPage()
  try {
    await page.goto(sourceUrl('unixfs', fixtures.raw.ref, {}, [FIXTURE_GATEWAYS.slow]))
    await network.slow.waitForRequest(record => record.cid === fixtures.raw.cid)
    await other.goto(sourceUrl('unixfs', fixtures.raw.ref, {}, [FIXTURE_GATEWAYS.fast]))
    await network.fast.waitForRequest(record => record.cid === fixtures.raw.cid)
    await page.close()
    await expectReaderImage(other, fixtures.raw.bytes)
    await openReaderTools(other)
    await expectDownloadBytes(other, ui.readerTools(other), fixtures.raw.bytes)
    await expect.poll(() => network.slow.counts.active).toBe(0)
    expect(network.slow.requests.some(record => record.aborted)).toBe(true)
    expect(network.fast.requests.some(record => record.status === 200 && !record.aborted)).toBe(true)
  } finally { await other.close() }
})

test('missing, cross-tab and replayed tickets fail closed without content traffic', async ({ page, context, galleryFixtures: fixtures, network }) => {
  const evidence = await observeSwGalleryBlocks(page, fixtures.blocks)
  await page.addInitScript(blockPath => {
    const fetch = window.fetch.bind(window)
    let captured = false
    window.fetch = (input, init) => {
      const request = new Request(input, init)
      if (!captured && new URL(request.url).pathname.includes(`/${blockPath}`)) {
        captured = true
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        Reflect.set(window, '__swHeldFetch', { url: request.url, headers: Object.fromEntries(request.headers), release })
        return held.then(() => fetch(input, init))
      }
      return fetch(input, init)
    }
  }, BLOCK_PATH)
  const other = await context.newPage()
  try {
    await other.goto('/')
    await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
    await page.waitForFunction(() => Reflect.has(window, '__swHeldFetch'))
    await other.waitForFunction(() => navigator.serviceWorker.controller)
    const ticket = await page.evaluate(() => {
      const { url, headers } = Reflect.get(window, '__swHeldFetch') as { url: string; headers: Record<string, string> }
      return { url, headers }
    })
    const before = network.bridge.routes.length
    const request = async (target: Page, headers: Record<string, string>) => {
      const response = target.waitForResponse(value => value.url() === ticket.url)
      const result = await target.evaluate(async ({ url, headers }) => {
        const response = await fetch(url, { headers, credentials: 'omit', mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
        return { status: response.status, type: response.headers.get('content-type') }
      }, { ...ticket, headers })
      expect((await response).fromServiceWorker()).toBe(true)
      expect(result.type).toContain('application/json')
      return result
    }
    expect((await request(page, {})).status).toBeGreaterThanOrEqual(400)
    expect((await request(other, ticket.headers)).status).toBeGreaterThanOrEqual(400)
    expect(network.bridge.routes).toHaveLength(before)
    expect(network.router.events.every(event => event.cid === fixtures.raw.cid)).toBe(true)
    const genuine = page.waitForResponse(value => value.url() === ticket.url)
    await page.evaluate(() => Reflect.get(window, '__swHeldFetch').release())
    const accepted = await genuine
    expect(accepted.status()).toBe(204)
    expect(accepted.fromServiceWorker()).toBe(true)
    const acceptedHeaders = await accepted.request().allHeaders()
    for (const [name, value] of Object.entries(ticket.headers)) expect(acceptedHeaders[name]).toBe(value)
    await expectReaderImage(page, fixtures.raw.bytes)
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), fixtures.raw.bytes)
    await evidence.finish()
    expect(evidence.cids).toContain(fixtures.raw.cid)
    const after = network.bridge.routes.length
    expect((await request(page, ticket.headers)).status).toBeGreaterThanOrEqual(400)
    expect(network.bridge.routes).toHaveLength(after)
  } finally { await other.close() }
})

for (const clean of [true, false]) test(clean
  ? 'rebinds after a real SW stop only when the old binding already acknowledged clean retirement'
  : 'refuses a new SW boot when old active binding debt has no clean evidence', async ({ page, context, galleryFixtures: fixtures, network }) => {
  await page.addInitScript(() => {
    const post = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: [message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions]) {
      const [message] = args
      if (message && typeof message === 'object') {
        const value = message as { type?: unknown; bindingId?: unknown; epoch?: unknown; sequence?: unknown }
        if (value.type === 'close' && typeof value.bindingId === 'string' && typeof value.epoch === 'string') {
          const listener = (event: MessageEvent) => {
            if (event.data?.v !== 2 || event.data.sequence !== value.sequence || event.data.ok !== true || event.data.value !== null) return
            this.removeEventListener('message', listener)
            Reflect.set(window, '__swCleanBinding', { bindingId: value.bindingId, epoch: value.epoch })
          }
          this.addEventListener('message', listener)
        }
      }
      return Reflect.apply(post, this, args)
    }
  })
  const entry = new URL(sourceUrl('unixfs', fixtures.raw.ref), network.baseURL)
  entry.searchParams.delete('unixfs')
  await page.goto(entry.href)
  await submitSource(page, fixtures.raw.cid)
  await expectReaderImage(page, fixtures.raw.bytes)
  if (clean) {
    await page.goBack()
    await page.waitForFunction(() => Reflect.has(window, '__swCleanBinding'))
  } else expect(await page.evaluate(() => Reflect.has(window, '__swCleanBinding'))).toBe(false)
  const documentStart = await page.evaluate(() => performance.timeOrigin)
  await page.evaluate(() => Reflect.set(window, '__swRestartController', navigator.serviceWorker.controller))
  const cdp = await context.newCDPSession(page)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const active = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Active SW version was not observed')), 10_000)
      cdp.on('ServiceWorker.workerVersionUpdated', event => {
        const version = event.versions.find((value: { status: string; runningStatus: string; scriptURL: string }) => value.status === 'activated' && value.runningStatus === 'running' && value.scriptURL.endsWith('/ipfs-service-worker.js'))
        if (version) { clearTimeout(timer); resolve(version.versionId) }
      })
    })
    void active.catch(() => {})
    await cdp.send('ServiceWorker.enable')
    const versionId = await active
    const stopped = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SW did not actually stop')), 10_000)
      cdp.on('ServiceWorker.workerVersionUpdated', event => {
        if (event.versions.some((value: { versionId: string; runningStatus: string }) => value.versionId === versionId && value.runningStatus === 'stopped')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    void stopped.catch(() => {})
    await cdp.send('ServiceWorker.stopWorker', { versionId })
    await stopped
    expect(await page.evaluate(() => navigator.serviceWorker.controller === Reflect.get(window, '__swRestartController'))).toBe(true)
    const contentBefore = network.bridge.routes.length
    await submitSource(page, fixtures.multiblock.cid)
    if (clean) {
      await expectReaderImage(page, fixtures.multiblock.bytes)
      await openReaderTools(page)
      await expectDownloadBytes(page, ui.readerTools(page), fixtures.multiblock.bytes)
    } else {
      await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 20_000 })
      expect(network.bridge.routes).toHaveLength(contentBefore)
      expect(await page.evaluate(() => Reflect.has(window, '__swCleanBinding'))).toBe(false)
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart)
    expect(await page.evaluate(() => navigator.serviceWorker.controller === Reflect.get(window, '__swRestartController'))).toBe(true)
  } finally { clearTimeout(timer); await cdp.detach() }
})
