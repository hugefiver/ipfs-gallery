import { afterEach, describe, expect, it, vi } from 'vitest'
import { BitswapBlockBroker, type WantOperation } from '@helia/bitswap'
import { peerIdFromString } from '@libp2p/peer-id'
import type { PeerUpdate } from '@libp2p/interface'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { loadIpfsProviderWire } from '../support/ipfs-provider-wire'

const peer = peerIdFromString('12D3KooWSmLsawGAMTyxaEGxgtG5eg42qMMhe6eBUPfS1nHBCU3m')
const cleanups: Array<() => Promise<void>> = []
type Libp2p = ConstructorParameters<typeof BitswapBlockBroker>[0]['libp2p']
type Connection = ReturnType<Libp2p['getConnections']>[number]
type Stream = Awaited<ReturnType<Connection['newStream']>>
type Topology = Parameters<Libp2p['register']>[1]
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(text: string) {
  const bytes = new TextEncoder().encode(text)
  return { cid: CID.createV1(0x55, await sha256.digest(bytes)), bytes }
}

async function harness() {
  const helia = createHeliaLight({ routers: [] })
  const wire = await loadIpfsProviderWire()
  const records: Array<{ cid: string; cancel: boolean }> = []
  const operations: WantOperation<Uint8Array>[] = []
  let topology: Topology | undefined
  let connected = true
  let sendHook: (() => void) | undefined
  let closeHook: (() => Promise<void>) | undefined
  const stream = {
    closeRead: vi.fn(async () => {}),
    send: vi.fn((data: Uint8Array | { subarray(): Uint8Array }) => {
      const bytes = data instanceof Uint8Array ? data : data.subarray()
      for (const part of wire.framing.decode([bytes], { maxDataLength: 4 * 1024 * 1024 })) {
        const message = wire.BitswapMessage.decode(part.subarray())
        for (const entry of message.wantlist?.entries ?? []) records.push({ cid: CID.decode(entry.cid).toString(), cancel: entry.cancel === true })
      }
      sendHook?.()
      return true
    }),
    onDrain: vi.fn(async () => {}),
    close: vi.fn(async () => { await closeHook?.() }),
    abort: vi.fn(),
  }
  const closeConnection = vi.fn(async () => {
    connected = false
    connection.status = 'closed'
    connection.dispatchEvent(new Event('close'))
    topology?.onDisconnect?.(peer)
  })
  let connection = Object.assign(new EventTarget(), {
    remotePeer: peer, status: 'open',
    newStream: vi.fn(async () => stream as unknown as Stream),
    close: closeConnection,
    abort: vi.fn(),
  }) as unknown as Connection
  const node = Object.assign(new EventTarget(), {
    handle: vi.fn(async () => {}), unhandle: vi.fn(async () => {}),
    register: vi.fn(async (_protocol: string, value: Topology) => { topology = value; return 'topology' }),
    unregister: vi.fn(), getConnections: vi.fn(() => connected ? [connection] : []),
    dial: vi.fn(async () => connection), dialProtocol: vi.fn(async () => stream),
  }) as unknown as Libp2p
  const broker = new BitswapBlockBroker({
    libp2p: node, logger: helia.logger, blockstore: helia.blockstore,
    routing: helia.routing, getHasher: helia.getHasher.bind(helia),
  }, { sendWantlistDebounce: 1, messageSendTimeout: 1000, maxIncomingMessageSize: 4 * 1024 * 1024, maxOutgoingMessageSize: 4 * 1024 * 1024 })
  await broker.start()
  const network = (broker as unknown as { bitswap: { network: EventTarget } }).bitswap.network
  function deliver(block: Awaited<ReturnType<typeof fixture>>) {
    network.dispatchEvent(new CustomEvent('bitswap:message', { detail: {
      connection, peer,
      message: { blocks: [{ prefix: Uint8Array.of(1, 0x55, 0x12, 32), data: block.bytes }], blockPresences: [], pendingBytes: 0 },
    } }))
  }
  function retrieve(cid: CID, signal?: AbortSignal) {
    const op = broker.retrieveOperation(cid, { signal })
    void op.result.catch(() => {})
    void op.settled.catch(() => {})
    operations.push(op)
    return op
  }
  cleanups.push(async () => {
    sendHook = undefined
    closeHook = undefined
    for (const operation of operations) operation.cancel()
    connected = false
    connection.status = 'closed'
    connection.dispatchEvent(new Event('close'))
    topology?.onDisconnect?.(peer)
    await Promise.allSettled(operations.map(operation => operation.settled))
    await broker.stop()
  })
  return {
    records, broker, stream, node, get connection() { return connection }, retrieve, deliver, closeConnection,
    onSend: (hook?: () => void) => { sendHook = hook },
    onClose: (hook?: () => Promise<void>) => { closeHook = hook },
    disconnect: (notifyTopology = true, status: Connection['status'] = 'closed') => {
      connected = false
      connection.status = status
      connection.dispatchEvent(new Event('close'))
      if (notifyTopology) topology?.onDisconnect?.(peer)
    },
    protocolUnavailable: (notifyTopology = true) => {
      const previous = { id: peer, addresses: [], protocols: ['/ipfs/bitswap/1.2.0'], metadata: new Map(), tags: new Map() }
      const detail: PeerUpdate = { previous, peer: { ...previous, protocols: [] } }
      node.dispatchEvent(new CustomEvent('peer:update', { detail }))
      if (notifyTopology) topology?.onDisconnect?.(peer)
    },
    lateTopologyDisconnect: () => { topology?.onDisconnect?.(peer) },
    reconnect: () => {
      connected = true
      connection = Object.assign(new EventTarget(), {
        remotePeer: peer, status: 'open',
        newStream: vi.fn(async () => stream as unknown as Stream),
        close: closeConnection, abort: vi.fn(),
      }) as unknown as Connection
      topology?.onConnect?.(peer, connection)
    },
    routing: helia.routing,
  }
}

describe('published Bitswap broker ownership', () => {
  it('rejects an encoded message larger than 4 MiB from its length prefix before any body', async () => {
    const h = await harness()
    const inbound = Object.assign(new EventTarget(), {
      close: vi.fn(async () => {}), abort: vi.fn(), protocol: '/ipfs/bitswap/1.2.0', id: 'inbound',
    })
    const handler = vi.mocked(h.node.handle).mock.calls[0]![1]
    await handler(inbound as unknown as Stream, h.connection)
    inbound.dispatchEvent(Object.assign(new Event('message'), { data: Uint8Array.of(0x81, 0x80, 0x80, 0x02) }))
    await vi.waitFor(() => expect(inbound.abort).toHaveBeenCalledOnce())
    expect(h.records).toEqual([])
  })

  it('pre-abort sends neither want nor cancel and does not discover', async () => {
    const h = await harness()
    const block = await fixture('pre-abort')
    const find = vi.spyOn(h.routing, 'findProviders')
    const controller = new AbortController()
    controller.abort()
    const op = h.retrieve(block.cid, controller.signal)
    await expect(op.result).rejects.toThrow()
    await op.settled
    expect(h.records).toEqual([])
    expect(find).not.toHaveBeenCalled()
    expect(h.node.dial).not.toHaveBeenCalled()
  })

  it('installs listeners before an immediate response and flushes the success cancel', async () => {
    const h = await harness()
    const block = await fixture('immediate')
    h.onSend(() => h.deliver(block))
    const op = h.retrieve(block.cid)
    expect(await op.result).toEqual(block.bytes)
    await op.settled
    expect(h.records).toEqual([{ cid: block.cid.toString(), cancel: false }, { cid: block.cid.toString(), cancel: true }])
  })

  it('cancels unsent work without opening a stream', async () => {
    const h = await harness()
    const block = await fixture('unsent')
    const op = h.retrieve(block.cid)
    op.cancel()
    await expect(op.result).rejects.toThrow()
    await op.settled
    expect(h.records).toEqual([])
    expect(h.connection.newStream).not.toHaveBeenCalled()
  })

  it('propagates failed want sends and waits for the failed peer to exit', async () => {
    const h = await harness()
    const block = await fixture('failed send')
    h.onSend(() => { throw new Error('wire rejected') })
    h.closeConnection.mockRejectedValue(new Error('graceful close failed'))
    const op = h.retrieve(block.cid)
    await expect(op.result).rejects.toThrow()
    await vi.waitFor(() => expect(h.closeConnection).toHaveBeenCalledOnce())
    expect(h.connection.abort).toHaveBeenCalledOnce()
    let settled = false
    void op.settled.then(() => { settled = true }, () => { settled = true })
    expect(settled).toBe(false)
    h.disconnect()
    await expect(op.settled).rejects.toThrow()
    expect(h.stream.abort).toHaveBeenCalled()
  })

  it('disconnect does not release a send executor that has not exited', async () => {
    const h = await harness()
    const block = await fixture('disconnect send')
    const barrier = Promise.withResolvers<void>()
    h.onClose(() => barrier.promise)
    const op = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    op.cancel()
    h.disconnect()
    await expect(op.result).rejects.toThrow()
    let settled = false
    void op.settled.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    barrier.resolve()
    await op.settled
  })

  it('last consumer owns cancellation; cancelling one leaves another live', async () => {
    const h = await harness()
    const block = await fixture('shared')
    const a = h.retrieve(block.cid)
    const b = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    a.cancel()
    await expect(a.result).rejects.toThrow()
    await a.settled
    expect(h.records).toHaveLength(1)
    h.deliver(block)
    expect(await b.result).toEqual(block.bytes)
    await b.settled
    expect(h.records.filter(r => r.cancel)).toHaveLength(1)
  })

  it('in-flight want and cancel flush barriers retain ownership, then re-want uses a new generation', async () => {
    const h = await harness()
    const block = await fixture('generation')
    const wantBarrier = Promise.withResolvers<void>()
    h.onClose(() => wantBarrier.promise)
    const a = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    a.cancel()
    await expect(a.result).rejects.toThrow()
    let settled = false
    void a.settled.then(() => { settled = true })
    const b = h.retrieve(block.cid)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    const cancelBarrier = Promise.withResolvers<void>()
    h.onClose(() => cancelBarrier.promise)
    wantBarrier.resolve()
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    expect(h.records[1]?.cancel).toBe(true)
    expect(settled).toBe(false)
    h.onClose()
    cancelBarrier.resolve()
    await a.settled
    await vi.waitFor(() => expect(h.records).toHaveLength(3))
    expect(h.records[2]?.cancel).toBe(false)
    h.deliver(block)
    expect(await b.result).toEqual(block.bytes)
    await b.settled
  })

  it('failed cancel drains the peer, preserves B, rejects new sends, and settles A only after actual disconnect', async () => {
    const h = await harness()
    const aBlock = await fixture('draining A')
    const bBlock = await fixture('draining B')
    const cBlock = await fixture('draining C')
    const a = h.retrieve(aBlock.cid)
    const b = h.retrieve(bBlock.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    h.onClose(async () => { throw new Error('send failure') })
    a.cancel()
    await expect(a.result).rejects.toThrow()
    let settled = false
    void a.settled.then(() => { settled = true }, () => { settled = true })
    await vi.waitFor(() => expect(h.stream.abort).toHaveBeenCalledTimes(2))
    const c = h.retrieve(cBlock.cid)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.records.some(r => r.cid === cBlock.cid.toString())).toBe(false)
    expect(settled).toBe(false)
    expect(h.closeConnection).not.toHaveBeenCalled()
    const closed = Promise.withResolvers<void>()
    h.closeConnection.mockImplementation(async () => { await closed.promise; h.disconnect() })
    h.deliver(bBlock)
    expect(await b.result).toEqual(bBlock.bytes)
    await vi.waitFor(() => expect(h.closeConnection).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    closed.resolve()
    await expect(a.settled).rejects.toThrow()
    await b.settled
    c.cancel()
    await expect(c.result).rejects.toThrow()
    await c.settled
  })

  it('protocol removal retains failed-cancel ownership while the connection and B remain live', async () => {
    const h = await harness()
    const aBlock = await fixture('protocol removal A')
    const bBlock = await fixture('protocol removal B')
    const cBlock = await fixture('protocol removal C')
    const a = h.retrieve(aBlock.cid)
    const b = h.retrieve(bBlock.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    h.onClose(async () => { throw new Error('cancel failed') })
    a.cancel()
    await expect(a.result).rejects.toThrow()
    await vi.waitFor(() => expect(h.stream.abort).toHaveBeenCalledTimes(2))
    let settled = false
    void a.settled.then(() => { settled = true }, () => { settled = true })
    h.protocolUnavailable()
    const c = h.retrieve(cBlock.cid)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(h.closeConnection).not.toHaveBeenCalled()
    expect(h.records.some(record => record.cid === cBlock.cid.toString())).toBe(false)
    h.deliver(bBlock)
    expect(await b.result).toEqual(bBlock.bytes)
    await expect(a.settled).rejects.toThrow()
    await b.settled
    c.cancel()
    await expect(c.result).rejects.toThrow()
    await c.settled
  })

  it.each(['open', 'closeRead'] as const)('a want paused at %s cannot send on a replacement connection', async stage => {
    const h = await harness()
    const block = await fixture(`replacement ${stage}`)
    const barrier = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const pause = async () => { entered.resolve(); await barrier.promise; return h.stream as unknown as Stream }
    vi.mocked(h.node.dialProtocol).mockImplementation(pause)
    vi.mocked(h.connection.newStream).mockImplementation(pause)
    if (stage === 'closeRead') {
      vi.mocked(h.node.dialProtocol).mockResolvedValue(h.stream as unknown as Stream)
      vi.mocked(h.connection.newStream).mockResolvedValue(h.stream as unknown as Stream)
      h.stream.closeRead.mockImplementation(async () => { entered.resolve(); await barrier.promise })
    }
    const op = h.retrieve(block.cid)
    await entered.promise
    op.cancel()
    await expect(op.result).rejects.toThrow()
    let settled = false
    void op.settled.then(() => { settled = true }, () => { settled = true })
    h.disconnect()
    h.reconnect()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    barrier.resolve()
    await op.settled
    expect(h.records).toEqual([])
    expect(h.node.dialProtocol).not.toHaveBeenCalled()
    expect(h.connection.newStream).not.toHaveBeenCalled()
    h.stream.closeRead.mockResolvedValue(undefined)
    const next = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toEqual([{ cid: block.cid.toString(), cancel: false }]))
    h.deliver(block)
    expect(await next.result).toEqual(block.bytes)
    await next.settled
    expect(h.records).toEqual([{ cid: block.cid.toString(), cancel: false }, { cid: block.cid.toString(), cancel: true }])
  })

  it('protocol removal permits cancel flush and a connection close settles without another topology callback', async () => {
    const h = await harness()
    const aBlock = await fixture('unavailable cancel A')
    const bBlock = await fixture('unavailable cancel B')
    const cBlock = await fixture('unavailable cancel C')
    const a = h.retrieve(aBlock.cid)
    const b = h.retrieve(bBlock.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    h.protocolUnavailable(false)
    const c = h.retrieve(cBlock.cid)
    const barrier = Promise.withResolvers<void>()
    h.onClose(() => barrier.promise)
    a.cancel()
    await expect(a.result).rejects.toThrow()
    await vi.waitFor(() => expect(h.records).toHaveLength(3))
    expect(h.records[2]).toEqual({ cid: aBlock.cid.toString(), cancel: true })
    let settled = false
    void a.settled.then(() => { settled = true })
    expect(settled).toBe(false)
    barrier.resolve()
    await a.settled
    expect(h.closeConnection).not.toHaveBeenCalled()
    h.disconnect(false, 'aborted')
    b.cancel()
    c.cancel()
    await expect(b.result).rejects.toThrow()
    await expect(c.result).rejects.toThrow()
    await Promise.all([b.settled, c.settled])
    expect(h.records).toHaveLength(3)
  })

  it('a delayed old topology disconnect cannot drain or close a healthy replacement connection', async () => {
    const h = await harness()
    const block = await fixture('delayed topology disconnect')
    h.disconnect(false)
    h.reconnect()
    h.lateTopologyDisconnect()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.closeConnection).not.toHaveBeenCalled()
    expect(h.connection.status).toBe('open')
    const op = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toEqual([{ cid: block.cid.toString(), cancel: false }]))
    h.deliver(block)
    expect(await op.result).toEqual(block.bytes)
    await op.settled
    expect(h.records).toEqual([{ cid: block.cid.toString(), cancel: false }, { cid: block.cid.toString(), cancel: true }])
    expect(h.closeConnection).not.toHaveBeenCalled()
  })

  it('new same-CID consumers cannot extend a draining generation while existing B continues', async () => {
    const h = await harness()
    const aBlock = await fixture('frozen A')
    const bBlock = await fixture('frozen B')
    const a = h.retrieve(aBlock.cid)
    const b = h.retrieve(bBlock.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    h.onClose(async () => { throw new Error('cancel failed') })
    a.cancel()
    await expect(a.result).rejects.toThrow()
    await vi.waitFor(() => expect(h.stream.abort).toHaveBeenCalledTimes(2))
    const b2 = h.retrieve(bBlock.cid)
    let b2Result: 'pending' | 'rejected' | 'resolved' = 'pending'
    void b2.result.then(() => { b2Result = 'resolved' }, () => { b2Result = 'rejected' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b2Result).toBe('rejected')
    await b2.settled
    expect(h.closeConnection).not.toHaveBeenCalled()
    h.deliver(bBlock)
    expect(await b.result).toEqual(bBlock.bytes)
    await expect(a.settled).rejects.toThrow()
    await b.settled
    expect(h.closeConnection).toHaveBeenCalledOnce()
  })

  it('a resolved graceful close does not settle cleanup before the connection exit event', async () => {
    const h = await harness()
    const block = await fixture('close completion')
    const op = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    h.onClose(async () => { throw new Error('cancel failed') })
    h.closeConnection.mockResolvedValue(undefined)
    op.cancel()
    await expect(op.result).rejects.toThrow()
    await vi.waitFor(() => expect(h.closeConnection).toHaveBeenCalledOnce())
    let settled = false
    void op.settled.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    h.disconnect(false, 'aborted')
    await expect(op.settled).rejects.toThrow()
  })

  it('result can resolve while findProviders still unwinds; settled waits for that task', async () => {
    const h = await harness()
    const block = await fixture('find cleanup')
    const exited = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    vi.spyOn(h.routing, 'findProviders').mockImplementation(async function* (_cid, options) {
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
      await exited.promise
      yield* []
    })
    const op = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    h.deliver(block)
    expect(await op.result).toEqual(block.bytes)
    await aborted.promise
    let settled = false
    void op.settled.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    exited.resolve()
    await op.settled
  })

  it('stop aborts consumers, flushes cancels and waits for send exit', async () => {
    const h = await harness()
    const block = await fixture('stop')
    const op = h.retrieve(block.cid)
    await vi.waitFor(() => expect(h.records).toHaveLength(1))
    const barrier = Promise.withResolvers<void>()
    h.onClose(() => barrier.promise)
    const stopping = h.broker.stop()
    await expect(op.result).rejects.toThrow()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await vi.waitFor(() => expect(h.records).toHaveLength(2))
    expect(stopped).toBe(false)
    h.onClose()
    barrier.resolve()
    await stopping
    await op.settled
  })
})
