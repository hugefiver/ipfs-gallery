import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer, type Server, type Socket } from 'node:net'
import { identify } from '@libp2p/identify'
import type { MessageStream, Stream } from '@libp2p/interface'
import { noise } from '@libp2p/noise'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import {
  listenOnLoopback, mapSwFixtureEndpoint, SwOwnedResources,
  type SwFixtureEndpoint, type SwOwnedObjectRecord,
} from '../support/sw-owned'
import { SW_TEST_TLS } from '../support/sw-test-tls'

export const DELAYED_WSS_HOST = 'delayed.gallery-fixture.test'
export const MALICIOUS_YAMUX_HOST = 'malicious.gallery-fixture.test'
export const BROWSER_YAMUX_CAP = 1024 * 1024
const BITSWAP_PROTOCOL = '/ipfs/bitswap/1.2.0'

type Stamp = { at: number; duringCleanup: boolean }
type Unstamped<T> = T extends Stamp ? Omit<T, keyof Stamp> : never
export type BrowserPeerRecord = Stamp & (
  | { type: 'upgrade'; socketId: string; url: string; host: string | undefined }
  | { type: 'native:open' | 'native:end'; socketId: string; remotePort: number | undefined }
  | { type: 'native:close'; socketId: string; hadError: boolean }
  | { type: 'tls:end' | 'tls:close'; socketId: string }
  | { type: 'websocket:close-received'; socketId: string; code: number; reason: Uint8Array }
  | { type: 'websocket:close-send'; socketId: string; code: number | undefined; respondingToPeer: boolean }
  | { type: 'websocket:closed'; socketId: string; code: number }
  | { type: 'connection:open' | 'connection:close'; connectionId: string; peerId: string; address: string }
  | { type: 'secured:received'; bytes: number; prefix: Uint8Array }
  | { type: 'yamux:goaway'; reason: number; ignored: boolean }
  | { type: 'attack:header'; streamId: number; declaredLength: number; header: Uint8Array }
  | { type: 'attack:body'; bytes: number; totalBodyBytes: number; accepted: boolean }
  | { type: 'content:stream'; streamId: string }
  | { type: 'content:received' | 'content:sent'; bytes: number }
)

export interface BrowserPeerFixture {
  endpoint: SwFixtureEndpoint
  records: BrowserPeerRecord[]
  errors: unknown[]
  owned: SwOwnedObjectRecord[]
  readonly activeCount: number
  waitForRecord(predicate: (record: BrowserPeerRecord) => boolean, timeoutMs?: number): Promise<BrowserPeerRecord>
  /** Destructive cleanup only: call from the test's finally block, after close assertions. */
  close(): Promise<void>
}

export interface YamuxAttackOptions {
  declaredLength?: number
  /** Each continuation is real encrypted stream data, not a second Yamux header. */
  partialBodyBytes?: number
  repetitions?: number
  intervalMs?: number
}

export interface MaliciousYamuxPeer extends BrowserPeerFixture {
  peerId: string
  localAddress: Multiaddr
  publicAddress: Multiaddr
  /** Requires an established inbound connection; can be invoked only once. */
  attack(options?: YamuxAttackOptions): Promise<void>
  readonly content: { streams: number; receivedBytes: number; sentBytes: number }
}

function observations(ownership: SwOwnedResources) {
  const records: BrowserPeerRecord[] = []
  const errors: unknown[] = []
  let cleaning = false
  const observers = new Set<(record: BrowserPeerRecord) => void>()
  const cancellations = new Set<() => void>()
  const add = (record: Unstamped<BrowserPeerRecord>) => {
    if (records.length >= 4096) throw new Error('Browser peer observation limit exceeded')
    const stamped = { ...record, at: Date.now(), duringCleanup: cleaning }
    records.push(stamped)
    for (const observer of observers) observer(stamped)
  }
  const waitForRecord: BrowserPeerFixture['waitForRecord'] = (predicate, timeoutMs = 5000) => {
    const found = records.find(predicate)
    if (found) return Promise.resolve(found)
    if (cleaning) return Promise.reject(new Error('Browser peer is closing'))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid observation timeout')
    return new Promise((resolve, reject) => {
      const finish = (record?: BrowserPeerRecord) => {
        ownership.clearTimeout(timer)
        observers.delete(observer)
        cancellations.delete(cancel)
        if (record) resolve(record)
        else reject(new Error('Browser peer observation ended without a matching record'))
      }
      const observer = (record: BrowserPeerRecord) => { if (predicate(record)) finish(record) }
      const cancel = () => finish()
      const timer = ownership.setTimeout('browser-peer-observation', cancel, timeoutMs)
      observers.add(observer)
      cancellations.add(cancel)
    })
  }
  return {
    records, errors, add, waitForRecord,
    get cleaning() { return cleaning },
    cleanup() {
      cleaning = true
      for (const cancel of cancellations) cancel()
    },
  }
}

type Observations = ReturnType<typeof observations>

function observeNative(server: Server, ownership: SwOwnedResources, log: Observations) {
  const ids = new Map<number, string>()
  server.on('connection', (socket: Socket) => {
    const socketId = randomUUID()
    if (socket.remotePort !== undefined) ids.set(socket.remotePort, socketId)
    ownership.ownSocket(socket, 'browser-peer-native', 'connection')
    log.add({ type: 'native:open', socketId, remotePort: socket.remotePort })
    socket.on('error', error => { if (!log.cleaning) log.errors.push(error) })
    socket.once('end', () => log.add({ type: 'native:end', socketId, remotePort: socket.remotePort }))
    socket.once('close', hadError => {
      if (socket.remotePort !== undefined) ids.delete(socket.remotePort)
      log.add({ type: 'native:close', socketId, hadError })
    })
  })
  return (socket: Socket) => {
    const id = socket.remotePort === undefined ? undefined : ids.get(socket.remotePort)
    if (!id) throw new Error('Inbound TLS socket has no observed native connection')
    return id
  }
}

function observeUpgrade(request: IncomingMessage, socketId: string, log: Observations) {
  log.add({ type: 'upgrade', socketId, url: request.url ?? '/', host: request.headers.host })
  request.socket.once('end', () => log.add({ type: 'tls:end', socketId }))
  request.socket.once('close', () => log.add({ type: 'tls:close', socketId }))
  request.socket.on('error', error => { if (!log.cleaning) log.errors.push(error) })
}

/** Accepts TLS and HTTP Upgrade but never sends a handshake response or ends the socket. */
export async function startDelayedWssPeer(host = DELAYED_WSS_HOST): Promise<BrowserPeerFixture> {
  const ownership = new SwOwnedResources()
  const log = observations(ownership)
  const server = createHttpsServer(SW_TEST_TLS.serverOptions, (_request, response) => {
    response.writeHead(404).end()
  })
  server.timeout = 0
  server.requestTimeout = 0
  server.headersTimeout = 0
  const socketId = observeNative(server, ownership, log)
  server.on('upgrade', (request, socket) => {
    observeUpgrade(request, socketId(request.socket), log)
    request.socket.setTimeout(0)
    // Drain any peer bytes without completing or rejecting the pending upgrade.
    socket.on('data', () => {})
    socket.resume()
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => { log.cleanup(); await ownership.close() })()
  try {
    const target = await listenOnLoopback(server, ownership, 'delayed-wss')
    return {
      endpoint: mapSwFixtureEndpoint(`wss://${host}`, target), records: log.records,
      errors: log.errors, owned: ownership.records, waitForRecord: log.waitForRecord,
      get activeCount() { return ownership.activeCount }, close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

// Observation of the official Node listener's actual ws objects, not a substitute
// WebSocket implementation. ws's receiver emits conclude only for a decoded close frame.
interface ObservedWebSocket extends EventEmitter {
  _receiver: EventEmitter
  _closeFrameReceived: boolean
  _sender: { close(code: number | undefined, data: unknown, mask: boolean, callback: (error?: Error) => void): void }
}

interface ObservedListener {
  server: Server
  wsServer: EventEmitter
}

function observeWebSocket(socket: ObservedWebSocket, socketId: string, log: Observations) {
  socket._receiver.prependListener('conclude', (code: number, reason: Buffer) => {
    log.add({ type: 'websocket:close-received', socketId, code, reason: reason.slice() })
  })
  const close = socket._sender.close.bind(socket._sender)
  socket._sender.close = (code, data, mask, callback) => {
    log.add({ type: 'websocket:close-send', socketId, code, respondingToPeer: socket._closeFrameReceived })
    close(code, data, mask, callback)
  }
  socket.once('close', (code: number) => log.add({ type: 'websocket:closed', socketId, code }))
  socket.on('error', error => { if (!log.cleaning) log.errors.push(error) })
}

type Muxer = ReturnType<ReturnType<ReturnType<typeof yamux>>['createStreamMuxer']>

/** A real libp2p WSS/Noise peer whose explicit attack bypasses only Yamux output framing. */
export async function startMaliciousYamuxPeer(host = MALICIOUS_YAMUX_HOST): Promise<MaliciousYamuxPeer> {
  const ownership = new SwOwnedResources()
  const log = observations(ownership)
  const captured: Array<{ secured: MessageStream; muxer: Muxer }> = []
  const content = { streams: 0, receivedBytes: 0, sentBytes: 0 }
  let attacking = false
  let attackTimer: ReturnType<typeof setTimeout> | undefined
  const transport = webSockets({ https: SW_TEST_TLS.serverOptions })
  const node = await createLibp2p({
    start: false,
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0/wss'] },
    peerDiscovery: [],
    transports: [components => {
      const ws = transport(components)
      const createListener = ws.createListener.bind(ws)
      ws.createListener = options => {
        const listener = createListener(options)
        const observed = listener as unknown as ObservedListener
        if (!observed.server || !observed.wsServer) throw new Error('Official WSS listener observation seam unavailable')
        const socketId = observeNative(observed.server, ownership, log)
        observed.wsServer.prependListener('connection', (socket: ObservedWebSocket, request: IncomingMessage) => {
          const id = socketId(request.socket)
          observeUpgrade(request, id, log)
          observeWebSocket(socket, id, log)
        })
        return listener
      }
      return ws
    }],
    connectionEncrypters: [noise()],
    streamMuxers: [() => {
      const factory = yamux({ enableKeepAlive: false, maxInboundStreams: 16, maxOutboundStreams: 16 })()
      const create = factory.createStreamMuxer.bind(factory)
      factory.createStreamMuxer = secured => {
        secured.addEventListener('message', event => {
          const data = event.data instanceof Uint8Array ? event.data : event.data.subarray()
          log.add({ type: 'secured:received', bytes: data.byteLength, prefix: data.slice(0, 64) })
        })
        const muxer = create(secured)
        const handleGoAway = Reflect.get(muxer, 'handleGoAway') as (reason: number) => void
        if (typeof handleGoAway !== 'function') throw new Error('Official Yamux GoAway observation seam unavailable')
        Reflect.set(muxer, 'handleGoAway', (reason: number) => {
          log.add({ type: 'yamux:goaway', reason, ignored: attacking })
          // Do not let a protocol-error GoAway make this malicious server close
          // first. The official decoder and all other frame handlers stay active.
          if (!attacking) handleGoAway.call(muxer, reason)
        })
        const observeStream = (stream: Stream) => {
          const send = stream.send.bind(stream)
          stream.send = data => {
            if (stream.protocol === BITSWAP_PROTOCOL) {
              content.sentBytes += data.byteLength
              log.add({ type: 'content:sent', bytes: data.byteLength })
            }
            return send(data)
          }
        }
        muxer.addEventListener('stream', event => observeStream(event.detail))
        captured.push({ secured, muxer })
        return muxer
      }
      return factory
    }],
    services: { identify: identify() },
    connectionManager: { maxConnections: 2 },
  })
  node.addEventListener('connection:open', event => {
    const connection = event.detail
    log.add({ type: 'connection:open', connectionId: connection.id, peerId: connection.remotePeer.toString(), address: connection.remoteAddr.toString() })
  })
  node.addEventListener('connection:close', event => {
    const connection = event.detail
    log.add({ type: 'connection:close', connectionId: connection.id, peerId: connection.remotePeer.toString(), address: connection.remoteAddr.toString() })
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    log.cleanup()
    const failures: unknown[] = []
    try { await ownership.close() } catch (error) { failures.push(error) }
    try { await node.stop() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Browser peer cleanup failed')
  })()
  try {
    await node.handle(BITSWAP_PROTOCOL, (stream) => {
      content.streams++
      log.add({ type: 'content:stream', streamId: stream.id })
      // A valid protocol negotiation keeps the retrieval live, but this peer
      // never supplies a block. All observed application sends are counted above.
      stream.addEventListener('message', event => {
        content.receivedBytes += event.data.byteLength
        log.add({ type: 'content:received', bytes: event.data.byteLength })
      })
    }, { maxInboundStreams: 8, maxOutboundStreams: 8 })
    await node.start()
    const localAddress = node.getMultiaddrs().find(address => address.getComponents().some(component => component.name === 'ws' || component.name === 'wss'))
    const port = Number(localAddress?.getComponents().find(component => component.name === 'tcp')?.value)
    if (!localAddress || !port) throw new Error('Official malicious WSS listener did not start')
    // The allowlist accepts only targets owned by listenOnLoopback. This relay
    // forwards unchanged TLS bytes to the exact listener acquired above.
    const relay = createNetServer(client => {
      if (log.cleaning) { client.destroy(); return }
      const upstream = connect({ host: '127.0.0.1', port })
      ownership.ownSocket(upstream, 'malicious-wss-relay', 'upstream')
      client.on('error', error => { if (!log.cleaning) log.errors.push(error); upstream.destroy() })
      upstream.on('error', error => { if (!log.cleaning) log.errors.push(error); client.destroy() })
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    const target = await listenOnLoopback(relay, ownership, 'malicious-wss-relay')
    return {
      endpoint: mapSwFixtureEndpoint(`wss://${host}`, target), records: log.records,
      errors: log.errors, owned: ownership.records, waitForRecord: log.waitForRecord,
      get activeCount() { return ownership.activeCount }, close,
      peerId: node.peerId.toString(), localAddress,
      publicAddress: multiaddr(`/dns4/${host}/tcp/443/wss/p2p/${node.peerId}`),
      get content() { return { ...content } },
      async attack(options = {}) {
        const declaredLength = options.declaredLength ?? 0xffffffff
        const partialBodyBytes = options.partialBodyBytes ?? 1024
        const repetitions = options.repetitions ?? 32
        const intervalMs = options.intervalMs ?? 10
        if (![0xffffffff, BROWSER_YAMUX_CAP + 1].includes(declaredLength)) throw new Error('Attack must declare uint32 max or cap + 1')
        if (!Number.isSafeInteger(partialBodyBytes) || partialBodyBytes < 1 || partialBodyBytes > 4096
          || !Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 64
          || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new Error('Attack continuation is not bounded')
        const open = captured.filter(value => value.secured.status === 'open' && value.muxer.status === 'open')
        if (log.cleaning || attacking || node.getConnections().length !== 1 || open.length !== 1) throw new Error('Attack requires exactly one established, unattacked connection')
        const { secured, muxer } = open[0]!
        const stream = await muxer.createStream()
        if (log.cleaning || attacking || secured.status !== 'open') throw new Error('Connection ended before attack')
        attacking = true
        const header = new Uint8Array(12)
        const view = new DataView(header.buffer)
        view.setUint32(4, stream.streamId)
        view.setUint32(8, declaredLength)
        log.add({ type: 'attack:header', streamId: stream.streamId, declaredLength, header: header.slice() })
        // secured.send still runs the real Noise encryption and WSS transport.
        // No declared-size allocation, muxer.sendFrame, or application payload.
        secured.send(header)
        const body = new Uint8Array(partialBodyBytes).fill(0xa5)
        let count = 0
        let totalBodyBytes = 0
        const sendPartial = () => {
          attackTimer = undefined
          if (log.cleaning || secured.status !== 'open' || count >= repetitions) return
          if (secured.writableNeedsDrain) {
            attackTimer = ownership.setTimeout('yamux-partial-body', sendPartial, intervalMs)
            return
          }
          try {
            const accepted = secured.send(body.slice())
            totalBodyBytes += body.byteLength
            count++
            log.add({ type: 'attack:body', bytes: body.byteLength, totalBodyBytes, accepted })
            if (count < repetitions) attackTimer = ownership.setTimeout('yamux-partial-body', sendPartial, intervalMs)
          } catch (error) { if (!log.cleaning && secured.status === 'open') log.errors.push(error) }
        }
        secured.addEventListener('close', () => {
          if (attackTimer) ownership.clearTimeout(attackTimer)
          attackTimer = undefined
        }, { once: true })
        // The header and first bounded body fragment may share a Noise record;
        // subsequent fragments keep an unpatched receiver waiting for its body.
        sendPartial()
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
