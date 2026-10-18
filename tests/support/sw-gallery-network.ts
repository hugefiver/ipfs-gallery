import { createServer, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { peerIdFromCID } from '@libp2p/peer-id'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import type { FixtureBlock } from '../fixtures/unixfs'
import { startTrustlessGateway, type TrustlessGateway } from './trustless-gateway'
import type { IpfsProvider } from './ipfs-provider'
import { startSwGalleryBitswapProvider } from './sw-gallery-provider'
import { startSwAllowlistProxy } from './sw-allowlist-proxy'
import { startSwHttpsRawGateway, startSwHttpsRouter } from './sw-https-fixtures'
import { listenOnLoopback, mapSwFixtureEndpoint, SwOwnedResources, type SwFixtureEndpoint } from './sw-owned'
import { SW_TEST_TLS } from './sw-test-tls'
import { chromiumSpkiTrustArgs } from './sw-tls'

export const SW_GALLERY_ORIGIN = 'https://app.gallery-fixture.net'
export const SW_GALLERY_GATEWAYS = {
  slow: 'https://slow.gallery-fixture.net',
  fast: 'https://fast.gallery-fixture.net',
} as const
export const SW_GALLERY_HTTP_PROVIDER = 'https://provider.gallery-fixture.net'
export { SW_GALLERY_WSS_HOST } from './sw-gallery-provider'
export const SW_GALLERY_CSP = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' https: wss:; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
export const SW_GALLERY_TRUST_ARGS = [...chromiumSpkiTrustArgs(SW_TEST_TLS)]
// Chromium uses the last disable-features switch, so retain Playwright's
// disabled features when suppressing browser-owned Autofill/search traffic.
export const SW_GALLERY_BROWSER_ARGS = [
  ...SW_GALLERY_TRUST_ARGS, '--disable-background-networking', '--disable-preconnect', '--disable-quic',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  `--disable-features=${[
    'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider',
    'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
    'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate',
    'AutoDeElevate', 'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled',
    'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
    'AutofillServerCommunication', 'PreconnectToSearch',
  ].join(',')}`,
]

export interface SwGalleryRoute {
  url: string
  method: string
  resourceType: string
  headers: Record<string, string>
}

export interface SwGalleryNetworkOptions {
  prefix?: '/' | '/gallery/'
  buildDir?: string
  additionalGateways?: readonly string[]
  transport?: 'none' | 'bitswap' | 'http'
  serviceWorkerBuildDir?: string
  dedicatedWorkerBuildDir?: string
  httpProviderAsGateway?: boolean
}

/** All browser destinations are exact public authorities mapped to task-owned TLS listeners. */
export async function startSwGalleryNetwork(blocks: ReadonlyMap<string, FixtureBlock>, options: SwGalleryNetworkOptions = {}) {
  const ownership = new SwOwnedResources()
  const cleanups: Array<() => Promise<void>> = []
  const routes: SwGalleryRoute[] = []
  const errors: unknown[] = []
  let providerRelay: Awaited<ReturnType<typeof startSwGalleryBitswapProvider>> | undefined
  const fixtureErrors = () => [...errors, ...providerRelay?.errors ?? []]
  const appRequests: string[] = []
  const realmResponses: { realm: 'service-worker' | 'dedicated-worker'; buildDir: string; bytes: number }[] = []
  const prefix = options.prefix ?? '/'
  const dist = resolve(options.buildDir ?? process.env.GALLERY_BUILD_DIR ?? '.reader-album-build')
  let closing = false
  let closeWork: Promise<void> | undefined
  const close = () => closeWork ??= (async () => {
    closing = true
    const results = await Promise.allSettled([ownership.close(), ...cleanups.reverse().map(cleanup => cleanup())])
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'SW gallery fixture cleanup failed')
  })()

  try {
    const slow = await startTrustlessGateway(blocks, { kind: 'delay', milliseconds: 40 })
    cleanups.push(slow.close)
    const fast = await startTrustlessGateway(blocks)
    cleanups.push(fast.close)

    // This relay observes the actual SW HTTP request and propagates disconnects;
    // it never handles a Playwright Route or manufactures a block response.
    async function gatewayRelay(gateway: TrustlessGateway, origins: readonly string[]): Promise<SwFixtureEndpoint[]> {
      const target = new URL(gateway.origin)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port) throw new Error('Expected a factory-owned local gateway')
      const server = createServer(SW_TEST_TLS.serverOptions, (request, response) => {
        const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]]))
        routes.push({ url: `https://${request.headers.host}${request.url}`, method: request.method ?? '', resourceType: 'fetch', headers })
        const upstream = httpRequest({ hostname: '127.0.0.1', port: Number(target.port), path: request.url, method: request.method, headers: request.headers, agent: false })
        upstream.once('socket', socket => ownership.ownSocket(socket, 'gallery-gateway-relay'))
        response.once('close', () => { if (!response.writableFinished) upstream.destroy() })
        request.once('aborted', () => upstream.destroy())
        upstream.once('response', incoming => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers)
          incoming.once('error', error => { if (!closing && !response.destroyed) errors.push(error); response.destroy() })
          incoming.pipe(response)
        })
        upstream.once('error', error => {
          if (!closing && !response.destroyed) errors.push(error)
          response.destroy()
        })
        request.pipe(upstream)
      })
      const owned = await listenOnLoopback(server, ownership, 'gallery-gateway-relay')
      return origins.map(origin => mapSwFixtureEndpoint(origin, owned))
    }

    const endpoints = [
      ...await gatewayRelay(slow, [SW_GALLERY_GATEWAYS.slow]),
      ...await gatewayRelay(fast, [...new Set([SW_GALLERY_GATEWAYS.fast, ...options.additionalGateways ?? []])]
        .filter(origin => origin !== SW_GALLERY_GATEWAYS.slow && (!options.httpProviderAsGateway || origin !== SW_GALLERY_HTTP_PROVIDER))),
    ]
    const app = createServer(SW_TEST_TLS.serverOptions, (request, response) => {
      appRequests.push(request.url ?? '/')
      void (async () => {
        const pathname = new URL(request.url ?? '/', SW_GALLERY_ORIGIN).pathname
        response.setHeader('Content-Security-Policy', SW_GALLERY_CSP)
        response.setHeader('X-Content-Type-Options', 'nosniff')
        response.setHeader('Cache-Control', 'no-store')
        if (prefix === '/gallery/' && pathname === '/sibling/' && request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Sibling scope fixture</title>')
          return
        }
        if (!pathname.startsWith(prefix) || !['GET', 'HEAD'].includes(request.method ?? '')) {
          response.writeHead(404).end()
          return
        }
        const relative = decodeURIComponent(pathname.slice(prefix.length) || 'index.html')
        let root = dist
        let file = relative
        let realm: 'service-worker' | 'dedicated-worker' | undefined
        if (relative === 'ipfs-service-worker.js' && options.serviceWorkerBuildDir) {
          root = resolve(options.serviceWorkerBuildDir); realm = 'service-worker'
        } else if (/^assets\/gallery\.worker-[^/]+\.js$/.test(relative) && options.dedicatedWorkerBuildDir) {
          root = resolve(options.dedicatedWorkerBuildDir); realm = 'dedicated-worker'
          const entries = (await readdir(resolve(root, 'assets'))).filter(name => /^gallery\.worker-[^/]+\.js$/.test(name))
          if (entries.length !== 1) throw new Error('Mixed-realm fixture requires one emitted Dedicated Worker entry')
          file = `assets/${entries[0]}`
        }
        let path = resolve(root, file)
        if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return }
        let bytes: Buffer
        try { bytes = await readFile(path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.dedicatedWorkerBuildDir || !relative.startsWith('assets/')) throw error
          root = resolve(options.dedicatedWorkerBuildDir)
          path = resolve(root, relative)
          if (!path.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return }
          bytes = await readFile(path)
          realm = 'dedicated-worker'
        }
        if (realm) realmResponses.push({ realm, buildDir: root, bytes: bytes.byteLength })
        const extension = path.split('.').at(-1) ?? ''
        const mime: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml' }
        response.writeHead(200, { 'Content-Type': mime[extension] ?? 'application/octet-stream', 'Content-Length': bytes.byteLength })
          .end(request.method === 'HEAD' ? undefined : bytes)
      })().catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error)
        if (!response.headersSent) response.writeHead(404).end()
        else response.destroy()
      })
    })
    endpoints.push(mapSwFixtureEndpoint(SW_GALLERY_ORIGIN, await listenOnLoopback(app, ownership, 'gallery-app')))

    const router = await startSwHttpsRouter({ tls: SW_TEST_TLS, initialMode: { kind: 'empty' }, maxEvents: 8192 })
    cleanups.push(router.close)
    endpoints.push(mapSwFixtureEndpoint('https://delegated-ipfs.dev', router.endpoint.target))
    const httpProvider = await startSwHttpsRawGateway({ tls: SW_TEST_TLS, blocks, initialMode: { kind: '404' }, maxEvents: 8192 })
    cleanups.push(httpProvider.close)
    if (options.httpProviderAsGateway) {
      if (options.transport !== 'http') throw new Error('Shared provider/gateway fixture requires HTTPS provider transport')
      const gateway = new URL(fast.origin)
      const server = createServer(SW_TEST_TLS.serverOptions, (request, response) => {
        const providerBranch = request.headers.accept?.includes('application/octet-stream') === true
        if (!providerBranch) routes.push({ url: `${SW_GALLERY_HTTP_PROVIDER}${request.url}`, method: request.method ?? '', resourceType: 'fetch',
          headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])) })
        const upstream = providerBranch
          ? httpsRequest({ ...SW_TEST_TLS.clientOptions, hostname: '127.0.0.1', port: httpProvider.endpoint.target.connectPort, path: request.url,
            method: request.method, headers: request.headers, agent: false })
          : httpRequest({ hostname: '127.0.0.1', port: Number(gateway.port), path: request.url, method: request.method, headers: request.headers, agent: false })
        upstream.once('socket', socket => ownership.ownSocket(socket, 'gallery-shared-provider-relay'))
        request.once('aborted', () => upstream.destroy())
        response.once('close', () => { if (!response.writableFinished) upstream.destroy() })
        upstream.once('response', incoming => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers)
          incoming.once('error', error => { if (!closing && !response.destroyed) errors.push(error); response.destroy() })
          incoming.pipe(response)
        })
        upstream.once('error', error => { if (!closing && !response.destroyed) errors.push(error); response.destroy() })
        request.pipe(upstream)
      })
      endpoints.push(mapSwFixtureEndpoint(SW_GALLERY_HTTP_PROVIDER, await listenOnLoopback(server, ownership, 'gallery-shared-provider-relay')))
    } else if (options.transport !== 'bitswap') endpoints.push(mapSwFixtureEndpoint(SW_GALLERY_HTTP_PROVIDER, httpProvider.endpoint.target))

    let provider: IpfsProvider | undefined
    if (options.transport === 'bitswap') {
      providerRelay = await startSwGalleryBitswapProvider(blocks)
      provider = providerRelay.provider
      cleanups.push(providerRelay.close)
      endpoints.push(providerRelay.endpoint)
      for (const cid of blocks.keys()) router.setProviders(cid, [{ Schema: 'peer', ID: provider.peerId.toString(), Addrs: [provider.publicAddress().toString()], Protocols: ['transport-bitswap'] }])
      router.setMode({ kind: 'providers' })
    } else if (options.transport === 'http') {
      // A valid peer identity is required even for the HTTP transport; it is not
      // used to dial Bitswap in this case.
      const id = peerIdFromCID(CID.createV1(0x72, identity.digest(Uint8Array.of(8, 1, 18, 32, ...new Uint8Array(32).fill(1))))).toString()
      for (const cid of blocks.keys()) router.setProviders(cid, [{ Schema: 'peer', ID: id, Addrs: ['/dns4/provider.gallery-fixture.net/tcp/443/https'], Protocols: ['transport-ipfs-gateway-http'] }])
      httpProvider.setMode({ kind: 'correct' })
      router.setMode({ kind: 'providers' })
    }

    const proxy = await startSwAllowlistProxy({ allow: endpoints, maxEvents: 16_384, maxTunnelBytes: 128 * 1024 * 1024 })
    cleanups.push(proxy.close)
    return {
      slow, fast, router, provider, providerRelay, httpProvider, proxy, appRequests, realmResponses,
      get errors() { return fixtureErrors() },
      baseURL: `${SW_GALLERY_ORIGIN}${prefix}`,
      chromiumArgs: [...SW_GALLERY_BROWSER_ARGS, ...proxy.chromiumProxyArgs],
      bridge: { routes, get errors() { return fixtureErrors() }, close },
      get unexpectedRequests() {
        return proxy.events.filter(event => event.allowed === false).map(event => event.url ?? event.target ?? '')
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export type SwGalleryNetwork = Awaited<ReturnType<typeof startSwGalleryNetwork>>
