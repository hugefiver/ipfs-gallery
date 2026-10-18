import type { AddressInfo, Server as NetServer, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

type Server = NetServer & { closeAllConnections?(): void }

export type SwFixtureProtocol = 'http:' | 'https:' | 'wss:'

export interface SwOwnedServerTarget {
  readonly connectHostname: string
  readonly connectPort: number
  readonly localAuthority: string
  readonly __swOwnedServerTarget: true
}

export interface SwFixtureEndpoint {
  readonly protocol: SwFixtureProtocol
  readonly hostname: string
  readonly port: number
  readonly authority: string
  readonly origin: string
  readonly target: SwOwnedServerTarget
}

export interface SwOwnedObjectRecord {
  id: string
  service: string
  kind: 'server' | 'connection' | 'upstream' | 'timer'
  createdAt: number
  closedAt?: number
  aborted: boolean
  local?: string
  remote?: string
}

export interface SwNetworkPhase {
  stage: string
  at: number
  bytes?: number
  detail?: string
}

export interface SwNetworkEvent {
  id: string
  service: string
  stage: string
  startedAt: number
  completedAt?: number
  method?: string
  url?: string
  target?: string
  cid?: string
  status?: number
  allowed?: boolean
  receivedBytes: number
  sentBytes: number
  aborted: boolean
  phases: SwNetworkPhase[]
}

interface EventWaiter {
  predicate: (event: SwNetworkEvent) => boolean
  resolve: (event: SwNetworkEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function socketAddress(address: ReturnType<Socket['address']>): string | undefined {
  if (typeof address === 'string') return address
  if (!address || !('address' in address) || !('port' in address)) return undefined
  return `${address.address}:${address.port}`
}

const activeServerTargets = new WeakSet<SwOwnedServerTarget>()

export class SwEventJournal {
  readonly events: SwNetworkEvent[] = []
  readonly maxEvents: number
  #closed = false
  #waiters = new Set<EventWaiter>()

  constructor(maxEvents = 1024) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be a positive integer')
    this.maxEvents = maxEvents
  }

  begin(input: Omit<SwNetworkEvent, 'id' | 'startedAt' | 'receivedBytes' | 'sentBytes' | 'aborted' | 'phases'>): SwNetworkEvent {
    if (this.#closed) throw new Error('SW fixture event journal is closed')
    if (this.events.length >= this.maxEvents) throw new Error('SW fixture event log limit exceeded')
    const event: SwNetworkEvent = {
      ...input,
      id: randomUUID(),
      startedAt: Date.now(),
      receivedBytes: 0,
      sentBytes: 0,
      aborted: false,
      phases: [],
    }
    this.events.push(event)
    this.phase(event, input.stage)
    return event
  }

  #notify(event: SwNetworkEvent): void {
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(event)) continue
      clearTimeout(waiter.timer)
      this.#waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  phase(event: SwNetworkEvent, stage: string, bytes?: number, detail?: string): void {
    event.phases.push({ stage, at: Date.now(), ...(bytes === undefined ? {} : { bytes }), ...(detail ? { detail } : {}) })
    this.#notify(event)
  }

  complete(event: SwNetworkEvent, update: Partial<Pick<SwNetworkEvent, 'status' | 'receivedBytes' | 'sentBytes' | 'aborted'>> = {}): void {
    if (event.completedAt !== undefined) return
    Object.assign(event, update)
    event.completedAt = Date.now()
    this.phase(event, event.aborted ? 'aborted' : 'settled')
  }

  waitFor(predicate: (event: SwNetworkEvent) => boolean, timeoutMs = 5000): Promise<SwNetworkEvent> {
    const existing = this.events.find(predicate)
    if (existing) return Promise.resolve(existing)
    if (this.#closed) return Promise.reject(new Error('SW fixture event journal is closed'))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('timeoutMs must be a positive integer'))
    return new Promise<SwNetworkEvent>((resolve, reject) => {
      const waiter = {} as EventWaiter
      waiter.predicate = predicate
      waiter.resolve = resolve
      waiter.reject = reject
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter)
        reject(new Error('Timed out waiting for a SW fixture network event'))
      }, timeoutMs)
      this.#waiters.add(waiter)
    })
  }

  close(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    for (const event of this.events) {
      if (event.completedAt !== undefined) continue
      this.phase(event, 'service-close', undefined, reason)
      this.complete(event, { aborted: true })
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    this.#waiters.clear()
  }
}

export class SwOwnedResources {
  readonly records: SwOwnedObjectRecord[] = []
  #servers = new Map<Server, SwOwnedObjectRecord>()
  #sockets = new Map<Socket, SwOwnedObjectRecord>()
  #timers = new Map<ReturnType<typeof setTimeout>, SwOwnedObjectRecord>()
  #targets = new Set<SwOwnedServerTarget>()
  #closePromise?: Promise<void>
  #closed = false

  ownServer(server: Server, service: string): SwOwnedObjectRecord {
    if (this.#closed) throw new Error('Cannot own a server after fixture closure')
    const existing = this.#servers.get(server)
    if (existing) return existing
    const record: SwOwnedObjectRecord = {
      id: randomUUID(), service, kind: 'server', createdAt: Date.now(), aborted: false,
    }
    this.records.push(record)
    this.#servers.set(server, record)
    server.once('close', () => { record.closedAt ??= Date.now() })
    server.on('connection', (socket) => {
      if (this.#closed) {
        socket.destroy()
        return
      }
      this.ownSocket(socket, service, 'connection')
    })
    return record
  }

  ownSocket(socket: Socket, service: string, kind: 'connection' | 'upstream' = 'upstream'): SwOwnedObjectRecord {
    const existing = this.#sockets.get(socket)
    if (existing) return existing
    const record: SwOwnedObjectRecord = {
      id: randomUUID(),
      service,
      kind,
      createdAt: Date.now(),
      aborted: false,
      local: socketAddress(socket.address()),
      remote: socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort ?? 0}` : undefined,
    }
    this.records.push(record)
    this.#sockets.set(socket, record)
    socket.once('connect', () => {
      record.local = socketAddress(socket.address())
      record.remote = socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort ?? 0}` : record.remote
    })
    socket.once('close', () => {
      record.closedAt ??= Date.now()
      this.#sockets.delete(socket)
    })
    if (this.#closed) {
      record.aborted = true
      socket.destroy()
    }
    return record
  }

  ownListeningTarget(server: Server, address: AddressInfo): SwOwnedServerTarget {
    if (this.#closed || !server.listening || !this.#servers.has(server)) {
      throw new Error('Owned target requires a listening server from the same resource owner')
    }
    if (address.address !== '127.0.0.1' || address.family !== 'IPv4') {
      throw new Error('SW fixture targets must listen on the IPv4 loopback address')
    }
    const target = Object.freeze({
      connectHostname: address.address,
      connectPort: address.port,
      localAuthority: `${address.address}:${address.port}`,
      __swOwnedServerTarget: true as const,
    })
    this.#targets.add(target)
    activeServerTargets.add(target)
    server.once('close', () => {
      activeServerTargets.delete(target)
      this.#targets.delete(target)
    })
    return target
  }

  setTimeout(service: string, callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    if (this.#closed) throw new Error('Cannot create a timer after fixture closure')
    const timer = setTimeout(() => {
      const record = this.#timers.get(timer)
      if (record) record.closedAt = Date.now()
      this.#timers.delete(timer)
      callback()
    }, delayMs)
    const record: SwOwnedObjectRecord = {
      id: randomUUID(), service, kind: 'timer', createdAt: Date.now(), aborted: false,
    }
    this.records.push(record)
    this.#timers.set(timer, record)
    return timer
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>, aborted = false): void {
    clearTimeout(timer)
    const record = this.#timers.get(timer)
    if (!record) return
    record.aborted = aborted
    record.closedAt = Date.now()
    this.#timers.delete(timer)
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    this.#closePromise = (async () => {
      for (const [timer, record] of this.#timers) {
        clearTimeout(timer)
        record.aborted = true
        record.closedAt = Date.now()
      }
      this.#timers.clear()
      for (const target of this.#targets) activeServerTargets.delete(target)
      this.#targets.clear()
      const socketClosures = Array.from(this.#sockets, ([socket, record]) => new Promise<void>((resolve) => {
        if (record.closedAt !== undefined) {
          resolve()
          return
        }
        if (socket.destroyed) {
          record.closedAt = Date.now()
          resolve()
          return
        }
        socket.once('close', resolve)
        record.aborted = true
        socket.destroy()
      }))
      const closures = Array.from(this.#servers, ([server, record]) => new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          record.closedAt = Date.now()
          resolve()
          return
        }
        server.closeAllConnections?.()
        server.close((error) => {
          record.closedAt = Date.now()
          if (error) reject(error)
          else resolve()
        })
      }))
      await Promise.all([...socketClosures, ...closures])
    })()
    return this.#closePromise
  }

  get activeCount(): number {
    return this.records.filter((record) => record.closedAt === undefined).length
  }
}

export async function listenOnLoopback(
  server: Server,
  ownership: SwOwnedResources,
  service: string,
): Promise<SwOwnedServerTarget> {
  const record = ownership.ownServer(server, service)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('SW fixture server did not expose an IP address')
  record.local = `${address.address}:${address.port}`
  return ownership.ownListeningTarget(server, address)
}

export function isActiveSwOwnedServerTarget(target: SwOwnedServerTarget): boolean {
  return activeServerTargets.has(target)
}

export function mapSwFixtureEndpoint(requestOrigin: string, target: SwOwnedServerTarget): SwFixtureEndpoint {
  if (!isActiveSwOwnedServerTarget(target)) throw new Error('Fixture endpoint target is not an active owned server')
  const url = new URL(requestOrigin)
  if (!['http:', 'https:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported fixture endpoint protocol')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Fixture endpoint must be an origin without credentials, path, query or fragment')
  }
  const protocol = url.protocol as SwFixtureProtocol
  const defaultPort = protocol === 'http:' ? 80 : 443
  const port = url.port ? Number(url.port) : defaultPort
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Fixture endpoint port is invalid')
  const hostname = url.hostname.toLowerCase()
  const authorityHostname = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  const authority = `${authorityHostname}:${port}`
  const origin = `${protocol}//${authorityHostname}${port === defaultPort ? '' : `:${port}`}`
  return Object.freeze({
    protocol,
    hostname,
    port,
    authority,
    origin,
    target,
  })
}
