import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceWorkerRuntime, type WindowIdentity } from '../../src/service-worker/runtime'
import { BOUNDS, VERSION } from '../../src/service-worker/protocol'
import { binding, block, client, config, deferred, scope } from './helpers'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
async function maintain(runtime: ReturnType<typeof createServiceWorkerRuntime>, fields: Record<string, unknown>, sender = client) {
  const { port1, port2 } = new MessageChannel()
  const response = new Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>(resolve => {
    port1.onmessage = event => resolve(event.data); port1.start()
  })
  await runtime.manage({ v: VERSION, type: 'maintain', ...fields }, sender, port2)
  const result = await response
  port1.close()
  return result
}

describe('active Window lease and bounded SW maintenance', () => {
  it('maintains across both foreground-idle periods and expires only after the active lease', async () => {
    const { cid } = await block()
    vi.useFakeTimers()
    const maintenance = vi.fn(async () => {})
    const runtime = createServiceWorkerRuntime({ scope, boot: 'lease-boot', clients: { get: async () => client },
      createSource: () => ({ get: vi.fn(), snapshot: () => [], dispose() {}, maintain: maintenance }) })
    cleanups.push(() => runtime.dispose())
    const owner = await binding(runtime, client, config, [cid])
    cleanups.push(() => owner.rpc.close())
    for (let sequence = 1; sequence <= 5; sequence++) {
      await vi.advanceTimersByTimeAsync(BOUNDS.heartbeatMs)
      expect(await maintain(runtime, { ...owner.identity, sequence })).toMatchObject({ ok: true })
    }
    expect(runtime.usage().bindings).toBe(1)
    expect(maintenance).toHaveBeenCalledWith([cid], expect.any(AbortSignal))
    expect(runtime.usage()).toMatchObject({ flights: 0, workingBytes: 0 })
    await vi.advanceTimersByTimeAsync(BOUNDS.leaseMs + BOUNDS.idleMs)
    expect(runtime.usage().bindings).toBe(0)
  })
  it('validates the actual client, capability, epoch, exact fields, monotonic sequence and version', async () => {
    const { cid } = await block()
    const other: WindowIdentity = { ...client, id: 'other-window' }
    const maintenance = vi.fn(async () => {})
    const runtime = createServiceWorkerRuntime({ scope, boot: 'lease-boot', clients: { get: async id => id === client.id ? client : other },
      createSource: () => ({ get: vi.fn(), snapshot: () => [], dispose() {}, maintain: maintenance }) })
    cleanups.push(() => runtime.dispose())
    const owner = await binding(runtime, client, config, [cid])
    cleanups.push(() => owner.rpc.close())
    const fields = { ...owner.identity, sequence: 1 }
    expect(await maintain(runtime, fields, other)).toMatchObject({ ok: false })
    for (const invalid of [{ ...fields, capability: 'wrong' }, { ...fields, epoch: 'old' },
      { ...fields, roots: [cid] }, { ...fields, v: VERSION - 1 }, { ...fields, sequence: 0 }]) {
      expect(await maintain(runtime, invalid)).toMatchObject({ ok: false })
    }
    expect(await maintain(runtime, fields)).toMatchObject({ ok: true })
    expect(await maintain(runtime, fields)).toMatchObject({ ok: false })
    expect(maintenance).toHaveBeenCalledTimes(1)
    expect(runtime.usage().bindings).toBe(1)
  })
  it('keeps zero-foreground binding debt through aborted maintenance and retained socket drain', async () => {
    const { cid } = await block()
    const cleanup = deferred<void>()
    const sockets = deferred<void>()
    let signal: AbortSignal | undefined
    const dispose = vi.fn()
    const runtime = createServiceWorkerRuntime({ scope, boot: 'drain-boot', clients: { get: async () => client },
      createSource: () => ({ get: vi.fn(), snapshot: () => [], dispose,
        maintain: async (_roots, current) => { signal = current; await cleanup.promise }, drained: () => sockets.promise }) })
    cleanups.push(() => runtime.dispose())
    cleanups.push(() => { cleanup.resolve(); sockets.resolve() })
    const owner = await binding(runtime, client, config, [cid])
    cleanups.push(() => owner.rpc.close())
    const checking = maintain(runtime, { ...owner.identity, sequence: 1 })
    await vi.waitFor(() => expect(signal).toBeDefined())
    let closed = false
    const closing = owner.control('close').then(() => { closed = true })
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    expect(dispose).toHaveBeenCalledOnce()
    expect(runtime.usage()).toMatchObject({ bindings: 1, flights: 0, workingBytes: 1024 * 1024 })
    cleanup.resolve()
    await checking
    expect(closed).toBe(false)
    expect(runtime.usage().bindings).toBe(1)
    sockets.resolve()
    await closing
    expect(runtime.usage()).toMatchObject({ bindings: 0, workingBytes: 0 })
  })
  it('does not admit maintenance without nonidentity session roots', async () => {
    const maintenance = vi.fn(async () => {})
    const runtime = createServiceWorkerRuntime({ scope, boot: 'empty-boot', clients: { get: async () => client },
      createSource: () => ({ get: vi.fn(), snapshot: () => [], dispose() {}, maintain: maintenance }) })
    cleanups.push(() => runtime.dispose())
    const owner = await binding(runtime)
    cleanups.push(() => owner.rpc.close())
    expect(await maintain(runtime, { ...owner.identity, sequence: 1 })).toMatchObject({ ok: false })
    expect(maintenance).not.toHaveBeenCalled()
  })
})
