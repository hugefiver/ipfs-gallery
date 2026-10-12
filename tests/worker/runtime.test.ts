import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentReader, DiscoveryOptions, OperationOptions } from '../../src/core/types'
import type { GalleryResult, VerifiedAsset, WorkerResponse } from '../../src/shared/contracts'
import { normalizeContentRef } from '../../src/core/query'
import { readVerifiedAsset } from '../../src/core/media'
import { normalizeGateway } from '../../src/network/broker'
import { GalleryWorkerRuntime, type RuntimeDependencies } from '../../src/worker/runtime'
import { MAX_PENDING_REQUESTS } from '../../src/worker/protocol'
import { asset, deferred, discover, load, ref, result } from './helpers'

function harness(overrides: Partial<RuntimeDependencies> = {}) {
  const messages: WorkerResponse[] = []
  const transfers: Transferable[][] = []
  const reader: ContentReader = {
    stat: vi.fn(async () => ({ kind: 'file' as const, size: 4n })),
    ls: vi.fn(async function* () {}),
    read: vi.fn(async function* () {}),
  }
  const brokers: { dispose: ReturnType<typeof vi.fn> }[] = []
  const dependencies: RuntimeDependencies = {
    postMessage: (message, transfer) => { messages.push(message); transfers.push(transfer ?? []) },
    normalizeContentRef,
    normalizeGateway: (value) => new URL(value).href.replace(/\/$/u, ''),
    createBroker: vi.fn(() => {
      const broker = { get: vi.fn(async () => new Uint8Array()), snapshot: vi.fn(() => []), dispose: vi.fn() }
      brokers.push(broker)
      return broker
    }),
    createReader: vi.fn(() => reader),
    discover: vi.fn(async () => result),
    readAsset: vi.fn(async () => asset()),
    ...overrides,
  }
  const runtime = new GalleryWorkerRuntime(dependencies)
  function terminal(requestId: string) {
    return messages.filter((message) => message.requestId === requestId
      && (message.type === 'result' || message.type === 'error'))
  }
  function dispose() { runtime.handleMessage({ type: 'dispose', sessionId: 'session', requestId: 'cleanup' }) }
  return { runtime, messages, transfers, dependencies, reader, brokers, terminal, dispose }
}

afterEach(() => vi.useRealTimers())

describe('Worker runtime', () => {
  it('uses isolated operation readers with the frozen discovery/asset budgets', async () => {
    const test = harness()
    test.runtime.handleMessage(discover())
    await vi.waitFor(() => expect(test.terminal('discover')).toHaveLength(1))
    test.runtime.handleMessage(load('asset'))
    await vi.waitFor(() => expect(test.terminal('asset')).toHaveLength(1))
    expect(test.dependencies.createReader).toHaveBeenNthCalledWith(1, expect.anything(), { maxInputBytes: 128 * 1024 * 1024 })
    expect(test.dependencies.createReader).toHaveBeenNthCalledWith(2, expect.anything(), { maxInputBytes: 96 * 1024 * 1024 })
    expect(test.terminal('asset')[0]).toMatchObject({ type: 'result', op: 'asset', value: { byteLength: 4 } })
    const response = test.terminal('asset')[0]!
    const index = test.messages.indexOf(response)
    expect(response.type === 'result' && response.op === 'asset' && test.transfers[index]![0] === response.value.bytes).toBe(true)
    test.dispose()
  })

  it('normalizes refs and gateways, deduplicates roots, and does not trust raised limits', async () => {
    const test = harness()
    const request = discover()
    request.input.source = { kind: 'cids', browse: false, refs: [ref, ref] }
    request.config.gateways = ['https://gateway.example/']
    test.runtime.handleMessage(request)
    await vi.waitFor(() => expect(test.terminal('discover')).toHaveLength(1))
    expect(test.dependencies.discover).toHaveBeenCalledWith({ source: { kind: 'cids', refs: [ref], browse: false } }, expect.anything(), expect.anything())
    expect(test.dependencies.createBroker).toHaveBeenCalledWith(expect.objectContaining({ gateways: ['https://gateway.example'] }))
    const excessive = discover('raised', 'raised-session')
    excessive.config.limits.maxAssetConcurrency = 4
    test.runtime.handleMessage(excessive)
    const rapid = discover('rapid', 'rapid-session')
    rapid.config.limits.progressIntervalMs = 1
    test.runtime.handleMessage(rapid)
    expect(test.terminal('raised')[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    expect(test.terminal('rapid')[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    test.runtime.handleMessage(load('active'))
    await vi.waitFor(() => expect(test.terminal('active')[0]).toMatchObject({ type: 'result' }))
    test.dispose()
  })

  it('preserves decoded special-character paths and enforces the production gateway normalizer', async () => {
    const test = harness({ normalizeGateway })
    const request = discover()
    const specialRef = { ...ref, path: ['%2f?x#y', '结尾 '] }
    request.input.source = { kind: 'unixfs', ref: specialRef, browse: false }
    request.config.gateways = ['https://gateway.example.com/prefix/']
    test.runtime.handleMessage(request)
    await vi.waitFor(() => expect(test.terminal('discover')).toHaveLength(1))
    expect(test.dependencies.discover).toHaveBeenCalledWith(request.input, expect.anything(), expect.anything())
    for (const [index, gateway] of ['http://localhost:8080', 'https://127.0.0.1', 'https://user:secret@example.com'].entries()) {
      const invalid = discover(`invalid-${index}`)
      invalid.config.gateways = [gateway]
      test.runtime.handleMessage(invalid)
      expect(test.terminal(invalid.requestId)[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    }
    const invalidCid = discover('invalid-cid')
    invalidCid.input.source = { kind: 'manifest', ref: { cid: 'not-a-cid', path: [] } }
    invalidCid.config.gateways = ['https://gateway.example.com']
    test.runtime.handleMessage(invalidCid)
    expect(test.terminal('invalid-cid')[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    test.dispose()
  })

  it('transfers the actual media assembler output without detaching cached reader chunks', async () => {
    const cached = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=', 'base64'))
    const expected = cached.slice()
    const delivered: WorkerResponse[] = []
    const originals: ArrayBuffer[] = []
    const test = harness({ readAsset: readVerifiedAsset,
      postMessage: (message, transfer) => {
        if (message.type === 'result' && message.op === 'asset') originals.push(message.value.bytes)
        delivered.push(structuredClone(message, { transfer: transfer ?? [] }))
      },
    })
    vi.mocked(test.reader.stat).mockResolvedValue({ kind: 'file', size: BigInt(cached.length) })
    vi.mocked(test.reader.read).mockImplementation(async function* () {
      yield cached.subarray(0, 20)
      yield cached.subarray(20)
    })
    test.runtime.handleMessage(discover())
    test.runtime.handleMessage(load('asset'))
    await vi.waitFor(() => expect(delivered.some((message) => message.type === 'result' && message.op === 'asset')).toBe(true))
    const response = delivered.find((message) => message.type === 'result' && message.op === 'asset')!
    expect(response).toMatchObject({ type: 'result', op: 'asset', value: { mime: 'image/png', width: 1, height: 1 } })
    if (response.type === 'result' && response.op === 'asset') {
      expect(new Uint8Array(response.value.bytes)).toEqual(expected)
      expect(response.value.bytes.byteLength).toBe(expected.byteLength)
    }
    expect(originals[0]!.byteLength).toBe(0)
    expect(cached).toEqual(expected)
    expect(test.reader.stat).toHaveBeenCalledTimes(1)
    test.dispose()
  })

  it.each([null, [], 1, { type: 'unknown', sessionId: 'session', requestId: 'unknown' },
    { type: 'asset', sessionId: 'x'.repeat(129), requestId: 'bad', ref },
    { ...load('bad-path'), ref: { ...ref, path: ['..'] } },
    { ...load('long-path'), ref: { ...ref, path: Array.from({ length: 65 }, () => 'a') } },
    { ...load('extra'), extra: 'untrusted' },
  ])('terminates a malformed message once without starting work: %j', (message) => {
    const test = harness()
    test.runtime.handleMessage(message)
    expect(test.messages).toHaveLength(1)
    expect(test.messages[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    expect(test.messages[0]!.sessionId.length).toBeLessThanOrEqual(128)
    expect(test.dependencies.createReader).not.toHaveBeenCalled()
  })

  it('atomically cancels the previous session and ignores its late completion and progress', async () => {
    const old = deferred<GalleryResult>()
    const options: DiscoveryOptions[] = []
    const test = harness({ discover: vi.fn((_input, _reader, option) => {
      options.push(option)
      return options.length === 1 ? old.promise : Promise.resolve(result)
    }) })
    test.runtime.handleMessage(discover())
    test.runtime.handleMessage(discover('next', 'new-session'))
    expect(options[0]!.signal.aborted).toBe(true)
    expect(test.brokers[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(test.terminal('discover')).toHaveLength(1)
    expect(test.terminal('discover')[0]).toMatchObject({ type: 'error', error: { code: 'CANCELLED' } })
    const before = test.messages.length
    options[0]!.onProgress?.({ phase: 'listing', completed: 1 })
    expect(test.messages).toHaveLength(before)
    old.resolve(result)
    await vi.waitFor(() => expect(test.terminal('next')).toHaveLength(1))
    expect(test.terminal('discover')).toHaveLength(1)
    test.runtime.handleMessage(load('stale'))
    expect(test.terminal('stale')[0]).toMatchObject({ type: 'error', error: { code: 'INVALID_INPUT' } })
    test.dispose()
  })

  it('isolates cancellation by session, with one target terminal and a separate idempotent ack', async () => {
    const pending = deferred<VerifiedAsset>()
    let options: OperationOptions | undefined
    const test = harness({ readAsset: vi.fn((_ref, _reader, option) => { options = option; return pending.promise }) })
    test.runtime.handleMessage(discover())
    test.runtime.handleMessage(load('asset'))
    await vi.waitFor(() => expect(options).toBeDefined())
    test.runtime.handleMessage({ type: 'cancel', sessionId: 'other', requestId: 'wrong', targetRequestId: 'asset' })
    expect(options!.signal.aborted).toBe(false)
    test.runtime.handleMessage({ type: 'cancel', sessionId: 'session', requestId: 'cancel', targetRequestId: 'asset' })
    expect(options!.signal.aborted).toBe(true)
    expect(test.terminal('asset')).toHaveLength(1)
    expect(test.terminal('asset')[0]).toMatchObject({ type: 'error', error: { code: 'CANCELLED' } })
    expect(test.terminal('cancel')[0]).toMatchObject({ type: 'result', op: 'cancel', value: null })
    pending.resolve(asset())
    await new Promise((resolve) => setTimeout(resolve, 0))
    test.runtime.handleMessage({ type: 'cancel', sessionId: 'session', requestId: 'again', targetRequestId: 'asset' })
    expect(test.terminal('asset')).toHaveLength(1)
    expect(test.terminal('again')).toHaveLength(1)
    test.dispose()
  })

  it('reserves known preallocation bytes and serializes assembly before exceeding its budget', async () => {
    const completions: ReturnType<typeof deferred<VerifiedAsset>>[] = []
    const test = harness({ readAsset: vi.fn(() => {
      const completion = deferred<VerifiedAsset>()
      completions.push(completion)
      return completion.promise
    }) })
    const request = discover()
    request.config.limits.maxAssemblyBytes = 8
    test.runtime.handleMessage(request)
    for (let index = 0; index < 3; index++) test.runtime.handleMessage(load(`asset-${index}`))
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    completions[0]!.resolve(asset())
    await vi.waitFor(() => expect(completions).toHaveLength(3))
    completions[1]!.resolve(asset())
    completions[2]!.resolve(asset())
    await vi.waitFor(() => expect(test.terminal('asset-2')).toHaveLength(1))
    test.dispose()
  })

  it('reserves unknown-size peak copies and releases queued reservations on cancellation', async () => {
    const completions: ReturnType<typeof deferred<VerifiedAsset>>[] = []
    const sizes: number[] = []
    const test = harness({ readAsset: vi.fn((_ref, _reader, options) => {
      sizes.push(options.limits.maxAssetBytes)
      const completion = deferred<VerifiedAsset>()
      completions.push(completion)
      return completion.promise
    }) })
    vi.mocked(test.reader.stat).mockResolvedValue({ kind: 'file' })
    const request = discover()
    request.config.limits.maxAssemblyBytes = 8
    test.runtime.handleMessage(request)
    for (let index = 0; index < 3; index++) test.runtime.handleMessage(load(`asset-${index}`))
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(sizes).toEqual([4])
    test.runtime.handleMessage({ type: 'cancel', sessionId: 'session', requestId: 'cancel-waiter', targetRequestId: 'asset-1' })
    completions[0]!.resolve(asset())
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    completions[1]!.resolve(asset())
    await vi.waitFor(() => expect(test.terminal('asset-2')).toHaveLength(1))
    expect(test.terminal('asset-1')[0]).toMatchObject({ type: 'error', error: { code: 'CANCELLED' } })
    test.dispose()
  })

  it('retains global asset slots and reservations until cancelled work physically exits across sessions', async () => {
    const completions: ReturnType<typeof deferred<VerifiedAsset>>[] = []
    const test = harness({ readAsset: vi.fn(() => {
      const completion = deferred<VerifiedAsset>()
      completions.push(completion)
      return completion.promise
    }) })
    test.runtime.handleMessage(discover())
    for (let index = 0; index < 3; index++) test.runtime.handleMessage(load(`old-${index}`))
    await vi.waitFor(() => expect(completions).toHaveLength(3))
    test.runtime.handleMessage(discover('next', 'next-session'))
    test.runtime.handleMessage(load('new-asset', 'next-session'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toHaveLength(3)
    completions[0]!.resolve(asset())
    await vi.waitFor(() => expect(completions).toHaveLength(4))
    for (const completion of completions.slice(1)) completion.resolve(asset())
    await vi.waitFor(() => expect(test.terminal('new-asset')).toHaveLength(1))
    for (let index = 0; index < 3; index++) expect(test.terminal(`old-${index}`)).toHaveLength(1)
    test.dispose()
  })

  it('rejects oversized stat and non-exact output buffers without transferring them', async () => {
    const test = harness()
    test.runtime.handleMessage(discover())
    vi.mocked(test.reader.stat).mockResolvedValueOnce({ kind: 'file', size: 65n * 1024n * 1024n })
    test.runtime.handleMessage(load('oversized'))
    await vi.waitFor(() => expect(test.terminal('oversized')[0]).toMatchObject({ type: 'error', error: { code: 'LIMIT' } }))
    expect(test.dependencies.readAsset).not.toHaveBeenCalled()
    vi.mocked(test.dependencies.readAsset).mockResolvedValueOnce({ ...asset(8), byteLength: 4 })
    test.runtime.handleMessage(load('bad-buffer'))
    await vi.waitFor(() => expect(test.terminal('bad-buffer')[0]).toMatchObject({ type: 'error', error: { code: 'INTERNAL' } }))
    expect(test.transfers.every((transfer) => transfer.length === 0)).toBe(true)
    test.dispose()
  })

  it('aborts at timeout, throttles progress/telemetry, and never emits a late second terminal', async () => {
    vi.useFakeTimers()
    let options: DiscoveryOptions | undefined
    const pending = deferred<GalleryResult>()
    const test = harness({ now: () => Date.now(), discover: vi.fn((_input, _reader, option) => {
      options = option
      return pending.promise
    }) })
    const request = discover()
    request.config.limits.discoveryTimeoutMs = 1000
    test.runtime.handleMessage(request)
    for (let index = 0; index < 10; index++) options!.onProgress?.({ phase: 'listing', completed: index })
    expect(test.messages.filter((message) => message.type === 'progress')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    options!.onProgress?.({ phase: 'listing', completed: 10 })
    expect(test.messages.filter((message) => message.type === 'progress')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(900)
    expect(options!.signal.aborted).toBe(true)
    expect(test.terminal('discover')[0]).toMatchObject({ type: 'error', error: { code: 'TIMEOUT' } })
    expect(test.messages.filter((message) => message.type === 'telemetry')).toHaveLength(2)
    pending.resolve(result)
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.terminal('discover')).toHaveLength(1)
    test.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out asset work and reservation waiters without freeing live assembly early', async () => {
    vi.useFakeTimers()
    const completions: ReturnType<typeof deferred<VerifiedAsset>>[] = []
    const signals: AbortSignal[] = []
    const test = harness({ readAsset: vi.fn((_ref, _reader, options) => {
      signals.push(options.signal)
      const completion = deferred<VerifiedAsset>()
      completions.push(completion)
      return completion.promise
    }) })
    const request = discover()
    request.config.limits.maxAssemblyBytes = 4
    request.config.limits.assetTimeoutMs = 100
    test.runtime.handleMessage(request)
    test.runtime.handleMessage(load('asset-0'))
    test.runtime.handleMessage(load('asset-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(completions).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(signals[0]!.aborted).toBe(true)
    for (const id of ['asset-0', 'asset-1']) {
      expect(test.terminal(id)).toHaveLength(1)
      expect(test.terminal(id)[0]).toMatchObject({ type: 'error', error: { code: 'TIMEOUT' } })
    }
    test.runtime.handleMessage(load('asset-2'))
    await vi.advanceTimersByTimeAsync(0)
    expect(completions).toHaveLength(1)
    completions[0]!.resolve(asset())
    await vi.advanceTimersByTimeAsync(0)
    expect(completions).toHaveLength(2)
    completions[1]!.resolve(asset())
    await vi.advanceTimersByTimeAsync(0)
    expect(test.terminal('asset-2')[0]).toMatchObject({ type: 'result', op: 'asset' })
    expect(test.terminal('asset-0')).toHaveLength(1)
    test.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disposes all pending operations and acknowledges once without accepting more work', async () => {
    const pending = deferred<GalleryResult>()
    const test = harness({ discover: vi.fn(() => pending.promise) })
    test.runtime.handleMessage(discover())
    test.runtime.handleMessage({ type: 'dispose', sessionId: 'session', requestId: 'dispose' })
    expect(test.terminal('discover')[0]).toMatchObject({ type: 'error', error: { code: 'CANCELLED' } })
    expect(test.terminal('dispose')[0]).toMatchObject({ type: 'result', op: 'dispose', value: null })
    expect(test.brokers[0]!.dispose).toHaveBeenCalledTimes(1)
    test.runtime.handleMessage(load('closed'))
    expect(test.terminal('closed')[0]).toMatchObject({ type: 'error', error: { code: 'CANCELLED' } })
    pending.resolve(result)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(test.terminal('discover')).toHaveLength(1)
  })

  it('bounds queued operations instead of creating an unbounded assembly wait list', async () => {
    const pending = deferred<VerifiedAsset>()
    const test = harness({ readAsset: vi.fn(() => pending.promise) })
    test.runtime.handleMessage(discover())
    await vi.waitFor(() => expect(test.terminal('discover')).toHaveLength(1))
    for (let index = 0; index < MAX_PENDING_REQUESTS + 1; index++) test.runtime.handleMessage(load(`asset-${index}`))
    expect(test.terminal(`asset-${MAX_PENDING_REQUESTS}`)[0]).toMatchObject({ type: 'error', error: { code: 'LIMIT' } })
    test.dispose()
    pending.resolve(asset())
  })
})
