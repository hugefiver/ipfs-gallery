import type { ServerOptions } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { withBitswap } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import type { Connection, PeerId, Stream } from '@libp2p/interface'
import { noise } from '@libp2p/noise'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'
import { loadIpfsProviderWire, type ProviderWireMessage } from './ipfs-provider-wire'

export const IPFS_PROVIDER_MAX_BLOCK_BYTES = 2 * 1024 * 1024
export const IPFS_PROVIDER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024

export type IpfsProviderMode =
  | { kind: 'correct' }
  | { kind: 'pause' }
  | { kind: 'drop' }
  | { kind: 'corrupt' }
  | { kind: 'delay'; milliseconds: number }

export type IpfsProviderRecord =
  | { type: 'want' | 'cancel'; peerId: string; cid: string; wantType?: string | number; at: number }
  | { type: 'sent' | 'received'; peerId: string; wants: Array<{ cid: string; cancel: boolean }>; blocks: Array<{ prefix: Uint8Array; data: Uint8Array }>; payloadBytes: number; encodedBytes?: number; at: number }
  | { type: 'connection:open' | 'connection:close'; peerId: string; direction: string; address: string; at: number }
  | { type: 'store:read'; cid: string; mode: IpfsProviderMode['kind']; at: number }
  | { type: 'store:has'; cid: string; mode: IpfsProviderMode['kind']; present: boolean; at: number }

export interface IpfsProviderOptions {
  tls: Pick<ServerOptions, 'key' | 'cert'>
  publicHost?: string
  publicPort?: number
  mode?: IpfsProviderMode
}

export interface IpfsProvider {
  peerId: PeerId
  localAddress: Multiaddr
  localTarget: { host: '127.0.0.1'; port: number }
  publicAddress(host?: string, port?: number): Multiaddr
  records: IpfsProviderRecord[]
  instrumentationErrors: unknown[]
  setMode(mode: IpfsProviderMode): void
  setBlockMode(cid: CID | string, mode: IpfsProviderMode | undefined): void
  /** Releases current paused reads; subsequent reads still follow their configured mode. */
  release(cid?: CID | string): void
  waitForRecord(predicate: (record: IpfsProviderRecord) => boolean, timeoutMs?: number): Promise<IpfsProviderRecord>
  /** Single-peer upload probe; rejects if other peers are connected. Bypasses the local blockstore. */
  requestBlockFromPeer(cid: CID, peer: PeerId | Multiaddr, signal: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}

// Test-only observation of the installed @helia/bitswap implementation. Neither
// its encoder, decoder, stream handler nor protocol negotiation is replaced.
interface ObservedBroker {
  name: string
  retrieve(cid: CID, options: { providers: Array<PeerId | Multiaddr>; signal: AbortSignal }): Promise<Uint8Array>
  bitswap: { network: EventTarget }
}

const canonical = (cid: CID | string) => (typeof cid === 'string' ? CID.parse(cid) : cid).toV1().toString()

function checkMode(mode: IpfsProviderMode): void {
  if (mode.kind === 'delay' && (!Number.isFinite(mode.milliseconds) || mode.milliseconds < 0)) {
    throw new Error('Provider delay must be finite and nonnegative')
  }
}

/** Serves fixture blocks over real Noise/Yamux/WSS and official Bitswap 1.2. */
export async function startIpfsProvider(
  blocks: Iterable<readonly [CID | string, Uint8Array | { bytes: Uint8Array }]>,
  options: IpfsProviderOptions,
): Promise<IpfsProvider> {
  let mode = options.mode ?? { kind: 'correct' }
  checkMode(mode)
  const blockModes = new Map<string, IpfsProviderMode>()
  const records: IpfsProviderRecord[] = []
  const instrumentationErrors: unknown[] = []
  const observers = new Set<(record: IpfsProviderRecord) => void>()
  const shutdown = new AbortController()
  const paused = new Set<{ cid: string; release(): void }>()
  const record = (value: IpfsProviderRecord) => {
    records.push(value)
    for (const observer of observers) observer(value)
  }
  const selectedMode = (cid: CID) => blockModes.get(canonical(cid)) ?? mode
  class ProviderStore extends MemoryBlockstore {
    override async has(cid: CID, hasOptions?: Parameters<MemoryBlockstore['has']>[1]) {
      const selected = selectedMode(cid)
      const present = selected.kind === 'drop' ? false : await super.has(cid, hasOptions)
      record({ type: 'store:has', cid: canonical(cid), mode: selected.kind, present, at: Date.now() })
      return present
    }

    override async *get(cid: CID, getOptions?: Parameters<MemoryBlockstore['get']>[1]) {
      const selected = selectedMode(cid)
      const key = canonical(cid)
      const signal = getOptions?.signal ? AbortSignal.any([shutdown.signal, getOptions.signal]) : shutdown.signal
      signal.throwIfAborted()
      record({ type: 'store:read', cid: key, mode: selected.kind, at: Date.now() })
      if (selected.kind === 'pause') {
        await new Promise<void>((resolve, reject) => {
          const entry = { cid: key, release: () => finish() }
          const abort = () => finish(signal.reason)
          const finish = (error?: unknown) => {
            paused.delete(entry)
            signal.removeEventListener('abort', abort)
            if (error !== undefined) reject(error)
            else resolve()
          }
          paused.add(entry)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
      if (selected.kind === 'delay') await delay(selected.milliseconds, undefined, { signal })
      for await (const part of super.get(cid, { signal })) {
        const bytes = part.slice()
        if (selected.kind === 'corrupt') {
          if (bytes.length === 0) yield Uint8Array.of(0xff)
          else { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; yield bytes }
        } else yield bytes
      }
    }
  }
  const store = new ProviderStore()
  for (const [key, value] of blocks) {
    const bytes = value instanceof Uint8Array ? value : value.bytes
    if (bytes.byteLength > IPFS_PROVIDER_MAX_BLOCK_BYTES) throw new Error('Fixture Bitswap blocks must not exceed 2 MiB')
    await store.put(typeof key === 'string' ? CID.parse(key) : key, bytes.slice())
  }

  // Resolve the official decoder and framing library beside the installed
  // Bitswap package; they are instrumentation only, not an alternate protocol.
  const { BitswapMessage, framing } = await loadIpfsProviderWire()
  const helia = withBitswap(withLibp2pLight(createHeliaLight({ blockstore: store, routers: [] }), {
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0/wss'] },
    transports: [webSockets({ https: options.tls, maxBufferedAmount: IPFS_PROVIDER_MAX_MESSAGE_BYTES })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux({
      enableKeepAlive: false, maxInboundStreams: 32, maxOutboundStreams: 32,
      streamOptions: { maxReadBufferLength: IPFS_PROVIDER_MAX_MESSAGE_BYTES, maxWriteBufferLength: IPFS_PROVIDER_MAX_MESSAGE_BYTES },
    })],
    services: { identify: identify() },
    peerDiscovery: [],
    // Fresh production peers retrieve successive children through one loopback host.
    connectionManager: { maxConnections: 16, inboundConnectionThreshold: 64 },
  }), {
    maxIncomingMessageSize: IPFS_PROVIDER_MAX_MESSAGE_BYTES,
    maxOutgoingMessageSize: IPFS_PROVIDER_MAX_MESSAGE_BYTES,
    maxWantlistSize: 256,
    maxInboundStreams: 16,
    maxOutboundStreams: 16,
    sendBlocksMaxQueueLength: 32,
  })
  try {
    await helia.start()
  } catch (error) {
    shutdown.abort()
    await helia.stop()
    throw error
  }
  const node = helia.libp2p
  const connectionRecord = (type: 'connection:open' | 'connection:close', connection: Connection) => record({
    type, peerId: connection.remotePeer.toString(), direction: connection.direction,
    address: connection.remoteAddr.toString(), at: Date.now(),
  })
  // dialProtocol may delegate to a wrapped connection.newStream.
  const observedStreams = new WeakSet<Stream>()
  function observeStream<S extends Stream>(stream: S, peerId: string): S {
    if (stream.protocol === '/ipfs/bitswap/1.2.0' && !observedStreams.has(stream)) {
      observedStreams.add(stream)
      const send = stream.send.bind(stream)
      stream.send = (data: Parameters<Stream['send']>[0]) => {
        const accepted = send(data)
        try {
          const bytes = data instanceof Uint8Array ? data : data.subarray()
          for (const frame of framing.decode([bytes], { maxDataLength: IPFS_PROVIDER_MAX_MESSAGE_BYTES })) {
            const message = BitswapMessage.decode(frame.subarray())
            record({
              type: 'sent', peerId, at: Date.now(), encodedBytes: frame.byteLength,
              wants: (message.wantlist?.entries ?? []).map(entry => ({ cid: canonical(CID.decode(entry.cid)), cancel: entry.cancel === true })),
              blocks: message.blocks.map(block => ({ prefix: block.prefix.slice(), data: block.data.slice() })),
              payloadBytes: message.blocks.reduce((sum, block) => sum + block.data.byteLength, 0),
            })
          }
        } catch (error) { instrumentationErrors.push(error) }
        return accepted
      }
    }
    return stream
  }
  node.addEventListener('connection:open', event => {
    const connection = event.detail
    connectionRecord('connection:open', connection)
    const newStream = connection.newStream.bind(connection)
    connection.newStream = async (...args: Parameters<typeof connection.newStream>) =>
      observeStream(await newStream(...args), connection.remotePeer.toString())
  })
  node.addEventListener('connection:close', event => connectionRecord('connection:close', event.detail))
  const dialProtocol = node.dialProtocol.bind(node)
  node.dialProtocol = async (...args: Parameters<typeof node.dialProtocol>) =>
    observeStream(await dialProtocol(...args), args[0].toString())
  let broker: ObservedBroker
  try {
    broker = (helia as unknown as { blockBrokers: ObservedBroker[] }).blockBrokers.find(value => value.name === 'bitswap')!
    if (!broker?.bitswap?.network) throw new Error('Installed Bitswap observation interface is unavailable')
    broker.bitswap.network.addEventListener('bitswap:message', event => {
      const { peer, message } = (event as CustomEvent<{ peer: PeerId; message: ProviderWireMessage }>).detail
      for (const entry of message.wantlist?.entries ?? []) record({
        type: entry.cancel ? 'cancel' : 'want', cid: canonical(CID.decode(entry.cid)),
        peerId: peer.toString(), wantType: entry.wantType, at: Date.now(),
      })
      record({
        type: 'received', peerId: peer.toString(), at: Date.now(),
        wants: (message.wantlist?.entries ?? []).map(entry => ({ cid: canonical(CID.decode(entry.cid)), cancel: entry.cancel === true })),
        blocks: message.blocks.map(block => ({ prefix: block.prefix.slice(), data: block.data.slice() })),
        payloadBytes: message.blocks.reduce((sum, block) => sum + block.data.byteLength, 0),
      })
    })
  } catch (error) {
    shutdown.abort()
    await helia.stop()
    throw error
  }
  const localAddress = node.getMultiaddrs().find(address => {
    const protocols = address.getComponents().map(component => component.name)
    return protocols.includes('wss') || (protocols.includes('tls') && protocols.includes('ws'))
  })
  if (!localAddress) {
    const addresses = node.getMultiaddrs().map(String).join(', ')
    await helia.stop()
    throw new Error(`No WSS fixture listener: ${addresses}`)
  }
  const port = Number(localAddress.getComponents().find(component => component.name === 'tcp')!.value)
  let closing: Promise<void> | undefined
  return {
    peerId: node.peerId, localAddress, localTarget: { host: '127.0.0.1', port }, records, instrumentationErrors,
    publicAddress(host = options.publicHost ?? 'bitswap.example.com', publicPort = options.publicPort ?? 443) {
      if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
        throw new Error('Invalid advertised provider endpoint')
      }
      return multiaddr(`/dns4/${host}/tcp/${publicPort}/wss/p2p/${node.peerId}`)
    },
    setMode(value) { checkMode(value); mode = value },
    setBlockMode(cid, value) {
      if (value) { checkMode(value); blockModes.set(canonical(cid), value) }
      else blockModes.delete(canonical(cid))
    },
    release(cid) {
      for (const entry of paused) if (cid === undefined || entry.cid === canonical(cid)) entry.release()
    },
    waitForRecord(predicate, timeoutMs = 5000) {
      const found = records.find(predicate)
      if (found) return Promise.resolve(found)
      if (shutdown.signal.aborted) return Promise.reject(new Error('Provider is closed'))
      return new Promise((resolve, reject) => {
        const finish = (value?: IpfsProviderRecord, error?: Error) => {
          clearTimeout(timer)
          observers.delete(observer)
          shutdown.signal.removeEventListener('abort', abort)
          if (value) resolve(value)
          else reject(error)
        }
        const observer = (value: IpfsProviderRecord) => { if (predicate(value)) finish(value) }
        const abort = () => finish(undefined, new Error('Provider is closed'))
        const timer = setTimeout(() => finish(undefined, new Error('Provider record timed out')), timeoutMs)
        observers.add(observer)
        shutdown.signal.addEventListener('abort', abort, { once: true })
      })
    },
    requestBlockFromPeer(cid, peer, signal) {
      const peerId = 'getComponents' in peer
        ? peer.getComponents().find(component => component.name === 'p2p')?.value
        : peer.toString()
      if (!peerId || node.getConnections().some(connection => connection.remotePeer.toString() !== peerId)) {
        return Promise.reject(new Error('Upload probe requires exactly the selected fixture peer'))
      }
      return broker.retrieve(cid, { providers: [peer], signal: AbortSignal.any([signal, shutdown.signal]) })
    },
    close() {
      closing ??= (async () => { shutdown.abort(new Error('Provider closed')); await helia.stop() })()
      return closing
    },
  }
}
