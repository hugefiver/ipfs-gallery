import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as connectTcp, type Socket } from 'node:net'
import {
  isActiveSwOwnedServerTarget,
  listenOnLoopback,
  mapSwFixtureEndpoint,
  SwEventJournal,
  SwOwnedResources,
  type SwFixtureEndpoint,
  type SwNetworkEvent,
  type SwOwnedObjectRecord,
} from './sw-owned'

export interface StartSwAllowlistProxyOptions {
  allow: readonly SwFixtureEndpoint[]
  maxEvents?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxTunnelBytes?: number
}

export interface SwAllowlistProxy {
  endpoint: SwFixtureEndpoint
  proxyUrl: string
  chromiumProxyArgs: readonly string[]
  events: SwNetworkEvent[]
  owned: SwOwnedObjectRecord[]
  mappings: readonly SwProxyMappingRecord[]
  waitForEvent(predicate: (event: SwNetworkEvent) => boolean, timeoutMs?: number): Promise<SwNetworkEvent>
  close(): Promise<void>
}

export interface SwProxyMappingRecord {
  readonly protocol: SwFixtureEndpoint['protocol']
  readonly authority: string
  readonly origin: string
  readonly localTarget: string
  readonly createdAt: number
  closedAt?: number
}

const MAX_PROXY_MAPPINGS = 32

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const FORBIDDEN_FORWARD_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'referer'] as const

class RequestLimitError extends Error {}

function validateLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function endpointKey(endpoint: SwFixtureEndpoint): string {
  return `${endpoint.protocol}//${endpoint.authority}`
}

function validateEndpoint(endpoint: SwFixtureEndpoint): void {
  if (!['http:', 'https:', 'wss:'].includes(endpoint.protocol)) throw new Error('Unsupported allowlist endpoint protocol')
  if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error('Invalid allowlist endpoint port')
  if (endpoint.authority !== `${endpoint.hostname}:${endpoint.port}`) throw new Error('Allowlist endpoint authority is not canonical')
  const defaultPort = endpoint.protocol === 'http:' ? 80 : 443
  const expectedOrigin = `${endpoint.protocol}//${endpoint.hostname}${endpoint.port === defaultPort ? '' : `:${endpoint.port}`}`
  if (endpoint.origin !== expectedOrigin) throw new Error('Allowlist endpoint origin is not canonical')
  if (!isActiveSwOwnedServerTarget(endpoint.target)) throw new Error('Allowlist target is not an active owned server')
  if (endpoint.target.connectHostname !== '127.0.0.1') throw new Error('Allowlist target must be IPv4 loopback')
}

function copyHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const copied: IncomingHttpHeaders = { host }
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || name === 'host' || value === undefined) continue
    copied[name] = value
  }
  return copied
}

function hasForbiddenHeaders(headers: IncomingHttpHeaders): boolean {
  return FORBIDDEN_FORWARD_HEADERS.some((name) => headers[name] !== undefined)
}

function filteredResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => !HOP_BY_HOP_HEADERS.has(name) && value !== undefined))
}

function sendProxyStatus(response: ServerResponse, status: number): void {
  response.statusCode = status
  response.setHeader('connection', 'close')
  response.setHeader('content-length', '0')
  response.end()
}

function writeConnectStatus(socket: Socket, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number, event: SwNetworkEvent): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) throw new RequestLimitError('Invalid Content-Length')
    if (Number(declared) > maxBytes) throw new RequestLimitError('Request body exceeds proxy limit')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    length += bytes.byteLength
    event.receivedBytes = length
    if (length > maxBytes) throw new RequestLimitError('Request body exceeds proxy limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, length)
}

export async function startSwAllowlistProxy(options: StartSwAllowlistProxyOptions): Promise<SwAllowlistProxy> {
  const service = 'sw-network-proxy'
  const ownership = new SwOwnedResources()
  const journal = new SwEventJournal(options.maxEvents)
  const maxRequestBytes = validateLimit('maxRequestBytes', options.maxRequestBytes ?? 64 * 1024)
  const maxResponseBytes = validateLimit('maxResponseBytes', options.maxResponseBytes ?? 8 * 1024 * 1024)
  const maxTunnelBytes = validateLimit('maxTunnelBytes', options.maxTunnelBytes ?? 16 * 1024 * 1024)
  if (options.allow.length > MAX_PROXY_MAPPINGS) throw new Error(`Proxy mapping limit exceeds ${MAX_PROXY_MAPPINGS}`)
  const httpEndpoints = new Map<string, SwFixtureEndpoint>()
  const tunnelEndpoints = new Map<string, SwFixtureEndpoint>()
  const mappings: SwProxyMappingRecord[] = []
  for (const endpoint of options.allow) {
    validateEndpoint(endpoint)
    if (endpoint.protocol === 'http:') {
      const key = endpoint.origin
      if (httpEndpoints.has(key)) throw new Error(`Duplicate proxy endpoint: ${key}`)
      httpEndpoints.set(key, endpoint)
      continue
    }
    if (tunnelEndpoints.has(endpoint.authority)) throw new Error(`Duplicate CONNECT endpoint: ${endpoint.authority}`)
    tunnelEndpoints.set(endpoint.authority, endpoint)
    mappings.push({
      protocol: endpoint.protocol,
      authority: endpoint.authority,
      origin: endpoint.origin,
      localTarget: endpoint.target.localAuthority,
      createdAt: Date.now(),
    })
  }
  for (const endpoint of httpEndpoints.values()) {
    mappings.push({
      protocol: endpoint.protocol,
      authority: endpoint.authority,
      origin: endpoint.origin,
      localTarget: endpoint.target.localAuthority,
      createdAt: Date.now(),
    })
  }
  const closeMappings = () => {
    const closedAt = Date.now()
    for (const mapping of mappings) mapping.closedAt ??= closedAt
    httpEndpoints.clear()
    tunnelEndpoints.clear()
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    let target: URL | undefined
    try {
      target = new URL(request.url ?? '')
    } catch {
      // Origin-form and malformed targets are not proxy destinations.
    }
    let event: SwNetworkEvent
    try {
      event = journal.begin({
        service,
        stage: 'proxy-http',
        method: request.method ?? '',
        url: request.url ?? '',
        target: target?.origin,
        allowed: false,
      })
    } catch {
      sendProxyStatus(response, 503)
      return
    }
    let settled = false
    const settle = (aborted: boolean) => {
      if (settled) return
      settled = true
      journal.complete(event, { aborted })
    }
    request.once('aborted', () => settle(true))
    response.once('finish', () => settle(false))
    response.once('close', () => settle(!response.writableFinished))
    if (!target || target.username || target.password || target.hash || target.protocol !== 'http:') {
      event.status = 403
      journal.phase(event, 'deny-target')
      sendProxyStatus(response, 403)
      return
    }
    const mappedEndpoint = httpEndpoints.get(target.origin)
    const endpoint = mappedEndpoint && isActiveSwOwnedServerTarget(mappedEndpoint.target) ? mappedEndpoint : undefined
    const targetPort = target.port ? Number(target.port) : 80
    if (!endpoint || target.hostname !== endpoint.hostname || targetPort !== endpoint.port) {
      event.status = 403
      journal.phase(event, mappedEndpoint ? 'deny-inactive-target' : 'deny-endpoint')
      sendProxyStatus(response, 403)
      return
    }
    if (hasForbiddenHeaders(request.headers)) {
      event.status = 400
      journal.phase(event, 'deny-credentials')
      sendProxyStatus(response, 400)
      return
    }
    event.allowed = true
    journal.phase(event, 'allow-endpoint', undefined, endpointKey(endpoint))
    let body: Buffer
    try {
      body = await readBoundedBody(request, maxRequestBytes, event)
    } catch (error) {
      event.status = error instanceof RequestLimitError ? 413 : 400
      journal.phase(event, 'request-limit')
      sendProxyStatus(response, event.status)
      return
    }
    if (settled) return
    const upstream = httpRequest({
      host: endpoint.target.connectHostname,
      port: endpoint.target.connectPort,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: copyHeaders(request.headers, endpoint.authority),
      agent: false,
    })
    upstream.once('socket', (socket) => ownership.ownSocket(socket, service, 'upstream'))
    upstream.once('error', () => {
      event.status = 502
      journal.phase(event, 'upstream-error')
      if (!response.headersSent) sendProxyStatus(response, 502)
      else response.destroy()
      settle(true)
    })
    upstream.once('response', (upstreamResponse) => {
      const declared = upstreamResponse.headers['content-length']
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) {
        event.status = 502
        journal.phase(event, 'response-limit')
        upstreamResponse.destroy()
        sendProxyStatus(response, 502)
        return
      }
      event.status = upstreamResponse.statusCode ?? 502
      response.writeHead(event.status, filteredResponseHeaders(upstreamResponse.headers))
      upstreamResponse.on('data', (chunk: Buffer) => {
        event.sentBytes += chunk.byteLength
        if (event.sentBytes <= maxResponseBytes) return
        journal.phase(event, 'response-limit', event.sentBytes)
        upstreamResponse.destroy()
        response.destroy()
        settle(true)
      })
      upstreamResponse.once('error', () => settle(true))
      upstreamResponse.pipe(response)
    })
    upstream.end(body)
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.keepAliveTimeout = 1000
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 100

  server.on('connect', (request, clientDuplex, head) => {
    const client = clientDuplex as Socket
    const authority = request.url ?? ''
    const mappedEndpoint = tunnelEndpoints.get(authority)
    const endpoint = mappedEndpoint && isActiveSwOwnedServerTarget(mappedEndpoint.target) ? mappedEndpoint : undefined
    let event: SwNetworkEvent
    try {
      event = journal.begin({
        service,
        stage: 'proxy-connect',
        method: 'CONNECT',
        url: authority,
        target: authority,
        allowed: endpoint !== undefined,
      })
    } catch {
      writeConnectStatus(client, 503, 'Service Unavailable')
      return
    }
    if (!endpoint || hasForbiddenHeaders(request.headers)) {
      event.status = endpoint ? 400 : 403
      journal.phase(event, endpoint ? 'deny-credentials' : mappedEndpoint ? 'deny-inactive-target' : 'deny-endpoint')
      writeConnectStatus(client, event.status, endpoint ? 'Bad Request' : 'Forbidden')
      journal.complete(event)
      return
    }
    const upstream = connectTcp({ host: endpoint.target.connectHostname, port: endpoint.target.connectPort })
    ownership.ownSocket(upstream, service, 'upstream')
    let settled = false
    let limitExceeded = false
    let clientEnded = false
    let upstreamEnded = false
    const settle = (aborted: boolean) => {
      if (settled) return
      settled = true
      journal.complete(event, { aborted })
    }
    const abortTunnel = (stage: string) => {
      if (limitExceeded) return
      limitExceeded = true
      journal.phase(event, stage)
      upstream.destroy()
      client.destroy()
      settle(true)
    }
    client.once('error', () => settle(true))
    upstream.once('error', () => {
      if (!client.destroyed && event.status === undefined) writeConnectStatus(client, 502, 'Bad Gateway')
      event.status = 502
      journal.phase(event, 'upstream-error')
      settle(true)
    })
    client.once('end', () => { clientEnded = true })
    upstream.once('end', () => { upstreamEnded = true })
    client.once('close', () => settle(limitExceeded || (!clientEnded && !upstreamEnded)))
    upstream.once('connect', () => {
      if (client.destroyed) {
        upstream.destroy()
        settle(true)
        return
      }
      event.status = 200
      journal.phase(event, 'tunnel-open', undefined, endpointKey(endpoint))
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.byteLength) {
        event.receivedBytes += head.byteLength
        upstream.write(head)
      }
      client.on('data', (chunk: Buffer) => {
        event.receivedBytes += chunk.byteLength
        if (event.receivedBytes > maxTunnelBytes) abortTunnel('tunnel-request-limit')
      })
      upstream.on('data', (chunk: Buffer) => {
        event.sentBytes += chunk.byteLength
        if (event.sentBytes > maxTunnelBytes) abortTunnel('tunnel-response-limit')
      })
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })

  try {
    const target = await listenOnLoopback(server, ownership, service)
    const endpoint = mapSwFixtureEndpoint(`http://127.0.0.1:${target.connectPort}`, target)
    let closed = false
    return {
      endpoint,
      proxyUrl: endpoint.origin,
      chromiumProxyArgs: [`--proxy-server=${endpoint.origin}`, '--proxy-bypass-list=<-loopback>'],
      events: journal.events,
      owned: ownership.records,
      mappings,
      waitForEvent: (predicate, timeoutMs) => journal.waitFor(predicate, timeoutMs),
      close: async () => {
        if (closed) return
        closed = true
        journal.close('SW allowlist proxy closed')
        closeMappings()
        await ownership.close()
      },
    }
  } catch (error) {
    journal.close('SW allowlist proxy failed to start')
    closeMappings()
    await ownership.close()
    throw error
  }
}
