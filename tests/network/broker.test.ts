import { afterEach, describe, expect, it, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { createGatewayBroker } from '../../src/network/broker'
import type { VerifiedBlockSource } from '../../src/network/types'
import { cidFromRequest, config, deferred, rawBlock, response, signal } from './helpers'

const brokers: VerifiedBlockSource[] = []
function broker(fetch: typeof globalThis.fetch, settings = config()) {
  const source = createGatewayBroker(settings, { fetch, now: () => Date.now(), random: () => 0 })
  brokers.push(source)
  return source
}

afterEach(() => { for (const source of brokers.splice(0)) source.dispose(); vi.useRealTimers() })

describe('verified gateway fetch', () => {
  it('falls back on corruption and keeps cache buffers isolated from mutation and transfer', async () => {
    const block = await rawBlock('verified content')
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      response(new URL(input.toString()).hostname.startsWith('a.') ? Uint8Array.of(9, 9) : block.bytes),
    )
    const source = broker(fetch, config(['https://a.gateway.net/prefix/', 'https://b.gateway.net']))
    const first = await source.get(block.cid, signal())
    expect(first).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://a.gateway.net/prefix/ipfs/${block.cid}?format=raw`)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/vnd.ipld.raw' },
    })
    const failed = source.snapshot()[0]
    expect(failed).toMatchObject({ state: 'cooldown', failures: 1, inFlight: 0 })
    expect((failed?.cooldownUntil ?? 0) - Date.now()).toBeGreaterThanOrEqual(59_900)
    first.fill(0)
    const second = await source.get(block.cid, signal())
    expect(second).toEqual(block.bytes)
    structuredClone(second.buffer, { transfer: [second.buffer] })
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
    const stats = source.snapshot()
    stats[1]!.successes = 999
    expect(source.snapshot()[1]?.successes).toBe(1)
  })

  it('uses byte-accounted LRU eviction, not a count cache', async () => {
    const blocks = await Promise.all(['aaaa', 'bbbb', 'cccc'].map(rawBlock))
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => response(blocks.find((block) => block.cid === cidFromRequest(input))!.bytes))
    const source = broker(fetch, config(['https://a.gateway.net'], { maxBlockCacheBytes: 8 }))
    await source.get(blocks[0]!.cid, signal())
    await source.get(blocks[1]!.cid, signal())
    await source.get(blocks[0]!.cid, signal())
    await source.get(blocks[2]!.cid, signal())
    await source.get(blocks[0]!.cid, signal())
    expect(fetch).toHaveBeenCalledTimes(3)
    await source.get(blocks[1]!.cid, signal())
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('satisfies bounded identity CIDs without contacting a gateway', async () => {
    const bytes = new TextEncoder().encode('inline')
    const cid = CID.createV1(0x55, identity.digest(bytes)).toString()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const source = broker(fetch)
    expect(await source.get(cid, signal())).toEqual(bytes)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('counts streamed bytes even with a dishonest content-length and cancels oversize bodies', async () => {
    const block = await rawBlock('ok')
    let cancelled = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (new URL(input.toString()).hostname.startsWith('b.')) return response(block.bytes)
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(5)) },
        cancel() { cancelled = true },
      }), { headers: { 'content-length': '1' } })
    })
    const source = broker(fetch, config(undefined, { maxBlockBytes: 8 }))
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(cancelled).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(source.snapshot()[0]).toMatchObject({ failures: 1, state: 'cooldown' })
  })

  it('rejects redirects rather than accepting verified bytes from an undisclosed host', async () => {
    const block = await rawBlock('redirected')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const result = response(block.bytes)
      Object.defineProperty(result, 'redirected', { value: true })
      return result
    })
    await expect(broker(fetch, config(['https://a.gateway.net'])).get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  })

  it('reports an integrity failure after trying every configured gateway once', async () => {
    const block = await rawBlock('cannot corrupt')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(Uint8Array.of(1)))
    await expect(broker(fetch).get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('treats 404 as local to this CID without a global cooldown', async () => {
    const block = await rawBlock('present elsewhere')
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      new URL(input.toString()).hostname.startsWith('a.') ? new Response(null, { status: 404 }) : response(block.bytes),
    )
    const source = broker(fetch)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(source.snapshot()[0]).toMatchObject({ state: 'healthy', failures: 1 })
    expect(source.snapshot()[0]?.cooldownUntil).toBeUndefined()
    const missing = broker(async () => new Response(null, { status: 404 }))
    await expect(missing.get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(missing.snapshot().every((gateway) => gateway.state === 'healthy')).toBe(true)
  })
})

describe('shared-flight cancellation and caps', () => {
  it('does not abort a shared flight until its last consumer cancels', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('shared')
    const pending = deferred<Response>()
    let fetchSignal: AbortSignal | null | undefined
    const fetch = vi.fn<typeof globalThis.fetch>((_input, options) => { fetchSignal = options?.signal; return pending.promise })
    const source = broker(fetch)
    const a = new AbortController()
    const b = new AbortController()
    const first = source.get(block.cid, a.signal)
    const firstRejected = expect(first).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    const second = source.get(block.cid, b.signal)
    await vi.advanceTimersByTimeAsync(0)
    a.abort()
    await firstRejected
    expect(fetchSignal?.aborted).toBe(false)
    pending.resolve(response(block.bytes))
    expect(await second).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(source.snapshot()[0]?.failures).toBe(0)
  })

  it('aborts the last consumer, releases slots, and permits a fresh same-CID request', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('cancel and retry')
    let fetchSignal: AbortSignal | null | undefined
    let attempts = 0
    const fetch = vi.fn<typeof globalThis.fetch>((_input, options) => {
      fetchSignal = options?.signal
      return ++attempts === 1 ? new Promise<Response>(() => {}) : Promise.resolve(response(block.bytes))
    })
    const source = broker(fetch)
    const controller = new AbortController()
    const rejected = expect(source.get(block.cid, controller.signal)).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSignal?.aborted).toBe(true)
    expect(source.snapshot().every((gateway) => gateway.inFlight === 0 && gateway.failures === 0)).toBe(true)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('enforces global and per-gateway concurrency under a queued burst', async () => {
    vi.useFakeTimers()
    const blocks = await Promise.all(Array.from({ length: 12 }, (_, index) => rawBlock(`burst-${index}`)))
    const perHost = new Map<string, number>()
    let active = 0
    let maxActive = 0
    let maxPerHost = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const host = new URL(input.toString()).host
      perHost.set(host, (perHost.get(host) ?? 0) + 1)
      maxPerHost = Math.max(maxPerHost, perHost.get(host)!)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--
      perHost.set(host, perHost.get(host)! - 1)
      return response(blocks.find((block) => block.cid === cidFromRequest(input))!.bytes)
    })
    const source = broker(fetch, config(undefined, { maxBlockConcurrency: 3, maxGatewayConcurrency: 2 }))
    const result = Promise.all(blocks.map((block) => source.get(block.cid, signal())))
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toEqual(blocks.map((block) => block.bytes))
    expect(maxActive).toBe(3)
    expect(maxPerHost).toBe(2)
    expect(source.snapshot().every((gateway) => gateway.inFlight === 0)).toBe(true)
  })

  it('cancels queued requests and dispose terminates all active consumers without penalties', async () => {
    vi.useFakeTimers()
    const blocks = await Promise.all(['active', 'queued'].map(rawBlock))
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const source = broker(fetch, config(undefined, { maxBlockConcurrency: 1 }))
    const active = expect(source.get(blocks[0]!.cid, signal())).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    const queuedController = new AbortController()
    const queued = expect(source.get(blocks[1]!.cid, queuedController.signal)).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await vi.advanceTimersByTimeAsync(0)
    queuedController.abort()
    await queued
    expect(fetch).toHaveBeenCalledTimes(1)
    source.dispose()
    await active
    source.dispose()
    await expect(source.get(blocks[0]!.cid, signal())).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    expect(source.snapshot().every((gateway) => gateway.inFlight === 0 && gateway.failures === 0)).toBe(true)
  })

  it('preserves an external deadline as TIMEOUT rather than reporting user cancellation', async () => {
    const block = await rawBlock('external deadline')
    const controller = new AbortController()
    controller.abort(new DOMException('deadline', 'TimeoutError'))
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(broker(fetch).get(block.cid, controller.signal)).rejects.toMatchObject({ error: { code: 'TIMEOUT' } })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('adaptive scheduling and recovery', () => {
  it('explores an unmeasured gateway, favors its faster EWMA, and splits under load', async () => {
    vi.useFakeTimers()
    const blocks = await Promise.all(Array.from({ length: 13 }, (_, index) => rawBlock(`adaptive-${index}`)))
    const hosts: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const host = new URL(input.toString()).hostname
      hosts.push(host)
      await new Promise((resolve) => setTimeout(resolve, host.startsWith('a.') ? 8 : 5))
      return response(blocks.find((block) => block.cid === cidFromRequest(input))!.bytes)
    })
    const source = broker(fetch, config(undefined, { maxBlockConcurrency: 3, maxGatewayConcurrency: 2 }))
    for (const block of blocks.slice(0, 10)) {
      const request = source.get(block.cid, signal())
      await vi.advanceTimersByTimeAsync(10)
      await request
    }
    expect(hosts.slice(0, 9)).toEqual(Array<string>(9).fill('a.gateway.net'))
    expect(hosts[9]).toBe('b.gateway.net')
    const burst = Promise.all(blocks.slice(10).map((block) => source.get(block.cid, signal())))
    await vi.advanceTimersByTimeAsync(10)
    await burst
    expect(hosts.slice(10)).toEqual(['b.gateway.net', 'a.gateway.net', 'b.gateway.net'])
    expect(source.snapshot().map((gateway) => gateway.ewmaMs)).toEqual([8, 5])
  })

  it.each([
    { status: 429, header: '90', expected: 90_000 },
    { status: 503, header: new Date(90_000).toUTCString(), expected: 90_000 },
    { status: 429, header: '99999999', expected: 120_000 },
    { status: 503, header: 'invalid', expected: 2000 },
  ])('honors and caps Retry-After for $status/$header, with one recovery probe', async ({ status, header, expected }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const blocks = await Promise.all(['limited', 'probe', 'after-probe'].map(rawBlock))
    const pending = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (fetch.mock.calls.length === 1) return Promise.resolve(new Response(null, { status, headers: { 'Retry-After': header } }))
      if (fetch.mock.calls.length === 2) return pending.promise
      return Promise.resolve(response(blocks.find((block) => block.cid === cidFromRequest(input))!.bytes))
    })
    const source = broker(fetch, config(['https://a.gateway.net'], { blockTimeoutMs: 130_000, gatewayTimeoutMs: 130_000 }))
    await expect(source.get(blocks[0]!.cid, signal())).rejects.toMatchObject({ error: { code: 'NETWORK' } })
    expect(source.snapshot()[0]?.cooldownUntil).toBe(expected)
    const probing = source.get(blocks[1]!.cid, signal())
    const queued = source.get(blocks[2]!.cid, signal())
    await vi.advanceTimersByTimeAsync(expected - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(source.snapshot()[0]).toMatchObject({ state: 'probing', inFlight: 1 })
    pending.resolve(response(blocks[1]!.bytes))
    expect(await probing).toEqual(blocks[1]!.bytes)
    expect(await queued).toEqual(blocks[2]!.bytes)
    expect(source.snapshot()[0]).toMatchObject({ state: 'healthy', inFlight: 0, successes: 2 })
  })

  it('times out while every gateway is cooling, without busy retries', async () => {
    vi.useFakeTimers()
    const blocks = await Promise.all(['corrupt', 'waiting'].map(rawBlock))
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(Uint8Array.of(0)))
    const source = broker(fetch)
    await expect(source.get(blocks[0]!.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
    const waiting = expect(source.get(blocks[1]!.cid, signal())).rejects.toMatchObject({ error: { code: 'TIMEOUT' } })
    await vi.advanceTimersByTimeAsync(30_000)
    await waiting
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(source.snapshot().every((gateway) => gateway.failures === 1 && gateway.inFlight === 0)).toBe(true)
  })

  it('times out stalled body streaming and falls back within the total block deadline', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('fallback after timeout')
    let cancelled = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (new URL(input.toString()).hostname.startsWith('b.')) return response(block.bytes)
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
    })
    const source = broker(fetch, config(undefined, { gatewayTimeoutMs: 100, blockTimeoutMs: 300 }))
    const request = source.get(block.cid, signal())
    await vi.advanceTimersByTimeAsync(100)
    expect(await request).toEqual(block.bytes)
    expect(cancelled).toBe(true)
    expect(source.snapshot()[0]).toMatchObject({ state: 'cooldown', failures: 1 })
  })

  it('does not let an older concurrent success erase an integrity cooldown', async () => {
    vi.useFakeTimers()
    const blocks = await Promise.all(['good', 'bad'].map(rawBlock))
    const pending = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>((input) =>
      cidFromRequest(input) === blocks[0]!.cid ? pending.promise : Promise.resolve(response(Uint8Array.of(0))),
    )
    const source = broker(fetch, config(['https://a.gateway.net']))
    const good = source.get(blocks[0]!.cid, signal())
    await expect(source.get(blocks[1]!.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
    pending.resolve(response(blocks[0]!.bytes))
    await good
    expect(source.snapshot()[0]).toMatchObject({ state: 'cooldown', successes: 1, failures: 1 })
  })
})
