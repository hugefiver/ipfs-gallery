import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { CID } from 'multiformats/cid'
import type { FixtureBlock } from '../fixtures/unixfs'
import {
  listenOnLoopback,
  mapSwFixtureEndpoint,
  SwEventJournal,
  SwOwnedResources,
  type SwFixtureEndpoint,
  type SwNetworkEvent,
  type SwOwnedObjectRecord,
} from './sw-owned'
import type { SwTestTlsConfig } from './sw-tls'

type ResponseBody = Uint8Array | string
type ResponseHeaders = Readonly<Record<string, string>>

export type SwRawGatewayMode =
  | { kind: 'correct' }
  | { kind: 'corrupt' }
  | { kind: '404' }
  | { kind: '429'; retryAfter?: string }
  | { kind: 'redirect'; location: string; status?: 301 | 302 | 303 | 307 | 308 }
  | { kind: 'response'; status: number; body?: ResponseBody; headers?: ResponseHeaders }
  | { kind: 'disconnect' }
  | { kind: 'delay'; milliseconds: number; then?: Exclude<SwRawGatewayMode, { kind: 'delay' }> }

export type SwRouterMode =
  | { kind: 'providers' }
  | { kind: 'empty' }
  | { kind: 'malformed'; body?: string; contentType?: string }
  | { kind: 'response'; status: number; body?: ResponseBody; headers?: ResponseHeaders }
  | { kind: 'disconnect' }
  | { kind: 'delay'; milliseconds: number; then?: Exclude<SwRouterMode, { kind: 'delay' }> }

interface HttpsFixtureOptions {
  tls: SwTestTlsConfig
  maxEvents?: number
  maxResponseBytes?: number
}

export interface StartSwRawGatewayOptions extends HttpsFixtureOptions {
  blocks: ReadonlyMap<string, FixtureBlock>
  initialMode?: SwRawGatewayMode
}

export interface StartSwRouterOptions extends HttpsFixtureOptions {
  providers?: ReadonlyMap<string, readonly unknown[]>
  initialMode?: SwRouterMode
  maxProviders?: number
}

interface SwHttpsFixtureService {
  endpoint: SwFixtureEndpoint
  origin: string
  events: SwNetworkEvent[]
  owned: SwOwnedObjectRecord[]
  waitForEvent(predicate: (event: SwNetworkEvent) => boolean, timeoutMs?: number): Promise<SwNetworkEvent>
  close(): Promise<void>
}

export interface SwRawGatewayService extends SwHttpsFixtureService {
  setMode(mode: SwRawGatewayMode): void
  setBlockMode(cid: string, mode: SwRawGatewayMode | undefined): void
}

export interface SwRouterService extends SwHttpsFixtureService {
  setMode(mode: SwRouterMode): void
  setCidMode(cid: string, mode: SwRouterMode | undefined): void
  setProviders(cid: string, providers: readonly unknown[]): void
}

const FORBIDDEN_HTTP_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'referer'] as const

function canonicalCid(value: string): string | undefined {
  try {
    const canonical = CID.parse(value).toV1().toString()
    return canonical === value ? canonical : undefined
  } catch {
    return undefined
  }
}

function hasForbiddenHeaders(request: IncomingMessage): boolean {
  return FORBIDDEN_HTTP_HEADERS.some((name) => request.headers[name] !== undefined)
}

function configureServer(server: ReturnType<typeof createServer>): void {
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.keepAliveTimeout = 1000
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 100
}

function attachLifecycle(
  request: IncomingMessage,
  response: ServerResponse,
  journal: SwEventJournal,
  event: SwNetworkEvent,
  onSettle?: (aborted: boolean) => void,
): void {
  let settled = false
  const settle = (aborted: boolean) => {
    if (settled) return
    settled = true
    onSettle?.(aborted)
    journal.complete(event, { aborted })
  }
  request.once('aborted', () => settle(true))
  response.once('finish', () => settle(false))
  response.once('close', () => settle(!response.writableFinished))
  request.on('data', (chunk: Buffer) => {
    event.receivedBytes += chunk.byteLength
    if (event.receivedBytes > 1024) request.destroy(new Error('Fixture endpoint request body limit exceeded'))
  })
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  response.setHeader('access-control-allow-headers', 'Accept')
  response.setHeader('access-control-expose-headers', 'Content-Length, Retry-After')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
}

function beginEvent(
  journal: SwEventJournal,
  response: ServerResponse,
  input: Parameters<SwEventJournal['begin']>[0],
): SwNetworkEvent | undefined {
  try {
    return journal.begin(input)
  } catch {
    response.statusCode = 503
    response.setHeader('connection', 'close')
    response.setHeader('content-length', '0')
    response.end()
    return undefined
  }
}

function sendResponse(
  request: IncomingMessage,
  response: ServerResponse,
  journal: SwEventJournal,
  event: SwNetworkEvent,
  status: number,
  body: ResponseBody = '',
  headers: ResponseHeaders = {},
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  response.statusCode = status
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  if (!response.hasHeader('content-length')) response.setHeader('content-length', bytes.byteLength)
  event.status = status
  event.sentBytes = request.method === 'HEAD' ? 0 : bytes.byteLength
  journal.phase(event, 'response', event.sentBytes, String(status))
  response.end(request.method === 'HEAD' ? undefined : bytes)
}

function validateBodylessRequest(request: IncomingMessage, response: ServerResponse, journal: SwEventJournal, event: SwNetworkEvent): boolean {
  if (request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) {
    sendResponse(request, response, journal, event, 400)
    return false
  }
  if (hasForbiddenHeaders(request)) {
    sendResponse(request, response, journal, event, 400)
    return false
  }
  return true
}

function validateResponsePlan(status: number, body: ResponseBody, maxResponseBytes: number): void {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new Error('Fixture response status is invalid')
  const byteLength = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  if (byteLength > maxResponseBytes) throw new Error('Fixture response exceeds maxResponseBytes')
}

export async function startSwHttpsRawGateway(options: StartSwRawGatewayOptions): Promise<SwRawGatewayService> {
  const service = 'sw-raw-gateway'
  const ownership = new SwOwnedResources()
  const journal = new SwEventJournal(options.maxEvents)
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024
  let mode = options.initialMode ?? { kind: 'correct' }
  const blockModes = new Map<string, SwRawGatewayMode>()
  const server = createServer({ ...options.tls.serverOptions, maxHeaderSize: 16 * 1024 }, (request, response) => {
    setCommonHeaders(response)
    const event = beginEvent(journal, response, {
      service, stage: 'raw-request', method: request.method ?? '', url: request.url ?? '',
    })
    if (!event) return
    let timer: ReturnType<typeof setTimeout> | undefined
    attachLifecycle(request, response, journal, event, (aborted) => {
      if (timer) ownership.clearTimeout(timer, aborted)
    })
    const url = new URL(request.url ?? '/', 'https://fixture.invalid')
    if (request.method === 'OPTIONS') {
      sendResponse(request, response, journal, event, 204)
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendResponse(request, response, journal, event, 405)
      return
    }
    if (!validateBodylessRequest(request, response, journal, event)) return
    const match = /^\/ipfs\/([^/]+)$/.exec(url.pathname)
    const cid = match ? canonicalCid(match[1]!) : undefined
    const queryKeys = Array.from(url.searchParams.keys())
    if (!cid || queryKeys.length !== 1 || queryKeys[0] !== 'format' || url.searchParams.get('format') !== 'raw') {
      sendResponse(request, response, journal, event, 404)
      return
    }
    event.cid = cid
    journal.phase(event, 'cid', undefined, cid)
    if (!request.headers.accept?.split(',').some((value) => value.trim().startsWith('application/vnd.ipld.raw'))) {
      sendResponse(request, response, journal, event, 406)
      return
    }
    const deliver = (selected: Exclude<SwRawGatewayMode, { kind: 'delay' }>) => {
      if (response.destroyed) return
      journal.phase(event, 'raw-delivery')
      if (selected.kind === '404') {
        sendResponse(request, response, journal, event, 404)
        return
      }
      if (selected.kind === '429') {
        sendResponse(request, response, journal, event, 429, '', { 'retry-after': selected.retryAfter ?? '1' })
        return
      }
      if (selected.kind === 'redirect') {
        sendResponse(request, response, journal, event, selected.status ?? 302, '', { location: selected.location })
        return
      }
      if (selected.kind === 'disconnect') {
        journal.phase(event, 'disconnect')
        response.destroy()
        return
      }
      if (selected.kind === 'response') {
        validateResponsePlan(selected.status, selected.body ?? '', maxResponseBytes)
        sendResponse(request, response, journal, event, selected.status, selected.body, selected.headers)
        return
      }
      const block = options.blocks.get(cid)
      if (!block) {
        sendResponse(request, response, journal, event, 404)
        return
      }
      const bytes = block.bytes.slice()
      if (selected.kind === 'corrupt') {
        if (bytes.byteLength === 0) {
          sendResponse(request, response, journal, event, 200, Uint8Array.of(0xff), { 'content-type': 'application/vnd.ipld.raw' })
          return
        }
        bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0xff
      }
      validateResponsePlan(200, bytes, maxResponseBytes)
      sendResponse(request, response, journal, event, 200, bytes, { 'content-type': 'application/vnd.ipld.raw' })
    }
    const safeDeliver = (selected: Exclude<SwRawGatewayMode, { kind: 'delay' }>) => {
      try {
        deliver(selected)
      } catch {
        journal.phase(event, 'fixture-config-error')
        if (!response.headersSent) sendResponse(request, response, journal, event, 500)
        else response.destroy()
      }
    }
    const selected = blockModes.get(cid) ?? mode
    if (selected.kind === 'delay') {
      journal.phase(event, 'delay', undefined, String(selected.milliseconds))
      timer = ownership.setTimeout(service, () => safeDeliver(selected.then ?? { kind: 'correct' }), selected.milliseconds)
    } else {
      safeDeliver(selected)
    }
  })
  configureServer(server)
  try {
    const target = await listenOnLoopback(server, ownership, service)
    const endpoint = mapSwFixtureEndpoint(`https://localhost:${target.connectPort}`, target)
    let closed = false
    return {
      endpoint,
      origin: endpoint.origin,
      events: journal.events,
      owned: ownership.records,
      setMode(value) { mode = value },
      setBlockMode(cid, value) {
        const key = CID.parse(cid).toV1().toString()
        if (value) blockModes.set(key, value)
        else blockModes.delete(key)
      },
      waitForEvent: (predicate, timeoutMs) => journal.waitFor(predicate, timeoutMs),
      close: async () => {
        if (closed) return
        closed = true
        journal.close('SW raw gateway closed')
        await ownership.close()
      },
    }
  } catch (error) {
    journal.close('SW raw gateway failed to start')
    await ownership.close()
    throw error
  }
}

export async function startSwHttpsRouter(options: StartSwRouterOptions): Promise<SwRouterService> {
  const service = 'sw-delegated-router'
  const ownership = new SwOwnedResources()
  const journal = new SwEventJournal(options.maxEvents)
  const maxProviders = options.maxProviders ?? 16
  const maxResponseBytes = options.maxResponseBytes ?? 256 * 1024
  if (!Number.isSafeInteger(maxProviders) || maxProviders < 1) throw new Error('maxProviders must be a positive integer')
  const providers = new Map<string, readonly unknown[]>()
  for (const [cid, records] of options.providers ?? []) {
    providers.set(CID.parse(cid).toV1().toString(), [...records])
  }
  const cidModes = new Map<string, SwRouterMode>()
  let mode = options.initialMode ?? { kind: 'providers' }
  const server = createServer({ ...options.tls.serverOptions, maxHeaderSize: 16 * 1024 }, (request, response) => {
    setCommonHeaders(response)
    const event = beginEvent(journal, response, {
      service, stage: 'router-request', method: request.method ?? '', url: request.url ?? '',
    })
    if (!event) return
    let timer: ReturnType<typeof setTimeout> | undefined
    attachLifecycle(request, response, journal, event, (aborted) => {
      if (timer) ownership.clearTimeout(timer, aborted)
    })
    const url = new URL(request.url ?? '/', 'https://fixture.invalid')
    if (request.method === 'OPTIONS') {
      sendResponse(request, response, journal, event, 204)
      return
    }
    if (request.method !== 'GET') {
      sendResponse(request, response, journal, event, 405)
      return
    }
    if (!validateBodylessRequest(request, response, journal, event)) return
    const match = /^\/routing\/v1\/providers\/([^/]+)$/.exec(url.pathname)
    const cid = match ? canonicalCid(match[1]!) : undefined
    const allowedQuery = new Set(['filter-addrs', 'filter-protocols'])
    if (!cid || Array.from(url.searchParams.keys()).some((key) => !allowedQuery.has(key))) {
      sendResponse(request, response, journal, event, 404)
      return
    }
    event.cid = cid
    journal.phase(event, 'cid', undefined, cid)
    const deliver = (selected: Exclude<SwRouterMode, { kind: 'delay' }>) => {
      if (response.destroyed) return
      journal.phase(event, 'router-delivery')
      if (selected.kind === 'disconnect') {
        journal.phase(event, 'disconnect')
        response.destroy()
        return
      }
      if (selected.kind === 'response') {
        validateResponsePlan(selected.status, selected.body ?? '', maxResponseBytes)
        sendResponse(request, response, journal, event, selected.status, selected.body, selected.headers)
        return
      }
      if (selected.kind === 'malformed') {
        const body = selected.body ?? '{not-json'
        validateResponsePlan(200, body, maxResponseBytes)
        sendResponse(request, response, journal, event, 200, body, { 'content-type': selected.contentType ?? 'application/json' })
        return
      }
      const records = selected.kind === 'empty' ? [] : [...(providers.get(cid) ?? [])]
      if (records.length > maxProviders) {
        sendResponse(request, response, journal, event, 503)
        return
      }
      const wantsNdjson = request.headers.accept?.split(',').some((value) => value.trim().startsWith('application/x-ndjson')) ?? false
      const body = wantsNdjson
        ? records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
        : JSON.stringify({ Providers: records })
      validateResponsePlan(200, body, maxResponseBytes)
      sendResponse(request, response, journal, event, 200, body, {
        'content-type': wantsNdjson ? 'application/x-ndjson' : 'application/json',
        vary: 'Accept',
      })
    }
    const safeDeliver = (selected: Exclude<SwRouterMode, { kind: 'delay' }>) => {
      try {
        deliver(selected)
      } catch {
        journal.phase(event, 'fixture-config-error')
        if (!response.headersSent) sendResponse(request, response, journal, event, 500)
        else response.destroy()
      }
    }
    const selected = cidModes.get(cid) ?? mode
    if (selected.kind === 'delay') {
      journal.phase(event, 'delay', undefined, String(selected.milliseconds))
      timer = ownership.setTimeout(service, () => safeDeliver(selected.then ?? { kind: 'providers' }), selected.milliseconds)
    } else {
      safeDeliver(selected)
    }
  })
  configureServer(server)
  try {
    const target = await listenOnLoopback(server, ownership, service)
    const endpoint = mapSwFixtureEndpoint(`https://localhost:${target.connectPort}`, target)
    let closed = false
    return {
      endpoint,
      origin: endpoint.origin,
      events: journal.events,
      owned: ownership.records,
      setMode(value) { mode = value },
      setCidMode(cid, value) {
        const key = CID.parse(cid).toV1().toString()
        if (value) cidModes.set(key, value)
        else cidModes.delete(key)
      },
      setProviders(cid, value) {
        providers.set(CID.parse(cid).toV1().toString(), [...value])
      },
      waitForEvent: (predicate, timeoutMs) => journal.waitFor(predicate, timeoutMs),
      close: async () => {
        if (closed) return
        closed = true
        journal.close('SW delegated router closed')
        await ownership.close()
      },
    }
  } catch (error) {
    journal.close('SW delegated router failed to start')
    await ownership.close()
    throw error
  }
}
