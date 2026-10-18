import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectTcp, createServer as createTcpServer, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { beforeAll, describe, expect, it } from 'vitest'
import { createGalleryFixtures, type GalleryFixtures } from '../fixtures/unixfs'
import { startSwAllowlistProxy } from './sw-allowlist-proxy'
import { startSwHttpsRawGateway, startSwHttpsRouter } from './sw-https-fixtures'
import { listenOnLoopback, mapSwFixtureEndpoint, SwOwnedResources, type SwFixtureEndpoint } from './sw-owned'
import { chromiumSpkiTrustArgs } from './sw-tls'
import { SW_TEST_TLS } from './sw-test-tls'

interface ResponseResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

let fixtures: GalleryFixtures

beforeAll(async () => {
  fixtures = await createGalleryFixtures()
})

function directHttpsRequest(
  endpoint: SwFixtureEndpoint,
  path: string,
  options: { method?: string; headers?: IncomingHttpHeaders; signal?: AbortSignal } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: endpoint.target.connectHostname,
      port: endpoint.target.connectPort,
      servername: SW_TEST_TLS.clientOptions.servername,
      ca: SW_TEST_TLS.clientOptions.ca,
      rejectUnauthorized: true,
      method: options.method ?? 'GET',
      path,
      headers: { host: endpoint.authority, ...options.headers },
      signal: options.signal,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function proxyHttpRequest(
  proxy: SwFixtureEndpoint,
  target: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: Buffer } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.target.connectHostname,
      port: proxy.target.connectPort,
      method: options.method ?? 'GET',
      path: target,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.once('error', reject)
    request.end(options.body)
  })
}

function openConnect(proxy: SwFixtureEndpoint, authority: string): Promise<{ socket: Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: proxy.target.connectHostname, port: proxy.target.connectPort })
    let buffered = Buffer.alloc(0)
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('data', onData)
    }
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const boundary = buffered.indexOf('\r\n\r\n')
      if (boundary < 0) return
      cleanup()
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffered.toString('ascii', 0, boundary))?.[1] ?? 0)
      const remainder = buffered.subarray(boundary + 4)
      if (remainder.byteLength) socket.unshift(remainder)
      resolve({ socket, status })
    }
    socket.once('error', onError)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`)
    })
  })
}

async function httpsThroughConnect(
  proxy: SwFixtureEndpoint,
  endpoint: SwFixtureEndpoint,
  path: string,
  accept = 'application/vnd.ipld.raw',
): Promise<ResponseResult> {
  const tunnel = await openConnect(proxy, endpoint.authority)
  expect(tunnel.status).toBe(200)
  const socket = connectTls({
    socket: tunnel.socket,
    servername: SW_TEST_TLS.clientOptions.servername,
    ca: SW_TEST_TLS.clientOptions.ca,
    rejectUnauthorized: true,
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => {
      const response = Buffer.concat(chunks)
      const boundary = response.indexOf('\r\n\r\n')
      if (boundary < 0) {
        reject(new Error('Tunneled HTTPS response has no header boundary'))
        return
      }
      const headerLines = response.toString('latin1', 0, boundary).split('\r\n')
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headerLines.shift() ?? '')?.[1] ?? 0)
      const headers: IncomingHttpHeaders = {}
      for (const line of headerLines) {
        const separator = line.indexOf(':')
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim()
      }
      resolve({ status, headers, body: response.subarray(boundary + 4) })
    })
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${endpoint.authority}\r\nAccept: ${accept}\r\nConnection: close\r\n\r\n`)
  })
}

describe('SW HTTPS router and raw gateway fixtures', () => {
  it('uses explicit TLS trust and serves bounded JSON/NDJSON provider records', async () => {
    const provider = {
      Schema: 'peer',
      ID: '12D3KooWFixtureOnly',
      Addrs: ['/dns4/provider.invalid/tcp/443/wss'],
      Protocols: ['transport-bitswap'],
    }
    const router = await startSwHttpsRouter({
      tls: SW_TEST_TLS,
      providers: new Map([[fixtures.raw.cid, [provider]]]),
    })
    try {
      expect(chromiumSpkiTrustArgs(SW_TEST_TLS)).toEqual([
        `--ignore-certificate-errors-spki-list=${SW_TEST_TLS.spkiSha256}`,
      ])
      const path = `/routing/v1/providers/${fixtures.raw.cid}`
      const json = await directHttpsRequest(router.endpoint, path, { headers: { accept: 'application/json' } })
      expect(json.status).toBe(200)
      expect(json.headers['content-type']).toBe('application/json')
      expect(JSON.parse(json.body.toString())).toEqual({ Providers: [provider] })
      const ndjson = await directHttpsRequest(router.endpoint, `${path}?filter-protocols=transport-bitswap`, {
        headers: { accept: 'application/x-ndjson' },
      })
      expect(ndjson.status).toBe(200)
      expect(ndjson.body.toString()).toBe(`${JSON.stringify(provider)}\n`)
      expect(router.events.map((event) => event.cid)).toEqual([fixtures.raw.cid, fixtures.raw.cid])
      expect(router.events.every((event) => event.sentBytes > 0 && !event.aborted)).toBe(true)
    } finally {
      await router.close()
    }
    expect(router.owned.every((record) => record.closedAt !== undefined)).toBe(true)
  })

  it('keeps exact raw bytes, corruption, Retry-After, request security and abort controls observable', async () => {
    const gateway = await startSwHttpsRawGateway({ tls: SW_TEST_TLS, blocks: fixtures.blocks })
    const path = `/ipfs/${fixtures.raw.cid}?format=raw`
    try {
      const correct = await directHttpsRequest(gateway.endpoint, path, {
        headers: { accept: 'application/vnd.ipld.raw' },
      })
      expect(correct.status).toBe(200)
      expect(correct.body).toEqual(Buffer.from(fixtures.raw.bytes))
      gateway.setMode({ kind: 'corrupt' })
      expect((await directHttpsRequest(gateway.endpoint, path, {
        headers: { accept: 'application/vnd.ipld.raw' },
      })).body).not.toEqual(correct.body)
      gateway.setMode({ kind: '429', retryAfter: '2' })
      const retry = await directHttpsRequest(gateway.endpoint, path, {
        headers: { accept: 'application/vnd.ipld.raw' },
      })
      expect(retry.status).toBe(429)
      expect(retry.headers['retry-after']).toBe('2')
      expect((await directHttpsRequest(gateway.endpoint, path, {
        headers: { accept: 'application/vnd.ipld.raw', cookie: 'must-not-leak=1' },
      })).status).toBe(400)

      gateway.setMode({ kind: 'delay', milliseconds: 60_000 })
      const controller = new AbortController()
      const pending = directHttpsRequest(gateway.endpoint, path, {
        headers: { accept: 'application/vnd.ipld.raw' }, signal: controller.signal,
      })
      const event = await gateway.waitForEvent((candidate) => candidate.cid === fixtures.raw.cid && candidate.completedAt === undefined)
      controller.abort()
      await expect(pending).rejects.toThrow()
      await expect.poll(() => event.aborted).toBe(true)
      expect(event.phases.map((phase) => phase.stage)).toContain('delay')
    } finally {
      await gateway.close()
    }
    expect(gateway.owned.every((record) => record.closedAt !== undefined)).toBe(true)
    expect(gateway.events.some((event) => event.cid === fixtures.raw.cid && event.sentBytes === fixtures.raw.bytes.byteLength)).toBe(true)
  })
})

describe('SW endpoint allowlist proxy', () => {
  it('revokes a TCP target as soon as its server closes independently of its owner', async () => {
    const ownership = new SwOwnedResources()
    const server = createTcpServer()
    const target = await listenOnLoopback(server, ownership, 'tcp-target')
    const endpoint = mapSwFixtureEndpoint('wss://provider.gallery-fixture.test', target)
    const proxy = await startSwAllowlistProxy({ allow: [endpoint] })
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      const denied = await openConnect(proxy.endpoint, endpoint.authority)
      denied.socket.destroy()
      expect(denied.status).toBe(403)
      expect(proxy.events[0]?.phases.map(phase => phase.stage)).toContain('deny-inactive-target')
    } finally {
      await proxy.close()
      await ownership.close()
    }
    expect(ownership.activeCount).toBe(0)
  })

  it('allows only listed CONNECT and HTTP endpoints and bounds request bodies', async () => {
    const gateway = await startSwHttpsRawGateway({ tls: SW_TEST_TLS, blocks: fixtures.blocks })
    const provider = { Schema: 'peer', ID: '12D3KooWFixtureOnly', Addrs: [], Protocols: ['transport-bitswap'] }
    const router = await startSwHttpsRouter({
      tls: SW_TEST_TLS,
      providers: new Map([[fixtures.raw.cid, [provider]]]),
    })
    const httpOwnership = new SwOwnedResources()
    let httpRequests = 0
    const httpServer = createHttpServer((request, response) => {
      httpRequests += 1
      response.setHeader('content-type', 'application/octet-stream')
      response.end(request.url === '/fixture' ? 'fixture-http' : 'not-found')
    })
    const httpTarget = await listenOnLoopback(httpServer, httpOwnership, 'sw-http-target-test')
    const httpEndpoint = mapSwFixtureEndpoint('http://fixture-http.gallery-fixture.test', httpTarget)
    const slowEndpoint = mapSwFixtureEndpoint('https://slow.gallery-fixture.net', gateway.endpoint.target)
    const fastEndpoint = mapSwFixtureEndpoint('https://fast.gallery-fixture.net', gateway.endpoint.target)
    const routerEndpoint = mapSwFixtureEndpoint('https://delegated-ipfs.dev', router.endpoint.target)
    const providerEndpoint = mapSwFixtureEndpoint('wss://provider.gallery-fixture.test', gateway.endpoint.target)
    const proxy = await startSwAllowlistProxy({
      allow: [slowEndpoint, fastEndpoint, routerEndpoint, providerEndpoint, httpEndpoint],
      maxRequestBytes: 4,
    })
    try {
      const raw = await httpsThroughConnect(
        proxy.endpoint,
        slowEndpoint,
        `/ipfs/${fixtures.raw.cid}?format=raw`,
      )
      expect(raw.status).toBe(200)
      expect(raw.body).toEqual(Buffer.from(fixtures.raw.bytes))

      const routing = await httpsThroughConnect(
        proxy.endpoint,
        routerEndpoint,
        `/routing/v1/providers/${fixtures.raw.cid}`,
        'application/json',
      )
      expect(routing.status).toBe(200)
      expect(JSON.parse(routing.body.toString())).toEqual({ Providers: [provider] })

      const providerTunnel = await openConnect(proxy.endpoint, providerEndpoint.authority)
      expect(providerTunnel.status).toBe(200)
      const providerTls = connectTls({
        socket: providerTunnel.socket,
        servername: SW_TEST_TLS.clientOptions.servername,
        ca: SW_TEST_TLS.clientOptions.ca,
        rejectUnauthorized: true,
      })
      await new Promise<void>((resolve, reject) => {
        providerTls.once('secureConnect', resolve)
        providerTls.once('error', reject)
      })
      providerTls.destroy()

      const deniedTunnel = await openConnect(proxy.endpoint, 'example.com:443')
      expect(deniedTunnel.status).toBe(403)
      deniedTunnel.socket.destroy()
      const missingPort = await openConnect(proxy.endpoint, slowEndpoint.hostname)
      expect(missingPort.status).toBe(403)
      missingPort.socket.destroy()
      const deniedHttp = await proxyHttpRequest(proxy.endpoint, 'http://example.com/no-network')
      expect(deniedHttp.status).toBe(403)

      const allowedHttp = await proxyHttpRequest(proxy.endpoint, `${httpEndpoint.origin}/fixture`)
      expect(allowedHttp.status).toBe(200)
      expect(allowedHttp.body.toString()).toBe('fixture-http')
      expect(httpRequests).toBe(1)
      const oversized = await proxyHttpRequest(proxy.endpoint, `${httpEndpoint.origin}/fixture`, {
        method: 'POST', headers: { 'content-length': '5' }, body: Buffer.from('12345'),
      })
      expect(oversized.status).toBe(413)
      expect(httpRequests).toBe(1)

      const denied = proxy.events.filter((event) => event.allowed === false)
      expect(denied.map((event) => event.status).sort()).toEqual([403, 403, 403])
      const tunnel = proxy.events.find((event) => event.target === slowEndpoint.authority)
      expect(tunnel?.receivedBytes).toBeGreaterThan(0)
      expect(tunnel?.sentBytes).toBeGreaterThan(0)
      expect(proxy.events.some((event) => event.target === routerEndpoint.authority && event.allowed)).toBe(true)
      expect(proxy.events.some((event) => event.target === providerEndpoint.authority && event.allowed)).toBe(true)
      expect(proxy.owned.filter((record) => record.kind === 'upstream').length).toBe(4)
      expect(proxy.mappings).toHaveLength(5)
      expect(proxy.mappings.every((mapping) => mapping.localTarget.startsWith('127.0.0.1:'))).toBe(true)
    } finally {
      await proxy.close()
      await gateway.close()
      await router.close()
      await httpOwnership.close()
    }
    expect(proxy.owned.every((record) => record.closedAt !== undefined)).toBe(true)
    expect(proxy.mappings.every((mapping) => mapping.closedAt !== undefined)).toBe(true)
    expect(httpOwnership.records.every((record) => record.closedAt !== undefined)).toBe(true)
  })

  it('rejects oversized mapping tables and targets whose owning server is closed', async () => {
    const gateway = await startSwHttpsRawGateway({ tls: SW_TEST_TLS, blocks: fixtures.blocks })
    const endpoint = mapSwFixtureEndpoint('https://closed.gallery-fixture.test', gateway.endpoint.target)
    const mappings = Array.from({ length: 33 }, (_, index) => mapSwFixtureEndpoint(
      `https://fixture-${index}.gallery-fixture.test`,
      gateway.endpoint.target,
    ))
    await expect(startSwAllowlistProxy({ allow: mappings })).rejects.toThrow('mapping limit')
    const proxy = await startSwAllowlistProxy({ allow: [endpoint] })
    await gateway.close()
    const inactive = await openConnect(proxy.endpoint, endpoint.authority)
    expect(inactive.status).toBe(403)
    inactive.socket.destroy()
    expect(proxy.events[0]?.phases.map((phase) => phase.stage)).toContain('deny-inactive-target')
    await proxy.close()
    await expect(startSwAllowlistProxy({ allow: [endpoint] })).rejects.toThrow('active owned server')
  })

  it('aborts an owned open tunnel during idempotent close without touching other processes', async () => {
    const gateway = await startSwHttpsRawGateway({ tls: SW_TEST_TLS, blocks: fixtures.blocks })
    const providerEndpoint = mapSwFixtureEndpoint('wss://provider.gallery-fixture.test', gateway.endpoint.target)
    const proxy = await startSwAllowlistProxy({ allow: [providerEndpoint] })
    const tunnel = await openConnect(proxy.endpoint, providerEndpoint.authority)
    expect(tunnel.status).toBe(200)
    const closed = new Promise<void>((resolve) => tunnel.socket.once('close', () => resolve()))
    await proxy.close()
    await proxy.close()
    await closed
    const event = proxy.events.find((candidate) => candidate.stage === 'proxy-connect' && candidate.allowed)
    expect(event?.aborted).toBe(true)
    expect(proxy.owned.every((record) => record.closedAt !== undefined)).toBe(true)
    await gateway.close()
  })
})
