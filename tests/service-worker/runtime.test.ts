import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import { BOUNDS, HEADERS, VERSION } from '../../src/service-worker/protocol'
import { binding, block, client, config, deferred, scope, source } from './helpers'

vi.mock('../../src/network/direct-transport', () => ({ DirectCleanupError: class extends Error {}, createDirectTransport: () => {
  throw new Error('This HTTP fallback test must not create a WSS node')
} }))

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
describe('WindowClient-bound Service Worker fetch runtime', () => {
  it('uses a real request handler, verifies bytes, consumes tickets once and ignores static paths', async () => {
    const { bytes, cid } = await block()
    const get = vi.fn(async () => bytes)
    const { result, createSource } = runtime(get)
    expect(get).not.toHaveBeenCalled()
    const owner = await connect(result)
    const request = await owner.prepare(cid, 1)
    expect(get).not.toHaveBeenCalled()
    const response = await result.handleFetch(request, client.id)!
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(await owner.read(1)).toEqual(bytes)
    expect((await result.handleFetch(request.clone(), client.id)!).status).toBe(400)
    expect(get).toHaveBeenCalledTimes(1)
    expect(result.usage().consumers).toBe(1)
    await owner.control('consume', { blockRequestId: 1 })
    expect(result.usage()).toMatchObject({ flights: 0, consumers: 0, workingBytes: 0, responseBytes: 0 })
    expect(result.handleFetch(new Request(scope), client.id)).toBeUndefined()
    expect(createSource.mock.calls[0]![0].limits.maxBlockCacheBytes).toBeLessThanOrEqual(BOUNDS.cachePerBinding)
  })
  it('rejects cross-tab ticket replay, stale epochs, noncanonical paths and schema extensions', async () => {
    const { cid, bytes } = await block()
    const get = vi.fn(async () => bytes)
    const { result } = runtime(get)
    const owner = await connect(result)
    const request = await owner.prepare(cid, 1)
    expect((await result.handleFetch(request.clone(), 'other-window')!).status).toBe(400)
    const stale = new Request(request)
    stale.headers.set(HEADERS.epoch, 'stale')
    expect((await result.handleFetch(stale, client.id)!).ok).toBe(false)
    const unsafe = new Request(request.url + '/extra', request)
    expect((await result.handleFetch(unsafe, client.id)!).status).toBe(400)
    expect(get).not.toHaveBeenCalled()
    expect((await result.handleFetch(request, client.id)!).ok).toBe(true)
    await expect(owner.control('snapshot', { clientId: client.id })).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })
  it('rejects wrong-hash and over-limit source bytes before producing a successful response', async () => {
    const { cid } = await block()
    for (const bytes of [new Uint8Array([1]), new Uint8Array(config.limits.maxBlockBytes + 1)]) {
      const { result } = runtime(async () => bytes)
      const owner = await connect(result)
      const response = await result.handleFetch(await owner.prepare(cid, 1), client.id)!
      expect(response.ok).toBe(false)
      expect((await response.json()).code).toBe(bytes.length > config.limits.maxBlockBytes ? 'LIMIT' : 'INTEGRITY')
      expect(result.usage()).toMatchObject({ consumers: 0, flights: 0, workingBytes: 0 })
    }
  })
  it('keeps a shared flight alive for another consumer and retains final-cancel ownership until settlement', async () => {
    const { bytes, cid } = await block()
    const gate = deferred<Uint8Array>()
    let signal: AbortSignal | undefined
    const { result } = runtime(async (_cid, current) => { signal = current; return gate.promise })
    const owner = await connect(result)
    const first = result.handleFetch(await owner.prepare(cid, 1), client.id)!
    const second = result.handleFetch(await owner.prepare(cid, 2), client.id)!
    await vi.waitFor(() => expect(result.usage().flights).toBe(1))
    await owner.control('cancel-block', { blockRequestId: 1 })
    expect(signal!.aborted).toBe(false)
    let acknowledged = false
    const cancelled = owner.control('cancel-block', { blockRequestId: 2 }).then(() => { acknowledged = true })
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    expect(acknowledged).toBe(false)
    expect(result.usage()).toMatchObject({ flights: 1, consumers: 1 })
    gate.resolve(bytes)
    await cancelled
    expect((await first).status).toBe(410)
    expect((await second).status).toBe(410)
    expect(result.usage()).toMatchObject({ flights: 0, consumers: 0, workingBytes: 0 })
  })
  it('isolates binding config/source ownership and enforces global unconsumed-response bounds', async () => {
    const { cid, bytes } = await block()
    const { result, createSource } = runtime(async () => bytes)
    const first = await connect(result)
    const second = await connect(result, { ...client, id: 'other-window' })
    const capacity = Math.min(BOUNDS.responses, Math.floor(BOUNDS.responseBytes / (config.limits.maxBlockBytes * 2)))
    for (let id = 1; id <= capacity; id++) await first.prepare(cid, id)
    await expect(second.prepare(cid, 1)).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(createSource).toHaveBeenCalledTimes(2)
    await first.control('discard', { blockRequestId: 1 })
    expect((await result.handleFetch(await second.prepare(cid, 2), 'other-window')!).ok).toBe(true)
    expect(result.usage().responseBytes).toBeLessThanOrEqual(BOUNDS.responseBytes)
  })
  it('cancels one shared-CID consumer without aborting the other successful fetch', async () => {
    const { bytes, cid } = await block()
    const gate = deferred<Uint8Array>()
    const get = vi.fn(async (_cid: string, signal: AbortSignal) => { signal.throwIfAborted(); return gate.promise })
    const { result } = runtime(get)
    const owner = await connect(result)
    const first = result.handleFetch(await owner.prepare(cid, 1), client.id)!
    const second = result.handleFetch(await owner.prepare(cid, 2), client.id)!
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    await owner.control('cancel-block', { blockRequestId: 1 })
    expect(get.mock.calls[0]![1].aborted).toBe(false)
    gate.resolve(bytes)
    expect((await first).status).toBe(410)
    const response = await second
    expect(response.ok).toBe(true)
    expect(response.status).toBe(204)
    expect(await owner.read(2)).toEqual(bytes)
    await owner.control('consume', { blockRequestId: 2 })
    expect(result.usage().consumers).toBe(0)
  })
  it('does not trust caller client IDs and refuses non-Window or out-of-scope opens', async () => {
    const { result, createSource } = runtime(async () => new Uint8Array())
    const invalid = [{ ...client, type: 'worker' }, { ...client, url: 'https://gallery.example/sibling/' }]
    for (const owner of invalid) await expect(binding(result, owner)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const { port1, port2 } = new MessageChannel()
    cleanups.push(() => port1.close())
    const response = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
    await result.open({ v: VERSION, type: 'open', sessionId: 's', config, clientId: 'other-window' }, client, port2)
    expect((await response).data).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(createSource).not.toHaveBeenCalled()
  })
  it('preserves HTTP-date Retry-After through the Service Worker fallback fetch wiring', async () => {
    const { bytes, cid } = await block('SW fallback verified bytes')
    const now = Date.parse('2026-10-11T12:00:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('{"Providers":[]}', {
      headers: { 'Content-Type': 'application/json' },
    })).mockResolvedValueOnce(new Response(null, {
      status: 503, headers: { 'Retry-After': new Date(now + 30_000).toUTCString() },
    })).mockResolvedValueOnce(new Response(bytes.slice().buffer))
    const result = createServiceWorkerRuntime({ scope, boot: 'test-boot', clients: { get: async () => client },
      createSource: settings => createIpfsBlockSourceWithOptions(settings, { fetch, router: 'https://router.example',
        policy: () => undefined, transport: { retrieve: vi.fn(), dispose: vi.fn() } }) })
    cleanups.push(() => result.dispose())
    const owner = await connect(result)
    const response = await result.handleFetch(await owner.prepare(cid, 1), client.id)!
    expect(response.status).toBe(204)
    expect(await owner.read(1)).toEqual(bytes)
    expect(fetch.mock.calls.map(([url]) => new URL(url.toString()).origin)).toEqual(['https://router.example', ...config.gateways])
    const snapshot = await owner.control('snapshot') as Array<{ state: string; cooldownUntil?: number }>
    expect(snapshot[0]).toMatchObject({ state: 'cooldown', cooldownUntil: now + 30_000 })
    expect(snapshot[1]).toMatchObject({ state: 'healthy' })
  })
})
