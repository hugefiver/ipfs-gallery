import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { webSockets, WebSocketsInit } from '@libp2p/websockets'
import { CID } from 'multiformats/cid'
import { multiaddr } from '@multiformats/multiaddr'
import { createDirectTransport } from '../../src/network/direct-transport'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { directBudget } from '../../src/network/direct-budget'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { config, deferred, rawBlock, response } from './helpers'
import { peer, providerRecord } from './provider-helpers'

type Transport = ReturnType<ReturnType<typeof webSockets>>
const state = vi.hoisted(() => ({
  lower: vi.fn(), upper: vi.fn(), want: vi.fn(), start: vi.fn(), stop: vi.fn(), transport: undefined as Transport | undefined,
}))
vi.mock('@libp2p/websockets', () => ({ webSockets: (init: WebSocketsInit) => () => ({
  dial: (...args: unknown[]) => state.lower(init, ...args), dialFilter: (addresses: unknown[]) => addresses,
}) }))
vi.mock('@helia/bitswap', () => ({ withBitswap: (node: unknown) => node }))
vi.mock('helia', () => ({ createHeliaLight: () => ({
  blockBrokers: [{ name: 'bitswap', retrieveOperation: (...args: unknown[]) => state.want(...args) }],
  start: () => state.start(), stop: () => state.stop(),
}) }))
vi.mock('@helia/libp2p', () => ({ withLibp2pLight: (node: object, options: { transports: Array<(components: unknown) => Transport> }) => {
  state.transport = options.transports[0]!({})
  return Object.assign(node, { libp2p: {
    peerStore: { merge: async () => {} }, dial: (...args: unknown[]) => state.upper(...args),
    services: { identify: { identify: async () => {} } },
  } })
} }))

const address = `/dns4/provider.ipfs.tech/tcp/443/wss/p2p/${peer}`
const sources: ReturnType<typeof createIpfsBlockSourceWithOptions>[] = []
beforeEach(() => { vi.resetAllMocks() })
afterEach(async () => {
  for (const source of sources.splice(0)) { source.dispose(); await source.settled().catch(() => {}) }
  expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
})
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function makeSource(bytes: Uint8Array) {
  const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev'
    ? new Response(JSON.stringify({ Providers: [providerRecord([address])] }), { headers: { 'content-type': 'application/json' } })
    : response(bytes))
  const source = createIpfsBlockSourceWithOptions(config(), { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress })
  sources.push(source)
  return { source, fetch }
}

describe('operation and connection lifecycle ownership', () => {
  it('retains startup ownership through disposal and stops only after startup settles', async () => {
    const block = await rawBlock('dispose while starting')
    const starting = deferred<void>()
    state.start.mockReturnValue(starting.promise)
    const transport = createDirectTransport()
    const target = multiaddr(address)
    const read = transport.retrieve(CID.parse(block.cid), { id: peer, addresses: [{ kind: 'wss', address: target }] }, target, new AbortController().signal)
    const outcome = read.catch((error: unknown) => error)
    let finished = false
    void outcome.then(() => { finished = true })
    try {
      await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce())
      transport.dispose()
      const barrier = transport.settled!()
      let cleaned = false
      void barrier.then(() => { cleaned = true })
      await turn()
      expect(finished).toBe(false)
      expect(cleaned).toBe(false)
      expect(state.stop).not.toHaveBeenCalled()
      expect(directBudget.snapshot().peers).toBe(1)
      starting.resolve()
      expect(await outcome).toMatchObject({ error: { code: 'CANCELLED' } })
      await barrier
      expect(state.stop).toHaveBeenCalledOnce()
      expect(state.upper).not.toHaveBeenCalled()
      expect(state.want).not.toHaveBeenCalled()
      expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
    } finally { starting.resolve(); transport.dispose(); await Promise.allSettled([read, transport.settled!()]) }
  })

  it('waits for failed startup cleanup before releasing its peer or settling', async () => {
    const block = await rawBlock('failed startup cleanup')
    const starting = deferred<void>()
    const stopping = deferred<void>()
    const failure = new Error('startup failed')
    state.start.mockReturnValue(starting.promise)
    state.stop.mockReturnValue(stopping.promise)
    const transport = createDirectTransport()
    const target = multiaddr(address)
    const read = transport.retrieve(CID.parse(block.cid), { id: peer, addresses: [{ kind: 'wss', address: target }] }, target, new AbortController().signal)
    const outcome = read.catch((error: unknown) => error)
    let finished = false
    void outcome.then(() => { finished = true })
    try {
      await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce())
      starting.reject(failure)
      await vi.waitFor(() => expect(state.stop).toHaveBeenCalledOnce())
      const barrier = transport.settled!()
      let cleaned = false
      void barrier.then(() => { cleaned = true })
      await turn()
      expect(finished).toBe(false)
      expect(cleaned).toBe(false)
      expect(directBudget.snapshot().peers).toBe(1)
      stopping.resolve()
      expect(await outcome).toBe(failure)
      await barrier
      expect(state.upper).not.toHaveBeenCalled()
      expect(state.want).not.toHaveBeenCalled()
      expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
    } finally { starting.resolve(); stopping.resolve(); transport.dispose(); await Promise.allSettled([read, transport.settled!()]) }
  })

  it('keeps a shared startup for B when A cancels before it completes', async () => {
    const a = await rawBlock('cancel starting A')
    const b = await rawBlock('starting B continues')
    const starting = deferred<void>()
    const resultB = deferred<Uint8Array>()
    const closed = deferred<void>()
    state.start.mockReturnValue(starting.promise)
    state.stop.mockImplementation(() => { closed.resolve() })
    state.lower.mockImplementation(async (init: WebSocketsInit) => {
      init.onConnection!({ closed: closed.promise } as Parameters<NonNullable<WebSocketsInit['onConnection']>>[0])
      return { addEventListener() {} }
    })
    state.upper.mockImplementation((target, options) => state.transport!.dial(target, options))
    state.want.mockReturnValue({ result: resultB.promise, settled: Promise.resolve(), cancel() {} })
    const { source, fetch } = makeSource(b.bytes)
    const controller = new AbortController()
    const readA = source.get(a.cid, controller.signal)
    const outcomeA = readA.catch((error: unknown) => error)
    const readB = source.get(b.cid, new AbortController().signal)
    void readB.catch(() => {})
    try {
      await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce())
      expect(fetch).toHaveBeenCalledTimes(2)
      controller.abort()
      await turn()
      expect(state.stop).not.toHaveBeenCalled()
      expect(directBudget.snapshot().peers).toBe(1)
      starting.resolve()
      expect(await outcomeA).toMatchObject({ error: { code: 'CANCELLED' } })
      await vi.waitFor(() => expect(state.want).toHaveBeenCalledOnce())
      expect(state.stop).not.toHaveBeenCalled()
      resultB.resolve(b.bytes)
      expect(await readB).toEqual(b.bytes)
      await source.settled()
      expect(state.stop).toHaveBeenCalledOnce()
      expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
    } finally { starting.resolve(); resultB.resolve(b.bytes); source.dispose(); await Promise.allSettled([readA, readB]) }
  })

  it('waits for the lower transport dial after the upper queue already rejected', async () => {
    const block = await rawBlock('gateway after physical dial cleanup')
    const lower = deferred<never>()
    state.lower.mockReturnValue(lower.promise)
    state.upper.mockImplementation((target, options) => {
      void state.transport!.dial(target, options).catch(() => {})
      return Promise.reject(new Error('upper queue rejected'))
    })
    const { source, fetch } = makeSource(block.bytes)
    const result = source.get(block.cid, new AbortController().signal)
    let finished = false
    void result.then(() => { finished = true }, () => { finished = true })
    try {
      await vi.waitFor(() => expect(state.lower).toHaveBeenCalledOnce())
      const barrier = source.settled()
      let cleaned = false
      void barrier.then(() => { cleaned = true }, () => { cleaned = true })
      await turn()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(finished).toBe(false)
      expect(cleaned).toBe(false)
      expect(directBudget.snapshot()).toMatchObject({ dials: 1, connections: 1 })
      lower.reject(new Error('physical dial cleanup exited'))
      expect(await result).toEqual(block.bytes)
      await barrier
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { lower.reject(new Error('test cleanup')); await result.catch(() => {}) }
  })

  it('completes A snapshot while future B owns the shared live connection', async () => {
    const a = await rawBlock('snapshot A')
    const b = await rawBlock('later B')
    const closed = deferred<void>()
    const aResult = deferred<Uint8Array>()
    const aCleanup = deferred<void>()
    const bResult = deferred<Uint8Array>()
    const bCleanup = deferred<void>()
    state.stop.mockImplementation(() => { closed.resolve() })
    state.lower.mockImplementation(async (init: WebSocketsInit) => {
      init.onConnection!({ closed: closed.promise } as Parameters<NonNullable<WebSocketsInit['onConnection']>>[0])
      return { addEventListener() {} }
    })
    state.upper.mockImplementation((target, options) => state.transport!.dial(target, options))
    state.want.mockImplementation((cid: CID, options: { signal: AbortSignal }) => {
      if (cid.toString() === b.cid) options.signal.addEventListener('abort', () => {
        bResult.reject(options.signal.reason); bCleanup.resolve()
      }, { once: true })
      return {
        result: cid.toString() === a.cid ? aResult.promise : bResult.promise,
        settled: cid.toString() === a.cid ? aCleanup.promise : bCleanup.promise, cancel() {},
      }
    })
    const { source } = makeSource(a.bytes)
    const readA = source.get(a.cid, new AbortController().signal)
    let readB: Promise<Uint8Array> | undefined
    try {
      await vi.waitFor(() => expect(state.want).toHaveBeenCalledTimes(1))
      const barrier = source.settled()
      let cleaned = false
      void barrier.then(() => { cleaned = true })
      readB = source.get(b.cid, new AbortController().signal)
      void readB.catch(() => {})
      await vi.waitFor(() => expect(state.want).toHaveBeenCalledTimes(2))
      aResult.resolve(a.bytes); aCleanup.resolve()
      expect(await readA).toEqual(a.bytes)
      await turn()
      expect(cleaned).toBe(true)
      expect(directBudget.snapshot().connections).toBe(1)
      expect(state.stop).not.toHaveBeenCalled()
      source.dispose()
      await expect(readB).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
      await source.settled()
      expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
      await barrier
    } finally {
      aResult.resolve(a.bytes); aCleanup.resolve(); bResult.resolve(b.bytes); bCleanup.resolve()
      await Promise.allSettled([readA, readB])
    }
  })
})
