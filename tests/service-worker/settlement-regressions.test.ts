import { expect, it, vi } from 'vitest'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import { domain, BOUNDS } from '../../src/service-worker/protocol'
import { binding, block, client, deferred, scope } from './helpers'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

it.each(['pending', 'rejected'])('returns the original block error independently of %s cleanup and retains real ownership', async state => {
  const { cid } = await block()
  const result = deferred<Uint8Array>()
  const cleanup = deferred<void>()
  const get = vi.fn(() => result.promise)
  const settled = vi.fn(() => cleanup.promise)
  const runtime = createServiceWorkerRuntime({ scope, boot: 'settlement-boot', clients: { get: async () => client },
    createSource: () => ({ get, settled, snapshot: () => [], dispose: () => {} }) })
  const owner = await binding(runtime)
  let response: Response | undefined
  const fetch = runtime.handleFetch(await owner.prepare(cid, 1), client.id)!.then(value => { response = value; return value })
  try {
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    result.reject(domain('INTEGRITY'))
    if (state === 'rejected') cleanup.reject(domain('NETWORK'))
    await turn()
    expect(response?.status).toBe(502)
    expect(await response!.json()).toMatchObject({ code: 'INTEGRITY' })
    expect(settled).toHaveBeenCalled()
    expect(runtime.usage()).toMatchObject({ flights: 1, consumers: 1, handlers: 0, waiters: 0 })
    expect(runtime.usage().workingBytes).toBeGreaterThan(0)
    if (state === 'pending') {
      cleanup.resolve()
      await vi.waitFor(() => expect(runtime.usage()).toMatchObject({ flights: 0, consumers: 0 }))
    } else {
      await expect(owner.control('discard', { blockRequestId: 1 })).rejects.toMatchObject({ error: { code: 'NETWORK' } })
      await expect(owner.prepare(cid, 2)).rejects.toMatchObject({ error: { code: 'NETWORK' } })
      expect(runtime.usage()).toMatchObject({ flights: 1, consumers: 1 })
    }
  } finally {
    cleanup.resolve()
    owner.rpc.close()
    if (state === 'pending') { await fetch; await runtime.dispose() }
    else void runtime.dispose().catch(() => {})
  }
})

it('ends every cancelled shared consumer locally while retaining the live consumer and its separate cleanup ownership', async () => {
  const { cid, bytes } = await block()
  const result = deferred<Uint8Array>()
  const cleanup = deferred<void>()
  let signal: AbortSignal | undefined
  const get = vi.fn((_cid: string, current: AbortSignal) => { signal = current; return result.promise })
  const runtime = createServiceWorkerRuntime({ scope, boot: 'settlement-boot', clients: { get: async () => client },
    createSource: () => ({ get, settled: () => cleanup.promise, snapshot: () => [], dispose: () => {} }) })
  const owner = await binding(runtime)
  const requests: Promise<Response>[] = []
  try {
    const live = runtime.handleFetch(await owner.prepare(cid, 1), client.id)!
    requests.push(live)
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    for (let id = 2; id <= BOUNDS.perBinding + 2; id++) {
      let response: Response | undefined
      const cancelled = runtime.handleFetch(await owner.prepare(cid, id), client.id)!.then(value => { response = value; return value })
      requests.push(cancelled)
      await turn()
      await owner.control('cancel-block', { blockRequestId: id })
      expect(response?.status).toBe(410)
      expect(signal!.aborted).toBe(false)
      expect(runtime.usage()).toMatchObject({ flights: 1, consumers: 1, handlers: 1, waiters: 1 })
    }
    expect(get).toHaveBeenCalledTimes(1)
    result.resolve(bytes)
    expect((await live).status).toBe(204)
    expect(await owner.read(1)).toEqual(bytes)
    expect(runtime.usage().flights).toBe(1)
    cleanup.resolve()
    await owner.control('consume', { blockRequestId: 1 })
    expect(runtime.usage()).toMatchObject({ flights: 0, consumers: 0 })
  } finally {
    result.resolve(bytes); cleanup.resolve()
    await Promise.all(requests)
    owner.rpc.close()
    await runtime.dispose()
  }
})
