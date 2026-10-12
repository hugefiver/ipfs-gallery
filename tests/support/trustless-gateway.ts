import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CID } from 'multiformats/cid'
import type { FixtureBlock } from '../fixtures/unixfs'

export type GatewayMode =
  | { kind: 'correct' }
  | { kind: 'corrupt' }
  | { kind: '404' }
  | { kind: '429'; retryAfter?: string }
  | { kind: 'delay'; milliseconds: number; then?: Exclude<GatewayMode, { kind: 'delay' }> }

export interface GatewayRequestRecord {
  method: string
  url: string
  cid?: string
  headers: IncomingHttpHeaders
  startedAt: number
  completedAt?: number
  status?: number
  aborted: boolean
}

export interface TrustlessGateway {
  origin: string
  requests: GatewayRequestRecord[]
  counts: { active: number; peak: number; total: number }
  setMode(mode: GatewayMode): void
  setBlockMode(cid: string, mode: GatewayMode | undefined): void
  waitForRequest(predicate: (record: GatewayRequestRecord) => boolean, timeoutMs?: number): Promise<GatewayRequestRecord>
  close(): Promise<void>
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

export async function startTrustlessGateway(
  blocks: ReadonlyMap<string, FixtureBlock>,
  initialMode: GatewayMode = { kind: 'correct' },
): Promise<TrustlessGateway> {
  const requests: GatewayRequestRecord[] = []
  const counts = { active: 0, peak: 0, total: 0 }
  const blockModes = new Map<string, GatewayMode>()
  const observers = new Set<(record: GatewayRequestRecord) => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let mode = initialMode
  let closed = false
  const shutdown = new AbortController()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const record: GatewayRequestRecord = {
      method: request.method ?? 'GET', url: request.url ?? '/', headers: { ...request.headers },
      startedAt: Date.now(), aborted: false,
    }
    requests.push(record)
    counts.total += 1
    counts.active += 1
    counts.peak = Math.max(counts.peak, counts.active)
    let completed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (aborted: boolean) => {
      if (completed) return
      completed = true
      record.aborted = aborted
      record.completedAt = Date.now()
      counts.active -= 1
      if (timer) { clearTimeout(timer); timers.delete(timer) }
    }
    response.once('finish', () => finish(false))
    response.once('close', () => finish(!response.writableFinished))
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    response.setHeader('access-control-allow-headers', 'Accept')
    response.setHeader('access-control-expose-headers', 'Content-Length, Retry-After')
    response.setHeader('cache-control', 'no-store')
    const send = (status: number, body: Uint8Array | string = '') => {
      record.status = status
      response.statusCode = status
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    if (request.method === 'OPTIONS') {
      for (const observer of observers) observer(record)
      send(204)
      return
    }
    try {
      const match = /^\/ipfs\/([^/]+)$/.exec(url.pathname)
      if (!match) throw new Error('Only individual raw blocks are served')
      record.cid = CID.parse(decodeURIComponent(match[1]!)).toV1().toString()
    } catch {
      for (const observer of observers) observer(record)
      send(404)
      return
    }
    for (const observer of observers) observer(record)
    if (request.method !== 'GET' && request.method !== 'HEAD') { send(405); return }
    if (url.searchParams.get('format') !== 'raw' || !request.headers.accept?.includes('application/vnd.ipld.raw')) {
      send(406)
      return
    }
    const selected = blockModes.get(record.cid) ?? mode
    const deliver = (delivery: Exclude<GatewayMode, { kind: 'delay' }>) => {
      if (response.destroyed || closed) return
      if (delivery.kind === '404') { send(404); return }
      if (delivery.kind === '429') {
        response.setHeader('retry-after', delivery.retryAfter ?? '1')
        send(429)
        return
      }
      const block = blocks.get(record.cid!)
      if (!block) { send(404); return }
      const bytes = block.bytes.slice()
      if (delivery.kind === 'corrupt') {
        if (bytes.length) bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
        else { send(200, Uint8Array.of(0xff)); return }
      }
      response.setHeader('content-type', 'application/vnd.ipld.raw')
      response.setHeader('content-length', bytes.byteLength)
      send(200, bytes)
    }
    if (selected.kind === 'delay') {
      timer = setTimeout(() => {
        timers.delete(timer!)
        deliver(selected.then ?? { kind: 'correct' })
      }, selected.milliseconds)
      timers.add(timer)
    } else deliver(selected)
  })
  try {
    await listen(server)
  } catch (error) {
    server.close()
    throw error
  }
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    counts,
    setMode: (value) => { mode = value },
    setBlockMode: (cid, value) => {
      const key = CID.parse(cid).toV1().toString()
      if (value) blockModes.set(key, value)
      else blockModes.delete(key)
    },
    waitForRequest: async (predicate, timeoutMs = 5000) => {
      if (closed) throw new Error('Fixture gateway is closed')
      const existing = requests.find(predicate)
      if (existing) return existing
      return new Promise<GatewayRequestRecord>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          observers.delete(observe)
          shutdown.signal.removeEventListener('abort', onShutdown)
        }
        const onShutdown = () => {
          cleanup()
          reject(new Error('Fixture gateway closed while waiting for a request'))
        }
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('Timed out waiting for a fixture gateway request'))
        }, timeoutMs)
        const observe = (record: GatewayRequestRecord) => {
          if (!predicate(record)) return
          cleanup()
          resolve(record)
        }
        observers.add(observe)
        shutdown.signal.addEventListener('abort', onShutdown, { once: true })
      })
    },
    close: async () => {
      if (closed) return
      closed = true
      shutdown.abort()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
}
