import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { WindowBlockSource, readBounded } from '../../src/service-worker/window-source'
import { attachWindowBlockBridge, createBridgedBlockSource } from '../../src/worker/block-bridge'
import { BRIDGE_OPEN } from '../../src/worker/block-bridge'
import { BOUNDS } from '../../src/service-worker/protocol'
import { domain } from '../../src/service-worker/protocol'
import { reply } from '../../src/service-worker/rpc'
import { WindowOwnership } from '../../src/service-worker/ownership'
import { block, config, deferred } from './helpers'
import { environment } from './bridge-fixture'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })

describe('Window / Dedicated Worker private bridge', () => {
  it('propagates INTEGRITY through both bridges before independently gated source cleanup settles', async () => {
    const { cid } = await block()
    const result = deferred<Uint8Array>()
    const cleanup = deferred<void>()
    const host = environment(cleanups, async () => result.promise, true, () => cleanup.promise)
    let close: (() => void) | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      if ((value as { type: string }).type === BRIDGE_OPEN) close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    try {
      const get = source.get(cid, new AbortController().signal).catch(error => error)
      let settled = false
      const barrier = source.settled!().then(() => { settled = true })
      await vi.waitFor(() => expect(host.runtime().usage().flights).toBe(1))
      result.reject(domain('INTEGRITY'))
      expect(await get).toMatchObject({ error: { code: 'INTEGRITY' } })
      expect(settled).toBe(false)
      expect(host.runtime().usage()).toMatchObject({ flights: 1, consumers: 1, handlers: 0 })
      cleanup.resolve()
      await barrier
    } finally { result.resolve(new Uint8Array()); cleanup.resolve(); source.dispose(); close?.() }
  })
  it('renews a cached Window binding after its SW sends a proven clean-idle notification', async () => {
    const { cid, bytes } = await block()
    vi.useFakeTimers()
    const host = environment(cleanups, async () => bytes)
    const source = new WindowBlockSource('session', config, host.env)
    try {
      await source.get(1, cid, new AbortController().signal)
      await source.acknowledge(1)
      await vi.advanceTimersByTimeAsync(BOUNDS.idleMs + 1)
      expect(source.ownership.usage()).toEqual({ debts: 0, quarantined: false })
      expect(new Uint8Array(await source.get(2, cid, new AbortController().signal))).toEqual(bytes)
      await source.acknowledge(2)
      expect(host.container.register).toHaveBeenCalledTimes(2)
    } finally { source.dispose(); await vi.advanceTimersByTimeAsync(100_000); vi.useRealTimers() }
  })
  it('re-handshakes on the next real read after clean idle without a private-port timeout or crash', async () => {
    const { cid, bytes } = await block()
    vi.useFakeTimers()
    const host = environment(cleanups, async () => bytes)
    const faults = vi.fn()
    let close: (() => void) | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      if ((value as { type: string }).type === BRIDGE_OPEN) close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
      else faults(value)
    })
    try {
      expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
      await source.settled!()
      await vi.advanceTimersByTimeAsync(BOUNDS.idleMs + 1)
      const next = source.get(cid, new AbortController().signal).catch(error => error)
      await vi.waitFor(() => expect(host.fetch).toHaveBeenCalledTimes(2), { timeout: 200 })
      expect(await next).toEqual(bytes)
      expect(host.container.register).toHaveBeenCalledTimes(2)
      expect(faults).not.toHaveBeenCalled()
    } finally {
      source.dispose(); close?.()
      await vi.advanceTimersByTimeAsync(100_000)
      vi.useRealTimers()
    }
  })
  it('cancels a locally queued read during idle retirement without settling the old binding drain', async () => {
    const { cid, bytes } = await block()
    vi.useFakeTimers()
    const drain = deferred<void>()
    let draining = false
    const host = environment(cleanups, async () => bytes, true, () => draining ? drain.promise : Promise.resolve())
    const ownership = new WindowOwnership()
    const relay = { count: 0, bytes: 0 }
    const faults = vi.fn()
    let close: (() => void) | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      if ((value as { type: string }).type === BRIDGE_OPEN) {
        close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env, () => {}, relay, ownership)
      } else faults(value)
    })
    try {
      expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
      await source.settled!()
      draining = true
      await vi.advanceTimersByTimeAsync(BOUNDS.idleMs + 1)
      expect(ownership.usage().debts).toBe(1)
      const controller = new AbortController()
      let terminal: unknown
      void source.get(cid, controller.signal).catch(error => { terminal = error })
      let acknowledged = false
      void source.settled!().then(() => { acknowledged = true })
      controller.abort()
      await vi.waitFor(() => expect(acknowledged || faults.mock.calls.length > 0).toBe(true), { timeout: 200 })
      expect(faults).not.toHaveBeenCalled()
      expect(terminal).toMatchObject({ error: { code: 'CANCELLED' } })
      expect(acknowledged).toBe(true)
      expect(relay).toEqual({ count: 0, bytes: 0 })
      expect(ownership.usage().debts).toBe(1)
      expect(host.runtime().usage().bindings).toBe(1)
      expect(host.fetch).toHaveBeenCalledTimes(1)
      expect(host.container.register).toHaveBeenCalledTimes(1)
      drain.resolve()
      await vi.waitFor(() => expect(ownership.usage().debts).toBe(0), { timeout: 200 })
      expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
      await source.settled!()
      expect(host.fetch).toHaveBeenCalledTimes(2)
      expect(faults).not.toHaveBeenCalled()
    } finally {
      drain.resolve(); source.dispose(); close?.()
      await vi.advanceTimersByTimeAsync(100_000)
      vi.useRealTimers()
    }
  })
  it('lazily obtains first control, uses restricted fetch and transfers verified exact bytes back to the dedicated source', async () => {
    const { bytes, cid } = await block()
    const get = vi.fn(async () => bytes)
    const host = environment(cleanups, get, false)
    let close: (() => void) | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    cleanups.push(() => { source.dispose(); close?.() })
    expect(host.container.register).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    const result = await source.get(cid, new AbortController().signal)
    expect(result).toEqual(bytes)
    expect(result.buffer.byteLength).toBe(bytes.byteLength)
    expect(host.fetch).toHaveBeenCalledTimes(1)
    const [input, init] = host.fetch.mock.calls[0]!
    expect(new URL(input.toString()).pathname).toBe(`/gallery/__ipfs_gallery__/blocks/${cid}`)
    expect(init).toMatchObject({ method: 'GET', mode: 'same-origin', credentials: 'omit',
      redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' })
    expect(host.runtime().usage()).toMatchObject({ consumers: 0, flights: 0 })
  })
  it('starts bounded maintenance after an empty-root bridge admits its first nonidentity block', async () => {
    const { bytes, cid } = await block('identity manifest child')
    const get = vi.fn(async () => bytes)
    const maintain = vi.fn(async () => {})
    const host = environment(cleanups, get, true, undefined, () => ({
      get, snapshot: () => [], dispose() {}, maintain,
    }))
    let close: ReturnType<typeof attachWindowBlockBridge> | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    cleanups.push(() => { source.dispose(); close?.() })
    expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
    await source.settled!()
    await close!.maintain()
    expect(maintain).toHaveBeenCalledWith([], expect.any(AbortSignal))
  })
  it('keeps empty-root maintenance active after an admitted nonidentity block fails', async () => {
    const { cid } = await block('temporarily unavailable child')
    const get = vi.fn(async () => { throw domain('NETWORK') })
    const maintain = vi.fn(async () => {})
    const host = environment(cleanups, get, true, undefined, () => ({
      get, snapshot: () => [], dispose() {}, maintain,
    }))
    let close: ReturnType<typeof attachWindowBlockBridge> | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    cleanups.push(() => { source.dispose(); close?.() })
    await expect(source.get(cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'NETWORK' } })
    await source.settled!()
    await close!.maintain()
    expect(maintain).toHaveBeenCalledWith([], expect.any(AbortSignal))
  })
  it('resolves large identity CIDs locally without Window registration or fetch', async () => {
    const bytes = new Uint8Array(1000).fill(42)
    const cid = CID.createV1(0x55, identity.digest(bytes)).toString()
    const post = vi.fn((_value: unknown, ports: Transferable[]) => { (ports[0] as MessagePort).close() })
    const source = createBridgedBlockSource(config, 'session', post)
    cleanups.push(() => source.dispose())
    expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
  })
  it('returns a bounded cancellation error but retains the source snapshot barrier until real cleanup', async () => {
    const { bytes, cid } = await block()
    const gate = deferred<Uint8Array>()
    let aborted = false
    const host = environment(cleanups, async (_cid, signal) => {
      signal.addEventListener('abort', () => { aborted = true })
      return gate.promise
    })
    cleanups.push(() => gate.resolve(bytes))
    let close: (() => void) | undefined
    const source = createBridgedBlockSource(config, 'session', (value, ports) => {
      close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    cleanups.push(() => { source.dispose(); close?.() })
    const controller = new AbortController()
    let terminal = false
    const result = source.get(cid, controller.signal).catch(error => { terminal = true; return error })
    await vi.waitFor(() => expect(host.runtime().usage().flights).toBe(1))
    let settled = false
    const barrier = source.settled!().then(() => { settled = true })
    controller.abort()
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(terminal).toBe(true)
    expect(settled).toBe(false)
    expect(host.runtime().usage().flights).toBe(1)
    gate.resolve(bytes)
    expect(await result).toBeInstanceOf(Error)
    await barrier
    expect(host.runtime().usage()).toMatchObject({ flights: 0, consumers: 0 })
  })
  it('does not accept a new boot identity as proof of an old binding settlement', async () => {
    const { bytes, cid } = await block()
    const host = environment(cleanups, async () => bytes)
    const source = new WindowBlockSource('session', config, host.env)
    cleanups.push(() => source.dispose())
    expect(new Uint8Array(await source.get(1, cid, new AbortController().signal))).toEqual(bytes)
    await source.acknowledge(1)
    await host.restart()
    vi.useFakeTimers()
    const stale = source.get(2, cid, new AbortController().signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(config.limits.blockTimeoutMs + BOUNDS.handshakeMs)
    expect(await stale).toMatchObject({ error: { code: 'TIMEOUT' } })
    vi.useRealTimers()
    expect(source.ownership.quarantined).toBe(true)
    await expect(source.recover()).rejects.toMatchObject({ error: { code: 'NETWORK' } })
    await expect(source.get(3, cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  })
  it('retains the old controller cancellation port until real in-flight cleanup settles', async () => {
    const { bytes, cid } = await block()
    const gate = deferred<Uint8Array>()
    let signal: AbortSignal | undefined
    const host = environment(cleanups, async (_cid, current) => { signal = current; return gate.promise })
    cleanups.push(() => gate.resolve(bytes))
    const source = new WindowBlockSource('session', config, host.env)
    cleanups.push(() => source.dispose())
    let terminal = false
    const result = source.get(1, cid, new AbortController().signal).catch(error => { terminal = true; return error })
    await vi.waitFor(() => expect(host.runtime().usage().flights).toBe(1))
    let settled = false
    const barrier = source.settled().then(() => { settled = true })
    host.container.dispatchEvent(new Event('controllerchange'))
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    await vi.waitFor(() => expect(terminal).toBe(true))
    expect(settled).toBe(false)
    expect(host.runtime().usage().flights).toBe(1)
    gate.resolve(bytes)
    expect(await result).toMatchObject({ error: { code: 'CANCELLED' } })
    await barrier
    expect(host.runtime().usage().flights).toBe(0)
  })
  it('rejects an unrelated controller and never falls back to a Dedicated Worker network source', async () => {
    const host = environment(cleanups, async () => new Uint8Array())
    host.container.controller = { scriptURL: 'https://gallery.example/other-sw.js' } as ServiceWorker
    const source = new WindowBlockSource('session', config, host.env)
    cleanups.push(() => source.dispose())
    await expect(source.get(1, (await block()).cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
    expect(host.container.register).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
  })
  it('bounds registration failure without hanging a request', async () => {
    const cid = (await block()).cid
    const host = environment(cleanups, async () => new Uint8Array())
    host.container.register.mockImplementation(() => new Promise(() => {}))
    const source = new WindowBlockSource('session', config, host.env)
    cleanups.push(() => source.dispose())
    vi.useFakeTimers()
    const result = source.get(1, cid, new AbortController().signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(BOUNDS.handshakeMs)
    expect(await result).toMatchObject({ error: { code: 'TIMEOUT' } })
  })
  it('rejects declared/actual oversized and truncated response bodies', async () => {
    const signal = new AbortController().signal
    await expect(readBounded(new Response(new Uint8Array(2), { headers: { 'Content-Length': '99' } }), 4, signal))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    await expect(readBounded(new Response(new Uint8Array(5)), 4, signal)).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    await expect(readBounded(new Response(new Uint8Array(2), { headers: { 'Content-Length': '3' } }), 4, signal))
      .rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
  })
  it('verifies transferred blocks again at the Dedicated Worker boundary', async () => {
    const { cid } = await block()
    const source = createBridgedBlockSource(config, 'session', (_value, ports) => {
      const port = ports[0] as MessagePort
      port.onmessage = event => {
        const value = event.data
        if (value.type === 'get') {
          const bytes = new Uint8Array([1, 2, 3]).buffer
          reply(port, value.sequence, { sessionId: 'session', blockRequestId: value.blockRequestId,
            cid, byteLength: bytes.byteLength, bytes, gateways: [], policy: BUILD_POLICY }, [bytes])
        } else { reply(port, value.sequence, null); if (value.type === 'close') port.close() }
      }
      port.start()
      reply(port, 0, { sessionId: 'session', policy: BUILD_POLICY })
    })
    cleanups.push(() => source.dispose())
    await expect(source.get(cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
  })
})
