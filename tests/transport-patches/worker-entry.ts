/// <reference lib="webworker" />
import { BitswapBlockBroker } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { webSockets, type WebSocketMultiaddrConnection } from '@libp2p/websockets'
import { yamux, type FrameHeader } from '@libp2p/yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'

declare const self: ServiceWorkerGlobalScope
type MuxerFactory = ReturnType<ReturnType<typeof yamux>>
type Muxer = ReturnType<MuxerFactory['createStreamMuxer']>
interface ObservedMuxer {
  readonly decoder: { readonly buffer: Uint8Array; readonly bufferedLength: number }
  onData: Muxer['onData']
  handleFrame(frame: { readonly header: FrameHeader }): void
}

const rawConnections = new Map<number, WebSocketMultiaddrConnection>()
let socketId = 0
let closedSockets = 0
const muxers: ObservedMuxer[] = []
let peakDecoderBacking = 0
let decodedDataFrames = 0
let decodedDataBytes = 0
let rejectedInputs = 0
let activeDials = 0
let activeFlights = 0
const operations = new Map<string, { controller: AbortController; result: Promise<unknown>; settled: Promise<void> }>()

function sample() {
  for (const muxer of muxers) peakDecoderBacking = Math.max(peakDecoderBacking, muxer.decoder.buffer.buffer.byteLength)
}
const transport = webSockets({
  onConnection(connection) {
    const id = ++socketId
    rawConnections.set(id, connection)
    void connection.closed.then(() => { rawConnections.delete(id); closedSockets++ })
  },
})
const observedYamux: ReturnType<typeof yamux> = () => {
  const factory = yamux({
    enableKeepAlive: false, maxIncomingFrameDataLength: 1024 * 1024,
    streamOptions: {
      initialStreamWindowSize: 256 * 1024, maxStreamWindowSize: 1024 * 1024,
      maxReadBufferLength: 4 * 1024 * 1024, maxWriteBufferLength: 4 * 1024 * 1024,
    },
  })()
  const create = factory.createStreamMuxer.bind(factory)
  factory.createStreamMuxer = connection => {
    const muxer = create(connection)
    const observed = muxer as unknown as ObservedMuxer
    muxers.push(observed)
    const onData = observed.onData.bind(observed)
    const handleFrame = observed.handleFrame.bind(observed)
    // Observe the actual patched decoder without changing bytes or error flow.
    observed.onData = data => {
      sample()
      try { onData(data) } catch (error) { rejectedInputs++; throw error } finally { sample() }
    }
    observed.handleFrame = frame => {
      if (frame.header.type === 0) { decodedDataFrames++; decodedDataBytes += frame.header.length }
      handleFrame(frame)
    }
    return muxer
  }
  return factory
}
const node = withLibp2pLight(createHeliaLight({ routers: [] }), {
  addresses: { listen: [] }, peerDiscovery: [],
  transports: [transport], connectionEncrypters: [noise()], streamMuxers: [observedYamux],
  services: { identify: identify() },
})
let broker: BitswapBlockBroker | undefined
let initialization: Promise<void> | undefined
function initialize() {
  return initialization ??= (async () => {
    await node.start()
    broker = new BitswapBlockBroker(node, { maxIncomingMessageSize: 4 * 1024 * 1024, maxOutgoingMessageSize: 4 * 1024 * 1024 })
    await broker.start()
  })()
}
function snapshot() {
  sample()
  return {
    activeDials, activeFlights, liveSockets: rawConnections.size, closedSockets,
    peakDecoderBacking, rejectedInputs, decodedDataFrames, decodedDataBytes,
    decoderRetainedBytes: muxers.map(muxer => muxer.decoder.bufferedLength),
    connections: broker?.isStarted() === true ? node.libp2p.getConnections().length : 0,
  }
}

async function command(data: { command: string; id?: string; address?: string; cid?: string; raw?: boolean }) {
  await initialize()
  const id = data.id ?? ''
  if (data.command === 'snapshot' || data.command === 'initialize') return snapshot()
  if (data.command === 'dial') {
    const controller = new AbortController()
    activeDials++
    let dialing: Promise<unknown>
    if (data.raw) {
      type Transport = ReturnType<typeof transport>
      type Components = Parameters<typeof transport>[0]
      type Upgrader = Parameters<Transport['dial']>[1]['upgrader']
      const components = (node.libp2p as unknown as { components: Components & { upgrader: Upgrader } }).components
      dialing = transport(components).dial(multiaddr(data.address!), { signal: controller.signal, upgrader: components.upgrader })
    } else {
      dialing = node.libp2p.dial(multiaddr(data.address!), { signal: controller.signal })
    }
    const result = dialing.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: String(error) }))
    const settled = result.then(() => { activeDials-- })
    operations.set(id, { controller, result, settled })
    return snapshot()
  }
  if (data.command === 'abort') {
    operations.get(id)!.controller.abort(new Error('Browser fixture cancellation'))
    return snapshot()
  }
  if (data.command === 'result') return operations.get(id)!.result
  if (data.command === 'settled') {
    await operations.get(id)!.settled
    return snapshot()
  }
  if (data.command === 'read') {
    const controller = new AbortController()
    activeFlights++
    const operation = broker!.retrieveOperation(CID.parse(data.cid!), { signal: controller.signal })
    const result = operation.result.then(bytes => ({ bytes: Uint8Array.from(bytes) }), (error: unknown) => ({ error: String(error) }))
    const settled = operation.settled.finally(() => { activeFlights-- })
    void settled.catch(() => {})
    operations.set(id, { controller, result, settled })
    return snapshot()
  }
  if (data.command === 'stop') {
    for (const operation of operations.values()) operation.controller.abort()
    await Promise.allSettled([...operations.values()].map(operation => operation.settled))
    await broker!.stop()
    await node.stop()
    await Promise.all([...rawConnections.values()].map(connection => connection.closed))
    return snapshot()
  }
  throw new Error('Unknown fixture command')
}

self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()) })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', event => {
  const port = event.ports[0]
  if (!port) return
  event.waitUntil((async () => {
    try {
      const value = event.data === 'construct-transport'
        ? (await initialize(), { operationAPI: typeof broker!.retrieveOperation === 'function', started: broker!.isStarted() })
        : await command(event.data)
      if (typeof value === 'object' && value !== null && 'bytes' in value && value.bytes instanceof Uint8Array) port.postMessage({ value }, [value.bytes.buffer])
      else port.postMessage({ value })
    } catch (error) { port.postMessage({ error: String(error) }) }
  })())
})
