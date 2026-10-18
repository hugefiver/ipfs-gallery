import { expect, it, vi } from 'vitest'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import type { WorkerRequest } from '../../src/shared/contracts'
import { normalizeContentRef } from '../../src/core/query'
import { normalizeGateway } from '../../src/network/gateways'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import { createGalleryClient } from '../../src/worker/client'
import { BRIDGE_OPEN, createBridgedBlockSource } from '../../src/worker/block-bridge'
import { record } from '../../src/worker/protocol'
import { GalleryWorkerRuntime } from '../../src/worker/runtime'
import { SCRIPT } from '../../src/service-worker/protocol'
import type { WindowSourceEnvironment } from '../../src/service-worker/window-source'
import { block, client as windowClient, config, deferred, scope, source } from './helpers'

it('preserves old ownership after asynchronous bridge rejection and across sessions/crashes until real cleanup is proven', async () => {
  const { cid, bytes } = await block('real asset assembly bytes')
  vi.useFakeTimers()
  const gate = deferred<Uint8Array>()
  const sw = createServiceWorkerRuntime({ scope, boot: 'fixed-global-boot', clients: { get: async () => windowClient },
    createSource: () => source(async () => gate.promise) })
  const management: unknown[] = []
  const opens: Array<{ ownerId: string; attempt: number }> = []
  const controller = { scriptURL: new URL(SCRIPT, scope).href,
    postMessage(value: { type: string }, ports: MessagePort[]) {
      if (value.type === 'open') {
        opens.push(value as unknown as { ownerId: string; attempt: number })
        void sw.open(value, windowClient, ports[0]!)
      }
      else { if (value.type === 'reconcile') management.push(value); void sw.manage(value, windowClient, ports[0]!) }
    } } as unknown as ServiceWorker
  const container = new EventTarget() as EventTarget & { controller: ServiceWorker; register(): Promise<unknown> }
  container.controller = controller; container.register = async () => ({})
  const env: WindowSourceEnvironment = { base: new URL(scope), serviceWorker: container as unknown as ServiceWorkerContainer,
    channel: () => new MessageChannel(), fetch: (input, init) => {
      const request = new Request(input, init)
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(request.signal.reason)
        request.signal.addEventListener('abort', abort, { once: true })
        if (request.signal.aborted) abort()
        void sw.handleFetch(request, windowClient.id)!.then(resolve, reject)
          .finally(() => request.signal.removeEventListener('abort', abort))
      })
    } }
  let started = 0
  class InProcessWorker extends EventTarget {
    terminated = false
    readonly runtime = new GalleryWorkerRuntime({
      normalizeContentRef, normalizeGateway,
      postMessage: (message, transfer) => this.publish(message, transfer),
      createBroker: (settings, session) => createBridgedBlockSource(settings, session, (value, transfer) => this.publish(value, transfer)),
      createReader: broker => ({ stat: async () => ({ kind: 'file', size: BigInt(bytes.length) }),
        ls: async function* () {}, read: async function* (ref, options) { yield await broker.get(ref.cid, options.signal) } }),
      discover: async () => ({ title: '', description: '', items: [], warnings: [], partial: false }),
      readAsset: async (ref, reader, options) => {
        started++
        for await (const value of reader.read(ref, { signal: options.signal, maxBytes: options.limits.maxAssetBytes })) {
          return { bytes: value.slice().buffer, byteLength: value.length, mime: 'image/png', kind: 'image' }
        }
        throw new Error('missing block')
      },
    })
    publish(data: unknown, transfer: Transferable[] = []) {
      const payload = structuredClone({
        data, ports: transfer.filter(value => value instanceof MessagePort) as MessagePort[],
      }, { transfer })
      queueMicrotask(() => { if (!this.terminated) this.dispatchEvent(new MessageEvent('message', payload)) })
    }
    postMessage(value: unknown) { if (!this.terminated) this.runtime.handleMessage(value) }
    terminate() {
      if (this.terminated) return
      this.terminated = true
      this.runtime.handleMessage({ type: 'dispose', sessionId: 'dispose', requestId: 'dispose-generation' })
    }
  }
  const workers: InProcessWorker[] = []
  const client = createGalleryClient(() => {
    const worker = new InProcessWorker(); workers.push(worker); return worker as unknown as Worker
  }, () => env)
  const discover = (id: string, sessionId = 'session'): Extract<WorkerRequest, { type: 'discover' }> => ({
    type: 'discover', requestId: id, sessionId, config, input: { source: { kind: 'cids', refs: [{ cid, path: [] }], browse: false } },
  })
  const asset = (id: string, sessionId = 'session'): Extract<WorkerRequest, { type: 'asset' }> => ({
    type: 'asset', requestId: id, sessionId, ref: { cid, path: [] },
  })
  let rejectedBridge: ReturnType<typeof createBridgedBlockSource> | undefined
  try {
    await client.discover(discover('initial'))
    const old = [0, 1, 2].map(index => client.loadAsset(asset(`old-${index}`)).catch(error => error))
    await vi.waitFor(() => expect(sw.usage().consumers).toBe(3))
    rejectedBridge = createBridgedBlockSource(config, 'rejected-init', (value, transfer) => {
      workers[0]!.publish(record(value) && value.type === BRIDGE_OPEN
        ? { ...value, policy: { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless } } : value, transfer)
    })
    let rejected: unknown
    void rejectedBridge.get(cid, new AbortController().signal).catch(error => { rejected = error })
    await vi.waitFor(() => expect(rejected).toMatchObject({ error: { code: 'INVALID_INPUT' } }), { timeout: 200 })
    await rejectedBridge.settled!()
    expect(workers[0]!.runtime.usage()).toMatchObject({ activeAssets: 3, assemblyBytes: bytes.length * 3 })
    expect(sw.usage()).toMatchObject({ bindings: 1, consumers: 3, flights: 1 })
    for (let index = 0; index < 3; index++) await client.cancel({ type: 'cancel', sessionId: 'session',
      requestId: `cancel-${index}`, targetRequestId: `old-${index}` })
    expect(await Promise.all(old)).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'CANCELLED' }) })]))
    expect(workers[0]!.runtime.usage()).toMatchObject({ activeAssets: 3, assemblyBytes: bytes.length * 3 })
    await client.discover(discover('next', 'new-session'))
    const fourth = client.loadAsset(asset('fourth', 'new-session')).catch(error => error)
    expect(started).toBe(3)
    workers[0]!.dispatchEvent(new Event('error'))
    await fourth
    expect(workers[0]!.terminated).toBe(true)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(workers[0]!.runtime.usage()).toMatchObject({ activeAssets: 3, assemblyBytes: bytes.length * 3 })
    const recovery = client.discover(discover('recovery', 'recovering')).catch(error => error)
    const coalesced = client.discover(discover('coalesced', 'recovering')).catch(error => error)
    expect(await recovery).toMatchObject({ error: { code: 'NETWORK' } })
    await coalesced
    expect(management).toHaveLength(1)
    expect(workers).toHaveLength(1)
    expect(started).toBe(3)
    expect(sw.usage().flights).toBe(1)
    await client.cancel({ type: 'cancel', sessionId: 'session', requestId: 'quarantine-cancel', targetRequestId: 'old-0' })
    expect(workers).toHaveLength(1)
    gate.resolve(bytes)
    await vi.waitFor(() => expect(sw.usage().bindings).toBe(0))
    await client.discover(discover('fresh', 'fresh-session'))
    expect(management).toHaveLength(2)
    expect((await client.loadAsset(asset('fresh-asset', 'fresh-session'))).bytes).toEqual(bytes.buffer)
    expect(workers).toHaveLength(2)
    expect(started).toBe(4)
    expect(new Set(opens.map(value => value.ownerId)).size).toBe(1)
    expect(opens.at(-1)!.attempt).toBeGreaterThan(opens[0]!.attempt)
  } finally {
    gate.resolve(bytes)
    rejectedBridge?.dispose()
    await client.dispose({ type: 'dispose', sessionId: 'end', requestId: 'end' })
    for (const worker of workers) worker.terminate()
    await sw.dispose()
    await vi.advanceTimersByTimeAsync(100_000)
    vi.useRealTimers()
  }
})
