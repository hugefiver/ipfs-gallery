import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { networkError } from '../../src/network/errors'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { sourceBudget } from '../../src/network/source-scheduler'
import { cidFromRequest, config, deferred, rawBlock, response, signal } from './helpers'
import { providerRecord } from './provider-helpers'

const sources: ReturnType<typeof createIpfsBlockSourceWithOptions>[] = []
afterEach(async () => { for (const source of sources.splice(0)) { source.dispose(); await source.drained?.() }; vi.useRealTimers() })
const routing = () => new Response(JSON.stringify({ Providers: [providerRecord()] }), { headers: { 'content-type': 'application/json' } })
function make(fetch: typeof globalThis.fetch, retrieve = vi.fn()) {
  const source = createIpfsBlockSourceWithOptions(config(undefined, { gatewayTimeoutMs: 10_000, blockTimeoutMs: 15_000 }),
    { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress, transport: { retrieve, dispose() {} } })
  sources.push(source)
  return source
}
describe('adaptive source real fetch and cleanup seams', () => {
  it('starts a known gateway while fresh routing is still pending', async () => {
    const block = await rawBlock('routing cannot serialize the gateway')
    let routingAborted = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (new URL(input.toString()).hostname === 'delegated-ipfs.dev') return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => { routingAborted = true; reject(init!.signal!.reason) }, { once: true })
      })
      return response(block.bytes)
    })
    expect(await make(fetch).get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(routingAborted).toBe(true)
    expect(sourceBudget.usage()).toMatchObject({ attempts: 0, bytes: 0, routing: 0 })
  })
  it('lets the slow primary succeed after a soft threshold instead of cancelling it', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('slow primary still useful')
    let directAborted = false
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname === 'delegated-ipfs.dev') return routing()
      await new Promise(resolve => setTimeout(resolve, 4000))
      return response(block.bytes)
    })
    const retrieve = vi.fn((_cid, _provider, _address, current: AbortSignal) => new Promise<Uint8Array>((_, reject) => {
      current.addEventListener('abort', () => { directAborted = true; reject(current.reason) }, { once: true })
    }))
    const source = make(fetch, retrieve)
    const result = source.get(block.cid, signal())
    await vi.advanceTimersByTimeAsync(2500)
    expect(retrieve).toHaveBeenCalledOnce()
    expect(sourceBudget.usage().attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await result).toEqual(block.bytes)
    expect(directAborted).toBe(true)
    expect(source.snapshot()[0]).toMatchObject({ successes: 1, failures: 0 })
  })
  it('uses a verified small foreground block to recover a cooled HTTPS candidate in maintenance', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const block = await rawBlock('background health sample')
    let recovered = false
    const hosts: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      hosts.push(host)
      if (host === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: [] }), {
        headers: { 'content-type': 'application/json' },
      })
      if (host === 'a.gateway.net' && !recovered) return new Response(null, { status: 503 })
      return response(block.bytes)
    })
    const source = make(fetch)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(hosts.filter(host => host === 'a.gateway.net')).toHaveLength(1)
    recovered = true
    await vi.advanceTimersByTimeAsync(20_000)
    await source.maintain!([block.cid], signal())
    expect(hosts.filter(host => host === 'a.gateway.net')).toHaveLength(2)
    expect(source.snapshot()[0]).toMatchObject({ successes: 1, failures: 1, inFlight: 0 })
  })
  it('restores an evicted verified seed on cache hit before maintenance probes it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const blocks = await Promise.all(Array.from({ length: 33 }, (_, index) => rawBlock(`cached seed ${index}`)))
    const byCid = new Map(blocks.map(block => [block.cid, block.bytes]))
    const gatewayCalls = new Map<string, number>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: [] }), {
        headers: { 'content-type': 'application/json' },
      })
      const cid = cidFromRequest(input)
      gatewayCalls.set(cid, (gatewayCalls.get(cid) ?? 0) + 1)
      return response(byCid.get(cid)!)
    })
    const source = createIpfsBlockSourceWithOptions(config(['https://a.gateway.net'], {
      gatewayTimeoutMs: 10_000, blockTimeoutMs: 15_000,
    }), { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress,
      transport: { retrieve: vi.fn(), dispose() {} } })
    sources.push(source)
    for (const block of blocks) expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    const first = blocks[0]!
    const foregroundCalls = fetch.mock.calls.length
    expect(await source.get(first.cid, signal())).toEqual(first.bytes)
    expect(fetch).toHaveBeenCalledTimes(foregroundCalls)
    expect(gatewayCalls.get(first.cid)).toBe(1)
    await vi.advanceTimersByTimeAsync(160_000)
    await source.maintain!([first.cid], signal())
    expect(gatewayCalls.get(first.cid)).toBe(2)
  })
  it.each([
    { label: 'seconds', header: '120' },
    { label: 'HTTP-date', header: new Date(140_000).toUTCString() },
  ])('honors bounded $label Retry-After from a background health response', async ({ header }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const block = await rawBlock(`health retry ${header}`)
    let background = false
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      if (host === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: [] }), {
        headers: { 'content-type': 'application/json' },
      })
      if (host === 'a.gateway.net') return new Response(null, {
        status: 503, headers: background ? { 'retry-after': header } : {},
      })
      return response(block.bytes)
    })
    const source = make(fetch)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    background = true
    await vi.advanceTimersByTimeAsync(20_000)
    await source.maintain!([block.cid], signal())
    expect(source.snapshot()[0]?.cooldownUntil).toBe(140_000)
  })
  it('settles a cancelled routing round cleanly and gives the next round to health', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const block = await rawBlock('router timeout health fairness')
    let hangingRouter = false
    let routerCancels = 0
    let gatewayCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const host = new URL(input.toString()).hostname
      if (host === 'delegated-ipfs.dev') {
        if (!hangingRouter) return new Response(JSON.stringify({ Providers: [] }), {
          headers: { 'content-type': 'application/json' },
        })
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => { routerCancels++; reject(init!.signal!.reason) }
          init!.signal!.addEventListener('abort', abort, { once: true })
          if (init!.signal!.aborted) abort()
        })
      }
      if (host === 'a.gateway.net') {
        gatewayCalls++
        return gatewayCalls === 1 ? new Response(null, { status: 503 }) : response(block.bytes)
      }
      return response(block.bytes)
    })
    const source = createIpfsBlockSourceWithOptions(config(undefined, {
      gatewayTimeoutMs: 10_000, blockTimeoutMs: 60_000,
    }), { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress,
      transport: { retrieve: vi.fn(), dispose() {} } })
    sources.push(source)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    hangingRouter = true
    await vi.advanceTimersByTimeAsync(20_000)
    const firstController = new AbortController()
    setTimeout(() => firstController.abort(networkError('TIMEOUT', 'maintenance deadline')), 30_000)
    const first = source.maintain!([block.cid], firstController.signal)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(first).resolves.toBeUndefined()
    expect(routerCancels).toBe(1)
    expect(gatewayCalls).toBe(1)
    await source.maintain!([block.cid], signal())
    expect(gatewayCalls).toBe(2)
  })
  it('keeps foreground settled independent while drained waits for an actual health reader cancel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const block = await rawBlock('health cleanup')
    const cleanup = deferred<void>()
    let background = false
    let gatewayCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      if (host === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: [] }), {
        headers: { 'content-type': 'application/json' },
      })
      if (host === 'a.gateway.net') {
        gatewayCalls++
        if (!background) return new Response(null, { status: 503 })
        return new Response(new ReadableStream({ cancel: () => cleanup.promise }))
      }
      return response(block.bytes)
    })
    const source = make(fetch)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    background = true
    await vi.advanceTimersByTimeAsync(20_000)
    const maintaining = source.maintain!([block.cid], signal())
    await vi.waitFor(() => expect(gatewayCalls).toBe(2))
    await source.settled()
    source.dispose()
    let drained = false
    const drain = source.drained!().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    cleanup.resolve()
    await maintaining
    await drain
  })
  it('does not make foreground settled wait for maintenance, but drained waits for its real cancel', async () => {
    const block = await rawBlock('maintenance roots')
    const cleanup = deferred<void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel: () => cleanup.promise }),
      { headers: { 'content-type': 'application/json' } }))
    const source = make(fetch)
    const maintaining = source.maintain!([block.cid], signal())
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await source.settled()
    source.dispose()
    let drained = false
    const drain = source.drained!().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    cleanup.resolve()
    await maintaining
    await drain
    await source.maintain!([block.cid], signal())
    expect(fetch).toHaveBeenCalledOnce()
  })
})
