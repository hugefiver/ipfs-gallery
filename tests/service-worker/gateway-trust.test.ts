import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from 'multiformats/hashes/sha2'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import { WindowBlockSource } from '../../src/service-worker/window-source'
import { attachWindowBlockBridge, createBridgedBlockSource } from '../../src/worker/block-bridge'
import { createGalleryClient } from '../../src/worker/client'
import { GalleryWorkerRuntime } from '../../src/worker/runtime'
import { normalizeContentRef } from '../../src/core/query'
import { normalizeGateway } from '../../src/network/gateways'
import { record } from '../../src/worker/protocol'
import { BRIDGE_OPEN } from '../../src/worker/block-bridge'
import { VERSION } from '../../src/service-worker/protocol'
import { reply } from '../../src/service-worker/rpc'
import { binding, block, client, config, deferred, scope, source } from './helpers'
import { environment } from './bridge-fixture'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
function runtime(get: ReturnType<typeof source>['get']) {
  const createSource = vi.fn<(settings: typeof config) => ReturnType<typeof source>>(() => source(get))
  const result = createServiceWorkerRuntime({ scope, boot: 'test-boot',
    clients: { get: async id => id === client.id || id === 'other-window' ? { ...client, id } : undefined }, createSource })
  cleanups.push(() => result.dispose())
  return { result, createSource }
}
async function connect(result: ReturnType<typeof createServiceWorkerRuntime>, owner = client) {
  const value = await binding(result, owner)
  cleanups.push(() => value.rpc.close())
  return value
}

describe('compiled gateway policy and private SW delivery', () => {
  it('delivers real configured-gateway fallback bytes through SW admission and both private bridges under the compiled policy', async () => {
    const { cid, bytes } = await block('requested original')
    const replacement = new TextEncoder().encode('gateway replacement')
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'router.example'
      ? new Response('{"Providers":[]}', { headers: { 'content-type': 'application/json' } }) : new Response(replacement.slice().buffer))
    const host = environment(cleanups, async () => bytes, true, undefined, () => createIpfsBlockSourceWithOptions({ ...config, limits: { ...config.limits, blockTimeoutMs: 300 } }, {
      fetch, router: 'https://router.example', policy: () => undefined, transport: { retrieve: vi.fn(), dispose() {} },
    }))
    let close: (() => void) | undefined
    const dedicated = createBridgedBlockSource(config, 'session', (value, ports) => {
      close = attachWindowBlockBridge(value, ports[0] as MessagePort, () => host.env)
    })
    try {
      if (BUILD_POLICY.trustless) await expect(dedicated.get(cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
      else expect(await dedicated.get(cid, new AbortController().signal)).toEqual(replacement)
      await dedicated.settled!()
      expect(host.fetch).toHaveBeenCalledTimes(1)
      expect(host.runtime().usage()).toMatchObject({ flights: 0, consumers: 0, workingBytes: 0, responseBytes: 0 })
    } finally { dedicated.dispose(); close?.() }
  })
  it('rejects a same-origin server imitating HTTP admission without an actually used SW ticket', async () => {
    const { cid, bytes } = await block()
    const get = vi.fn(async () => bytes)
    const host = environment(cleanups, get)
    host.fetch.mockImplementation(async (_input, init) => new Response(null, { status: 204, headers: init?.headers }))
    const windowSource = new WindowBlockSource('session', config, host.env)
    try {
      await expect(windowSource.get(1, cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
      await windowSource.settled()
      expect(get).not.toHaveBeenCalled()
      expect(host.runtime().usage().consumers).toBe(0)
    } finally { windowSource.dispose() }
  })
  it('cannot substitute an HTTP body for the admitted private-port result', async () => {
    const { cid, bytes } = await block()
    const host = environment(cleanups, async () => bytes)
    const admittedFetch = host.env.fetch
    host.env.fetch = async (input, init) => {
      const admitted = await admittedFetch(input, init)
      return new Response(Uint8Array.of(9), { status: 200, headers: admitted.headers })
    }
    const windowSource = new WindowBlockSource('session', config, host.env)
    try {
      await expect(windowSource.get(1, cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
      await windowSource.settled()
      expect(host.runtime().usage().consumers).toBe(0)
    } finally { windowSource.dispose() }
  })
  it.each([false, true])('accepts only empty admission streams and keeps private delivery authoritative (payload=%s)', async payload => {
    const { cid, bytes } = await block()
    const host = environment(cleanups, async () => bytes)
    const admittedFetch = host.env.fetch
    host.env.fetch = async (input, init) => {
      const admitted = await admittedFetch(input, init)
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        if (payload) controller.enqueue(Uint8Array.of(9))
        controller.close()
      } })
      Object.defineProperty(admitted, 'body', { value: body })
      return admitted
    }
    const windowSource = new WindowBlockSource('session', config, host.env)
    try {
      const result = windowSource.get(1, cid, new AbortController().signal)
      if (payload) await expect(result).rejects.toBeInstanceOf(Error)
      else {
        expect(new Uint8Array(await result)).toEqual(bytes)
        await windowSource.acknowledge(1)
      }
      await windowSource.settled()
      expect(host.runtime().usage().consumers).toBe(0)
    } finally { windowSource.dispose() }
  })
  it('rejects a mismatched SW build before opening a binding or fetching content', async () => {
    const { cid, bytes } = await block()
    const host = environment(cleanups, async () => bytes)
    host.container.controller = { scriptURL: host.controller.scriptURL,
      postMessage(value: { type: string }, ports: MessagePort[]) {
        if (value.type !== 'identify') throw new Error('A mismatched policy must not open a binding')
        reply(ports[0]!, 0, { boot: 'test-boot', policy: { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless } })
        ports[0]!.close()
      } } as unknown as ServiceWorker
    const windowSource = new WindowBlockSource('session', config, host.env)
    try {
      await expect(windowSource.get(1, cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
      await windowSource.settled()
      expect(host.fetch).not.toHaveBeenCalled()
      expect(host.runtime().usage().bindings).toBe(0)
    } finally { windowSource.dispose() }
  })
  it('terminates an asynchronous Worker asset request with INVALID_INPUT when bridge policy differs, without content admission', async () => {
    const { cid, bytes } = await block()
    vi.useFakeTimers()
    const get = vi.fn(async () => bytes)
    const host = environment(cleanups, get)
    let dedicated: ReturnType<typeof createBridgedBlockSource> | undefined
    class AsyncWorker extends EventTarget {
      terminated = false
      readonly runtime = new GalleryWorkerRuntime({
        normalizeContentRef, normalizeGateway,
        postMessage: (value, transfer) => this.publish(value, transfer),
        createBroker: (settings, session) => dedicated = createBridgedBlockSource(settings, session, (value, transfer) => {
          this.publish(record(value) && value.type === BRIDGE_OPEN
            ? { ...value, policy: { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless } } : value, transfer)
        }),
        createReader: broker => ({ stat: async () => ({ kind: 'file', size: BigInt(bytes.length) }),
          ls: async function* () {}, read: async function* (ref, options) { yield await broker.get(ref.cid, options.signal) } }),
        discover: async () => ({ title: '', description: '', items: [], warnings: [], partial: false }),
        readAsset: async (ref, reader, options) => {
          for await (const value of reader.read(ref, { signal: options.signal, maxBytes: options.limits.maxAssetBytes })) {
            return { bytes: value.slice().buffer, byteLength: value.length, mime: 'image/png', kind: 'image' }
          }
          throw new Error('missing block')
        },
      })
      publish(data: unknown, transfer: Transferable[] = []) {
        const payload = structuredClone({ data, ports: transfer.filter(value => value instanceof MessagePort) }, { transfer })
        queueMicrotask(() => { if (!this.terminated) this.dispatchEvent(new MessageEvent('message', payload)) })
      }
      postMessage(value: unknown) { queueMicrotask(() => { if (!this.terminated) this.runtime.handleMessage(value) }) }
      terminate() { this.terminated = true; dedicated?.dispose() }
    }
    const worker = new AsyncWorker()
    const gallery = createGalleryClient(() => worker as unknown as Worker, () => host.env)
    try {
      const discovery = gallery.discover({ type: 'discover', sessionId: 'session', requestId: 'discover', config,
        input: { source: { kind: 'cids', refs: [{ cid, path: [] }], browse: false } } })
      await vi.advanceTimersByTimeAsync(0)
      await discovery
      let terminal: unknown
      void gallery.loadAsset({ type: 'asset', sessionId: 'session', requestId: 'asset', ref: { cid, path: [] } })
        .catch(error => { terminal = error })
      await vi.waitFor(() => expect(terminal).toMatchObject({ error: { code: 'INVALID_INPUT' } }), { timeout: 200 })
      await dedicated!.settled!()
      expect(worker.runtime.usage()).toMatchObject({ activeAssets: 0, assemblyBytes: 0 })
      expect(get).not.toHaveBeenCalled()
      expect(host.fetch).not.toHaveBeenCalled()
      expect(host.container.register).not.toHaveBeenCalled()
      expect(host.runtime().usage()).toMatchObject({ bindings: 0, flights: 0, consumers: 0 })
    } finally {
      worker.dispatchEvent(new Event('error'))
      worker.terminate()
      await vi.advanceTimersByTimeAsync(200_000)
      vi.useRealTimers()
    }
  })
  it.each(['sessionId', 'bindingId', 'epoch', 'blockRequestId', 'cid', 'byteLength', 'policy', 'extra'] as const)(
    'rejects private SW delivery with a mismatched %s', async field => {
      const { cid, bytes } = await block()
      const host = environment(cleanups, async () => bytes)
      const commands = new Map<number, string>()
      const open = host.controller.postMessage.bind(host.controller)
      host.container.controller = { scriptURL: host.controller.scriptURL,
        postMessage(value: { type: string }, ports: MessagePort[]) {
          if (value.type === 'open') {
            const port = ports[0]!
            port.addEventListener('message', event => { commands.set(event.data.sequence, event.data.type) })
            const send = port.postMessage.bind(port)
            port.postMessage = (message, transfer) => {
              if (commands.get(message.sequence) === 'read-block' && message.ok) {
                const changed = field === 'policy' ? { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless }
                  : field === 'byteLength' || field === 'blockRequestId' ? -1 : 'wrong'
                message = { ...message, value: { ...message.value, [field]: changed } }
              }
              send(message, transfer as Transferable[])
            }
          }
          open(value, ports)
        } } as unknown as ServiceWorker
      const windowSource = new WindowBlockSource('session', config, host.env)
      try {
        await expect(windowSource.get(1, cid, new AbortController().signal)).rejects.toBeInstanceOf(Error)
        await windowSource.settled()
        expect(host.runtime().usage().consumers).toBe(0)
      } finally { windowSource.dispose() }
    })
  it.each(['sessionId', 'blockRequestId', 'cid', 'byteLength', 'bytes', 'policy', 'trusted'] as const)(
    'rejects a private relay result with mismatched %s in either compilation', async field => {
      const { cid, bytes: payload } = await block()
      const source = createBridgedBlockSource(config, 'session', (_value, ports) => {
        const port = ports[0] as MessagePort
        port.onmessage = event => {
          const message = event.data
          if (message.type === 'get') {
            const bytes = payload.slice().buffer
            const value = { sessionId: 'session', blockRequestId: message.blockRequestId, cid,
              byteLength: bytes.byteLength, bytes, gateways: [], policy: BUILD_POLICY }
            const changed = field === 'policy' ? { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless }
              : field === 'byteLength' || field === 'blockRequestId' ? -1 : 'wrong'
            reply(port, message.sequence, { ...value, [field]: changed }, [bytes])
          } else { reply(port, message.sequence, null); if (message.type === 'close') port.close() }
        }
        port.start()
        reply(port, 0, { sessionId: 'session', policy: BUILD_POLICY })
      })
      try {
        await expect(source.get(cid, new AbortController().signal)).rejects.toBeInstanceOf(Error)
        await source.settled!()
      } finally { source.dispose() }
    })
  it('delivers admitted bytes once through private RPC, never through the HTTP admission body', async () => {
    const { cid, bytes } = await block()
    const gate = deferred<Uint8Array>()
    const { result } = runtime(async () => gate.promise)
    const owner = await connect(result)
    const request = await owner.prepare(cid, 1)
    await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    const fetching = result.handleFetch(request, client.id)!
    await vi.waitFor(() => expect(result.usage().flights).toBe(1))
    await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    gate.resolve(bytes)
    const response = await fetching
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    await expect(owner.control('consume', { blockRequestId: 1 })).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    const delivery = await owner.control('read-block', { blockRequestId: 1 })
    expect(delivery).toEqual({ sessionId: owner.identity.sessionId, bindingId: owner.identity.bindingId,
      epoch: result.epoch, blockRequestId: 1, cid, byteLength: bytes.byteLength, bytes: bytes.slice().buffer, policy: BUILD_POLICY })
    await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(result.usage().consumers).toBe(1)
    expect(result.usage().responseBytes).toBeGreaterThan(0)
    await owner.control('consume', { blockRequestId: 1 })
    expect(result.usage()).toMatchObject({ consumers: 0, flights: 0, responseBytes: 0, workingBytes: 0 })
    await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })
  it('snapshots producer bytes before asynchronous verification and never delivers later mutations', async () => {
    const { cid, bytes } = await block('admission snapshot')
    const expected = bytes.slice()
    const hashing = deferred<void>()
    const finishHash = deferred<void>()
    const digest = sha256.digest.bind(sha256)
    vi.spyOn(sha256, 'digest').mockImplementation(async input => {
      expect(input).not.toBe(bytes)
      hashing.resolve()
      await finishHash.promise
      return digest(input)
    })
    const { result } = runtime(async () => bytes)
    const owner = await connect(result)
    const fetching = result.handleFetch(await owner.prepare(cid, 1), client.id)!
    await hashing.promise
    bytes.fill(1)
    finishHash.resolve()
    expect((await fetching).status).toBe(204)
    bytes.fill(2)
    expect(await owner.read(1)).toEqual(expected)
    await owner.control('consume', { blockRequestId: 1 })
  })
  it('does not treat arbitrary source or byte verified/trusted claims as gateway evidence', async () => {
    const { cid } = await block()
    const bytes = Object.assign(Uint8Array.of(1), { verified: true, trusted: 'configured-gateway' })
    const fake = Object.assign(source(async () => bytes), { verified: 'hash-verified', trusted: true })
    const result = createServiceWorkerRuntime({ scope, boot: 'fake-source-boot', clients: { get: async () => client }, createSource: () => fake })
    cleanups.push(() => result.dispose())
    const owner = await connect(result)
    const response = await result.handleFetch(await owner.prepare(cid, 1), client.id)!
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: 'INTEGRITY' })
    await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })
  it('rejects read delivery after cancellation without releasing ownership before real cleanup', async () => {
    const { cid, bytes } = await block()
    const cleanup = deferred<void>()
    const result = createServiceWorkerRuntime({ scope, boot: 'read-cancel-boot', clients: { get: async () => client },
      createSource: () => ({ ...source(async () => bytes), settled: () => cleanup.promise }) })
    cleanups.push(() => result.dispose())
    const owner = await connect(result)
    try {
      expect((await result.handleFetch(await owner.prepare(cid, 1), client.id)!).status).toBe(204)
      expect(await owner.read(1)).toEqual(bytes)
      let cancelled = false
      const cancelling = owner.control('cancel-block', { blockRequestId: 1 }).then(() => { cancelled = true })
      await expect(owner.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
      expect(cancelled).toBe(false)
      expect(result.usage()).toMatchObject({ consumers: 1, flights: 1 })
      cleanup.resolve()
      await cancelling
      expect(result.usage()).toMatchObject({ consumers: 0, flights: 0, responseBytes: 0, workingBytes: 0 })
    } finally { cleanup.resolve() }
  })
  it('requires the local immutable policy on SW admission, including the default gateway identity', async () => {
    const { result, createSource } = runtime(async () => new Uint8Array())
    for (const policy of [{ ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless },
      { ...BUILD_POLICY, defaultGateways: ['https://different.example'] }]) {
      const { port1, port2 } = new MessageChannel()
      const envelope = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
      await result.open({ v: VERSION, type: 'open', sessionId: 'session', config, roots: [],
        ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 1, boot: result.epoch, policy }, client, port2)
      expect((await envelope).data).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
      port1.close()
    }
    expect(createSource).not.toHaveBeenCalled()
  })
  it('lets cancellation win while a read-block is still validating the actual WindowClient', async () => {
    const { cid, bytes } = await block()
    const validating = deferred<void>()
    const validation = deferred<typeof client>()
    let stall = false
    const result = createServiceWorkerRuntime({ scope, boot: 'read-race-boot',
      clients: { get: async () => {
        if (stall) { stall = false; validating.resolve(); return validation.promise }
        return client
      } }, createSource: () => source(async () => bytes) })
    cleanups.push(() => result.dispose())
    const owner = await connect(result)
    try {
      await result.handleFetch(await owner.prepare(cid, 1), client.id)!
      stall = true
      const read = owner.read(1).catch(error => error)
      await validating.promise
      await owner.control('cancel-block', { blockRequestId: 1 })
      validation.resolve(client)
      expect(await read).toMatchObject({ error: { code: 'INVALID_INPUT' } })
      expect(result.usage()).toMatchObject({ consumers: 0, flights: 0, responseBytes: 0, workingBytes: 0 })
    } finally { validation.resolve(client) }
  })
  it('copies each shared consumer delivery without exposing the retained flight snapshot', async () => {
    const { cid, bytes } = await block()
    const gate = deferred<Uint8Array>()
    const get = vi.fn(async () => gate.promise)
    const { result } = runtime(get)
    const owner = await connect(result)
    const first = result.handleFetch(await owner.prepare(cid, 1), client.id)!
    const second = result.handleFetch(await owner.prepare(cid, 2), client.id)!
    await vi.waitFor(() => expect(result.usage().waiters).toBe(2))
    gate.resolve(bytes)
    await Promise.all([first, second])
    const delivered = await owner.read(1)
    delivered.fill(9)
    structuredClone(delivered.buffer, { transfer: [delivered.buffer] })
    expect(await owner.read(2)).toEqual(bytes)
    expect(get).toHaveBeenCalledTimes(1)
    await owner.control('consume', { blockRequestId: 1 })
    await owner.control('consume', { blockRequestId: 2 })
  })
  it('cannot read another binding\'s unconsumed ticket and rejects read schema extensions', async () => {
    const { cid, bytes } = await block()
    const { result } = runtime(async () => bytes)
    const owner = await connect(result)
    const other = await connect(result, { ...client, id: 'other-window' })
    await result.handleFetch(await owner.prepare(cid, 1), client.id)!
    await expect(other.read(1)).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    await expect(owner.control('read-block', { blockRequestId: 1, trusted: true }))
      .rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    await vi.waitFor(() => expect(result.usage().consumers).toBe(0))
  })
})
