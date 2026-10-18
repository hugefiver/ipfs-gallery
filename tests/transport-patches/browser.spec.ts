import { test, expect, chromium, type CDPSession, type Page } from '@playwright/test'
import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { buildWorker } from './build-worker.mjs'
import { startSwGalleryBitswapProvider } from '../support/sw-gallery-provider'
import { startSwAllowlistProxy } from '../support/sw-allowlist-proxy'
import { SwOwnedResources, listenOnLoopback, mapSwFixtureEndpoint } from '../support/sw-owned'
import { SW_TEST_TLS } from '../support/sw-test-tls'
import { chromiumSpkiTrustArgs } from '../support/sw-tls'

interface Snapshot {
  activeDials: number; activeFlights: number; liveSockets: number; closedSockets: number
  connections: number; peakDecoderBacking: number; rejectedInputs: number
  decodedDataFrames: number; decodedDataBytes: number; decoderRetainedBytes: number[]
}
type Command = { command: string; id?: string; address?: string; cid?: string; raw?: boolean }
async function rpc<T>(page: Page, command: Command): Promise<T> {
  return page.evaluate(async command => {
    const channel = new MessageChannel()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error(`SW RPC timed out: ${command.command}`)) }, 15000)
      channel.port1.onmessage = event => {
        clearTimeout(timer)
        channel.port1.close()
        if (event.data.error) reject(new Error(event.data.error))
        else resolve(event.data.value)
      }
      navigator.serviceWorker.controller!.postMessage(command, [channel.port2])
    })
  }, command) as Promise<T>
}

interface SocketRecord { requestId: string; url: string; closed: boolean }
async function observeWorkerSockets(cdp: CDPSession) {
  const targets = await cdp.send('Target.getTargets')
  const target = targets.targetInfos.find(value => value.type === 'service_worker' && value.url.endsWith('/transport-test-sw.js'))
  if (!target) throw new Error('Missing real service worker target')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
  const sockets: SocketRecord[] = []
  const requests: string[] = []
  const enabled = Promise.withResolvers<void>()
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return
    const message = JSON.parse(event.message) as { id?: number; error?: unknown; method?: string; params?: { requestId: string; url?: string; request?: { url: string } } }
    if (message.id === 1) {
      if (message.error) enabled.reject(new Error(JSON.stringify(message.error)))
      else enabled.resolve()
    }
    if (message.method === 'Network.webSocketCreated') sockets.push({ requestId: message.params!.requestId, url: message.params!.url!, closed: false })
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params!.request!.url)
    if (message.method === 'Network.webSocketClosed') {
      const socket = sockets.find(value => value.requestId === message.params!.requestId)
      if (socket) socket.closed = true
    }
  })
  await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Network.enable' }) })
  await enabled.promise
  return { sockets, requests }
}

test('real Chromium Service Worker uses bounded patched WSS/Noise/Yamux transport', async () => {
  const run = process.env.TRANSPORT_BROWSER_RUN!
  const buildDir = join(run, 'bundle')
  await buildWorker(buildDir)
  const ownership = new SwOwnedResources()
  const cleanup: Array<() => Promise<unknown>> = []
  const failures: string[] = []
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251)
  const digest = await sha256.digest(bytes)
  const cid = CID.createV1(0x55, digest)
  async function closeFixtures() {
    const results = []
    for (const close of cleanup.reverse()) results.push(...await Promise.allSettled([close()]))
    results.push(...await Promise.allSettled([ownership.close()]))
    const errors = results.filter(result => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors, 'Owned browser fixture cleanup failed')
  }
  try {
    const provider = await startSwGalleryBitswapProvider(new Map([[cid.toString(), { cid, bytes }]]))
    cleanup.push(provider.close)
    const script = await readFile(join(buildDir, 'transport-test-sw.js'))
    const origin = 'https://transport.gallery-fixture.test'
    const server = createServer(SW_TEST_TLS.serverOptions, (request, response) => {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' wss:; object-src 'none'")
      if (request.url === '/transport-test-sw.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(script)
      else if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Transport fixture</title>')
      else response.writeHead(404).end()
    })
    const endpoint = mapSwFixtureEndpoint(origin, await listenOnLoopback(server, ownership, 'transport-browser-app'))
    const proxy = await startSwAllowlistProxy({ allow: [endpoint, provider.endpoint] })
    cleanup.push(proxy.close)
    const context = await chromium.launchPersistentContext(join(run, 'profile'), {
      headless: false,
      args: [...chromiumSpkiTrustArgs(SW_TEST_TLS), ...proxy.chromiumProxyArgs, '--disable-background-networking', '--disable-quic'],
    })
    cleanup.push(() => context.close())
    context.on('weberror', event => { failures.push(event.error().message) })
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(origin)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/transport-test-sw.js', { type: 'module' })
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    })
    const cdp = await context.browser()!.newBrowserCDPSession()
    const { sockets, requests } = await observeWorkerSockets(cdp)
    await rpc(page, { command: 'initialize' })

    await rpc(page, { command: 'dial', id: 'normal-dial', address: provider.provider.publicAddress().toString() })
    expect(await rpc(page, { command: 'result', id: 'normal-dial' })).toEqual({ ok: true })
    await rpc(page, { command: 'read', id: 'normal-block', cid: cid.toString() })
    const received = await page.evaluate(async () => {
      const channel = new MessageChannel()
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        channel.port1.onmessage = event => {
          channel.port1.close()
          if (event.data.error || event.data.value.error) reject(new Error(event.data.error ?? event.data.value.error))
          else resolve(event.data.value.bytes)
        }
        navigator.serviceWorker.controller!.postMessage({ command: 'result', id: 'normal-block' }, [channel.port2])
      })
      const ownedArrayBuffer = Uint8Array.from(bytes).buffer
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedArrayBuffer))
      return { byteLength: bytes.byteLength, digest: Array.from(digest) }
    })
    expect(received).toEqual({ byteLength: bytes.byteLength, digest: Array.from(digest.digest) })
    const normal = await rpc<Snapshot>(page, { command: 'settled', id: 'normal-block' })
    expect(normal.activeFlights).toBe(0)
    expect(normal.decodedDataFrames).toBeGreaterThan(1)
    expect(normal.decodedDataBytes).toBeGreaterThanOrEqual(bytes.byteLength)
    expect(normal.peakDecoderBacking).toBeLessThanOrEqual(1024 * 1024 + 12)
    expect(provider.provider.instrumentationErrors).toEqual([])
    expect(failures).toEqual([])
    await rpc(page, { command: 'stop' })
    await expect.poll(() => sockets.every(socket => socket.closed)).toBe(true)
    expect(requests).toEqual([])
    expect(sockets.every(socket => new URL(socket.url).origin === provider.endpoint.origin)).toBe(true)
    const denied = proxy.events.filter(event => event.allowed === false)
    expect(denied.every(event => event.status === 403 && event.sentBytes === 0)).toBe(true)
    console.log('Chromium SW standard block:', { byteLength: received.byteLength, frames: normal.decodedDataFrames, peakDecoderBacking: normal.peakDecoderBacking, sockets: sockets.length, deniedBrowserBackgroundRequests: denied.length })
  } finally {
    await closeFixtures()
  }
})
