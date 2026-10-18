import { withBitswap, type WantOperation } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import type { Multiaddr } from '@multiformats/multiaddr'
import { createHeliaLight } from 'helia'
import type { CID } from 'multiformats/cid'
import { GalleryDomainError } from '../shared/errors'
import { directBudget } from './direct-budget'
import { DirectCleanupError } from './direct-errors'
import { createBudgetedWebSockets } from './direct-websockets'
import { checkSignal, networkError } from './errors'
import { BoundedDatastore, NonRetainingBlockstore } from './ipfs-stores'
import { providerGater, publicProviderAddress, type ProviderAddressPolicy, type ProviderCandidate } from './provider-policy'

export interface DirectTransport {
  retrieve(cid: CID, provider: ProviderCandidate, address: Multiaddr, signal: AbortSignal): Promise<Uint8Array>
  dispose(): void
  settled?(): Promise<void>
}

export { DirectCleanupError } from './direct-errors'

export const BITSWAP_LIMITS = Object.freeze({ messageBytes: 4 * 1024 * 1024, blockBytes: 2 * 1024 * 1024, frameBytes: 1024 * 1024 })
const noDNS = { async query(): Promise<never> { throw networkError('UNSUPPORTED', '不允许应用层 DNS 查询。') } }

interface RetrievalBroker {
  name: string
  retrieveOperation(cid: CID, options: { providers: Multiaddr[]; signal: AbortSignal; maxSize: number }): WantOperation<Uint8Array>
}

/** Uses only the ordinary Bitswap broker, never Helia's session/cache race. */
export function createDirectTransport(policy: ProviderAddressPolicy = publicProviderAddress): DirectTransport {
  const allowed = new Map<string, Set<string>>()
  const peerLeases = new Map<string, () => void>()
  const admissionErrors = new Map<string, GalleryDomainError>()
  const socketClosures = new Set<Promise<void>>()
  const dialWork = new Map<string, Set<Promise<void>>>()
  const pending = new Set<Promise<void>>()
  const connecting = new Map<string, { controller: AbortController; consumers: Set<symbol>; ready: Promise<void> }>()
  const store = new BoundedDatastore()
  const gater = providerGater(allowed, policy)
  const shutdown = new AbortController()
  let users = 0
  let disposed = false
  let startup: ReturnType<typeof start> | undefined
  let stopping: Promise<void> | undefined
  let cleanupFailure: DirectCleanupError | undefined

  const transport = createBudgetedWebSockets(
    async address => !await gater.denyDialMultiaddr!(address),
    (address, error) => {
      const id = address.getComponents().find(part => part.name === 'p2p')?.value
      if (id) admissionErrors.set(id, error)
    }, socketClosures, dialWork,
  )

  async function waitForSockets(): Promise<void> {
    const sockets = await Promise.allSettled([...socketClosures, ...[...dialWork.values()].flatMap(work => [...work])])
    if (sockets.some(result => result.status === 'rejected')) cleanupFailure ??= new DirectCleanupError()
    if (cleanupFailure) throw cleanupFailure
  }

  async function waitForDials(address: Multiaddr): Promise<void> {
    const outcomes = await Promise.allSettled([...(dialWork.get(address.toString()) ?? [])])
    if (outcomes.some(result => result.status === 'rejected')) cleanupFailure ??= new DirectCleanupError()
    if (cleanupFailure) throw cleanupFailure
  }

  async function stopNode(node: Awaited<ReturnType<typeof start>>['node']): Promise<void> {
    try { await node.stop() } catch {
      cleanupFailure ??= new DirectCleanupError()
    }
    await waitForSockets()
  }

  async function start() {
    const node = withBitswap(withLibp2pLight(createHeliaLight({
      // This datastore is binding-owned. Select local Mortice ownership before
      // libp2p creates peer-store locks in the same Service Worker realm.
      blockstore: new NonRetainingBlockstore(), datastore: store, routers: [], dns: noDNS, holdGcLock: true,
    }), {
      addresses: { listen: [], announce: [] },
      transports: [transport], connectionEncrypters: [noise()],
      streamMuxers: [yamux({
        enableKeepAlive: false, maxInboundStreams: 8, maxOutboundStreams: 8,
        maxIncomingFrameDataLength: BITSWAP_LIMITS.frameBytes,
        streamOptions: {
          initialStreamWindowSize: 256 * 1024, maxStreamWindowSize: BITSWAP_LIMITS.frameBytes,
          maxReadBufferLength: BITSWAP_LIMITS.messageBytes, maxWriteBufferLength: BITSWAP_LIMITS.messageBytes,
        },
      })],
      services: { identify: identify({ maxMessageSize: 8192, maxObservedAddresses: 4, runOnConnectionOpen: false }) },
      peerDiscovery: [], peerRouters: [], contentRouters: [], dns: noDNS,
      connectionGater: gater, connectionMonitor: { enabled: false },
      connectionManager: {
        maxConnections: 6, maxParallelDials: 2, maxDialQueueLength: 2, maxPeerAddrsToDial: 1,
        resolvers: {}, reconnectRetries: 0, maxIncomingPendingConnections: 0,
        dialTimeout: 5000, addressDialTimeout: 5000,
      },
    }), {
      maxIncomingMessageSize: BITSWAP_LIMITS.messageBytes, maxOutgoingMessageSize: BITSWAP_LIMITS.messageBytes,
      maxInboundStreams: 6, maxOutboundStreams: 6, maxWantlistSize: 32,
      messageSendConcurrency: 2, sendBlocksMaxQueueLength: 2,
      messageSendTimeout: 5000, messageReceiveTimeout: 10000, incomingStreamTimeout: 10000,
    })
    try {
      await node.start()
      // withBitswap installs the ordinary broker during start; Helia exposes no
      // separate public retrieve handle. Keep this installed-package seam narrow.
      const broker = (node as unknown as { blockBrokers: RetrievalBroker[] }).blockBrokers.find(broker => broker.name === 'bitswap')
      if (!broker || typeof broker.retrieveOperation !== 'function') throw networkError('UNSUPPORTED', 'Bitswap broker 不可用。')
      return { node, broker }
    } catch (error) {
      await stopNode(node)
      store.clear()
      throw error
    }
  }

  async function stopIdle(): Promise<void> {
    if (users !== 0 || !startup) return
    const current = startup
    stopping ??= (async () => {
      const runtime = await current.catch(() => undefined)
      if (runtime) await stopNode(runtime.node)
      else await waitForSockets()
      if (cleanupFailure) throw cleanupFailure
      store.clear()
      allowed.clear()
      admissionErrors.clear()
      connecting.clear()
      for (const release of peerLeases.values()) release()
      peerLeases.clear()
      if (startup === current) startup = undefined
    })().finally(() => { stopping = undefined })
    await stopping
  }

  async function retrieve(cid: CID, provider: ProviderCandidate, address: Multiaddr, signal: AbortSignal): Promise<Uint8Array> {
      if (cleanupFailure) throw cleanupFailure
      if (disposed) throw networkError('CANCELLED', '传输已释放。')
      checkSignal(signal)
      const safe = policy(address, provider.id)
      if (safe?.kind !== 'wss') throw networkError('NETWORK', '候选不支持安全 WSS。')
      if (stopping) await stopping
      checkSignal(signal)
      checkSignal(shutdown.signal)
      const id = provider.id.toString()
      if (!peerLeases.has(id)) peerLeases.set(id, directBudget.acquire('peer'))
      const addresses = allowed.get(id) ?? new Set<string>()
      if (!addresses.has(safe.address.toString()) && addresses.size >= 4) throw networkError('NETWORK', 'Peer 地址候选已满。')
      addresses.add(safe.address.toString())
      allowed.set(id, addresses)
      users++
      try {
        const runtime = await (startup ??= start())
        const operationSignal = AbortSignal.any([signal, shutdown.signal])
        checkSignal(operationSignal)
        await runtime.node.libp2p.peerStore.merge(provider.id, { multiaddrs: [safe.address] })
        let setup = connecting.get(id)
        if (!setup) {
          const controller = new AbortController()
          const setupSignal = AbortSignal.any([controller.signal, shutdown.signal])
          const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', 'Provider 拨号期限已到。')), 5000)
          const current = {
            controller, consumers: new Set<symbol>(),
            ready: (async () => {
              try {
                const connection = await runtime.node.libp2p.dial(safe.address, { signal: setupSignal })
                await waitForDials(safe.address)
                connection.addEventListener('close', () => {
                  if (connecting.get(id)?.controller === controller) connecting.delete(id)
                }, { once: true })
                await runtime.node.libp2p.services.identify.identify(connection, { signal: setupSignal })
              } catch (error) {
                controller.abort(error)
                await waitForDials(safe.address)
                throw error
              }
            })().finally(() => clearTimeout(timer)),
          }
          setup = current
          connecting.set(id, current)
          void current.ready.catch(() => { if (connecting.get(id) === current) connecting.delete(id) })
        }
        const consumer = Symbol()
        setup.consumers.add(consumer)
        const release = () => {
          setup.consumers.delete(consumer)
          if (setup.consumers.size === 0) setup.controller.abort(networkError('CANCELLED', '所有拨号消费者均已释放。'))
        }
        operationSignal.addEventListener('abort', release, { once: true })
        try {
          if (operationSignal.aborted) release()
          await setup.ready
        } finally {
          operationSignal.removeEventListener('abort', release)
          release()
        }
        checkSignal(operationSignal)
        const operation = runtime.broker.retrieveOperation(cid, {
          providers: [safe.address], signal: operationSignal, maxSize: BITSWAP_LIMITS.blockBytes,
        })
        const [result] = await Promise.allSettled([operation.result])
        try { await operation.settled } catch {
          cleanupFailure ??= new DirectCleanupError()
          throw cleanupFailure
        }
        if (result.status === 'rejected') throw result.reason
        const bytes = result.value
        if (bytes.byteLength > BITSWAP_LIMITS.blockBytes) throw networkError('NETWORK', '候选超过 Bitswap 互操作块上限。')
        return bytes.slice()
      } catch (error) {
        if (error instanceof DirectCleanupError) throw error
        // libp2p may wrap transport errors in an aggregate. An internal resource
        // admission failure must not become a candidate NETWORK fallback.
        throw admissionErrors.get(id) ?? error
      } finally {
        users--
        await stopIdle()
      }
  }

  return {
    retrieve(cid, provider, address, signal) {
      const result = retrieve(cid, provider, address, signal)
      const cleanup = result.then(() => {}, error => { if (error instanceof DirectCleanupError) throw error })
      pending.add(cleanup)
      void cleanup.then(() => pending.delete(cleanup), () => pending.delete(cleanup))
      return result
    },
    async settled() {
      // Operation snapshots include each request's want and lower dial cleanup.
      // Shared live sockets belong to the node until its final owner exits.
      const outcomes = await Promise.allSettled([...pending])
      if (cleanupFailure) throw cleanupFailure
      const failure = outcomes.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
    dispose() {
      if (disposed) return
      disposed = true
      shutdown.abort(networkError('CANCELLED', '传输已释放。'))
      // Active retrieval finally blocks own shutdown settlement and its budget.
    },
  }
}
