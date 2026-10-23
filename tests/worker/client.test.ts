import { describe, expect, it, vi } from 'vitest'
import { createGalleryClient } from '../../src/worker/client'
import { MAX_PENDING_REQUESTS } from '../../src/worker/protocol'
import { asset, discover, FakeWorker, load, result } from './helpers'

async function ready(worker: FakeWorker, client: ReturnType<typeof createGalleryClient>, sessionId = 'session', id = 'discover') {
  const request = discover(id, sessionId)
  const promise = client.discover(request)
  worker.respond(request, result)
  await promise
}

describe('Worker client', () => {
  it('correlates concurrent results, source worker, request and session before delivery', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const one = client.loadAsset(load('one'))
    const two = client.loadAsset(load('two'))
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    worker.response({ type: 'progress', sessionId: 'other', requestId: 'one', phase: 'media', completed: 1 })
    worker.response({ type: 'progress', sessionId: 'session', requestId: 'unknown', phase: 'media', completed: 1 })
    worker.response({ type: 'progress', sessionId: 'session', requestId: 'one', phase: 'media', completed: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
    worker.respond({ ...load('one'), sessionId: 'other' }, asset())
    worker.respond(load('two'), asset(8))
    expect((await two).byteLength).toBe(8)
    worker.respond(load('one'), asset())
    expect((await one).byteLength).toBe(4)
    worker.response({ type: 'progress', sessionId: 'session', requestId: 'one', phase: 'media', completed: 2 })
    unsubscribe()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('allows the synchronous asset consumer to run before releasing the next slot', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const promises = Array.from({ length: 4 }, (_, index) => client.loadAsset(load(`asset-${index}`)))
    expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(3)
    let sentAtConsumption = 0
    const consume = promises[0]!.then(() => {
      sentAtConsumption = worker.sent.filter((request) => request.type === 'asset').length
    })
    worker.respond(load('asset-0'), asset())
    expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(3)
    await consume
    expect(sentAtConsumption).toBe(3)
    await vi.waitFor(() => expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(4))
    for (let index = 1; index < 4; index++) worker.respond(load(`asset-${index}`), asset())
    await Promise.all(promises)
  })

  it('keeps sent cancellation slots until target terminals, including across sessions', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const old = Array.from({ length: 4 }, (_, index) => client.loadAsset(load(`old-${index}`)).catch((error: unknown) => error))
    const cancel = { type: 'cancel' as const, sessionId: 'session', requestId: 'cancel', targetRequestId: 'old-0' }
    const cancelling = client.cancel(cancel)
    worker.respond(cancel)
    await cancelling
    expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(3)
    const nextDiscover = discover('next', 'next-session')
    const next = client.discover(nextDiscover)
    expect(await old[3]).toMatchObject({ error: { code: 'CANCELLED' } })
    const nextAsset = client.loadAsset(load('new-asset', 'next-session'))
    worker.respond(nextDiscover, result)
    await next
    expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(3)
    worker.respond(load('old-0'), asset())
    expect(await old[0]).toMatchObject({ error: { code: 'CANCELLED' } })
    await vi.waitFor(() => expect(worker.sent.filter((request) => request.type === 'asset')).toHaveLength(4))
    worker.respond(load('new-asset', 'next-session'), asset())
    await nextAsset
    worker.respond(load('old-1'), asset())
    worker.respond(load('old-2'), asset())
    await Promise.all(old)
  })

  it('cancels unsent work locally with its own identity and acknowledges the cancel separately', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const promises = Array.from({ length: 5 }, (_, index) => client.loadAsset(load(`asset-${index}`)).catch((error: unknown) => error))
    const request = { type: 'cancel' as const, sessionId: 'session', requestId: 'cancel', targetRequestId: 'asset-3' }
    const wrong = { ...request, sessionId: 'wrong', requestId: 'wrong-cancel' }
    const wrongCancel = client.cancel(wrong)
    worker.respond(wrong)
    await wrongCancel
    const cancelling = client.cancel(request)
    expect(await promises[3]).toMatchObject({ error: { code: 'CANCELLED' } })
    expect(worker.sent.some((request) => request.requestId === 'asset-3')).toBe(false)
    worker.respond(request)
    await cancelling
    worker.respond(load('asset-0'), asset())
    await promises[0]
    await vi.waitFor(() => expect(worker.sent.some((request) => request.requestId === 'asset-4')).toBe(true))
    for (const index of [1, 2, 4]) worker.respond(load(`asset-${index}`), asset())
    await Promise.all(promises)
  })

  it.each(['error', 'messageerror'])('settles pending and queued work on %s, then lazily recreates', async (type) => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const factory = vi.fn().mockReturnValueOnce(first.asWorker()).mockReturnValueOnce(second.asWorker())
    const client = createGalleryClient(factory)
    await ready(first, client)
    const work = Array.from({ length: 5 }, (_, index) => client.loadAsset(load(`old-${index}`)).catch((error: unknown) => error))
    first.emit(type)
    expect(first.terminated).toBe(true)
    for (const error of await Promise.all(work)) expect(error).toMatchObject({ error: { code: 'INTERNAL', retryable: true } })
    await expect(client.loadAsset(load('uninitialized'))).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    await ready(second, client, 'recreated', 'recreated-discover')
    expect(factory).toHaveBeenCalledTimes(2)
    const fresh = client.loadAsset(load('fresh', 'recreated'))
    first.respond(load('fresh', 'recreated'), asset(8))
    second.respond(load('fresh', 'recreated'), asset())
    expect((await fresh).byteLength).toBe(4)
  })

  it('terminates only after dispose ack, settles remaining work and cannot be reused', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const work = Array.from({ length: 4 }, (_, index) => client.loadAsset(load(`asset-${index}`)).catch((error: unknown) => error))
    const request = { type: 'dispose' as const, sessionId: 'session', requestId: 'dispose' }
    const disposing = client.dispose(request)
    expect(worker.terminated).toBe(false)
    expect(await work[3]).toMatchObject({ error: { code: 'CANCELLED' } })
    worker.respond(request)
    await disposing
    expect(worker.terminated).toBe(true)
    for (const error of await Promise.all(work)) expect(error).toMatchObject({ error: { code: 'CANCELLED' } })
    await expect(client.discover(discover('again'))).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await client.dispose({ ...request, requestId: 'again-dispose' })
  })

  it('bounds its queue while retaining capacity for cancellation and disposal', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const work = Array.from({ length: MAX_PENDING_REQUESTS }, (_, index) => client.loadAsset(load(`asset-${index}`)).catch((error: unknown) => error))
    await expect(client.loadAsset(load('overflow'))).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    const cancel = { type: 'cancel' as const, sessionId: 'session', requestId: 'cancel', targetRequestId: 'asset-0' }
    const cancelling = client.cancel(cancel)
    worker.respond(cancel)
    await cancelling
    const dispose = { type: 'dispose' as const, sessionId: 'session', requestId: 'dispose' }
    const disposing = client.dispose(dispose)
    worker.respond(dispose)
    await disposing
    await Promise.all(work)
  })

  it.each(['NETWORK', 'TIMEOUT', 'NOT_FOUND'] as const)('keeps the active source after a recoverable discovery %s terminal', async code => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    const request = discover('failed-discovery')
    const discovery = client.discover(request)
    worker.response({ type: 'error', sessionId: request.sessionId, requestId: request.requestId,
      error: { code, message: 'recoverable discovery failure', retryable: true } })
    await expect(discovery).rejects.toMatchObject({ error: { code } })
    const loading = client.loadAsset(load('after-failure'))
    expect(worker.sent.some(sent => sent.requestId === 'after-failure')).toBe(true)
    worker.respond(load('after-failure'), asset())
    await expect(loading).resolves.toMatchObject({ byteLength: 4 })
  })

  it('rejects duplicate identities without changing the active session', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    await expect(client.discover(discover('discover', 'other'))).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    const loading = client.loadAsset(load('still-active'))
    worker.respond(load('still-active'), asset())
    await loading
  })

  it('does not cancel a full asset queue when a dispose identity is invalid', async () => {
    const worker = new FakeWorker()
    const client = createGalleryClient(() => worker.asWorker())
    await ready(worker, client)
    const work = Array.from({ length: 4 }, (_, index) => client.loadAsset(load(`asset-${index}`)))
    await expect(client.dispose({ type: 'dispose', sessionId: 'session', requestId: 'asset-0' }))
      .rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(worker.terminated).toBe(false)
    worker.respond(load('asset-0'), asset())
    await work[0]
    await vi.waitFor(() => expect(worker.sent.some((request) => request.requestId === 'asset-3')).toBe(true))
    for (let index = 1; index < 4; index++) worker.respond(load(`asset-${index}`), asset())
    await Promise.all(work)
  })
})
