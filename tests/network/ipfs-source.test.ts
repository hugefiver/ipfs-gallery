import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpfsBlockSource, createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { networkError } from '../../src/network/errors'
import { DirectCleanupError } from '../../src/network/direct-transport'
import { createContentReader } from '../../src/network/reader'
import type { VerifiedBlockSource } from '../../src/network/types'
import { collectBytes, config, deferred, rawBlock, response, signal } from './helpers'
import { providerRecord } from './provider-helpers'

const sources: VerifiedBlockSource[] = []
afterEach(() => { for (const source of sources.splice(0)) source.dispose(); vi.useRealTimers() })
function source(fetch: typeof globalThis.fetch, retrieve = vi.fn(), settings = config()) {
  const result = createIpfsBlockSourceWithOptions(settings, {
    fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress, transport: { retrieve, dispose() {} },
  })
  sources.push(result)
  return result
}
const routing = (records: unknown[]) => new Response(JSON.stringify({ Providers: records }), { headers: { 'content-type': 'application/json' } })
const httpsProvider = () => providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https'])

describe('IPFS direct then explicit fallback source', () => {
  it('resolves identity locally without even querying the router', async () => {
    const bytes = new Uint8Array(1024).fill(7)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const result = source(fetch)
    expect(await result.get(CID.createV1(0x55, identity.digest(bytes)).toString(), signal())).toEqual(bytes)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('production factory is lazy and rejects invalid input before network', async () => {
    const result = createIpfsBlockSource(config())
    sources.push(result)
    await expect(result.get('not a CID', signal())).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    result.dispose()
  })

  it('prioritizes explicit WSS and serves verified cache hits without another lookup', async () => {
    const block = await rawBlock('direct')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([httpsProvider(), providerRecord()]))
    const retrieve = vi.fn(async () => block.bytes.slice())
    const result = source(fetch, retrieve)
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(result.snapshot().every(stat => stat.successes === 0 && stat.failures === 0)).toBe(true)
    await result.get(block.cid, signal())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honors the injected byte LRU cap and isolates returned buffers', async () => {
    const blocks = await Promise.all(['aaaa', 'bbbb', 'cccc'].map(rawBlock))
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const url = new URL(input.toString())
      if (url.hostname === 'delegated-ipfs.dev') return routing([httpsProvider()])
      return response(blocks.find(block => url.pathname.endsWith(block.cid))!.bytes)
    })
    const result = source(fetch, vi.fn(), config(undefined, { maxBlockCacheBytes: 8 }))
    const first = await result.get(blocks[0]!.cid, signal())
    first.fill(0)
    const cached = await result.get(blocks[0]!.cid, signal())
    expect(cached).toEqual(blocks[0]!.bytes)
    structuredClone(cached.buffer, { transfer: [cached.buffer] })
    expect(await result.get(blocks[0]!.cid, signal())).toEqual(blocks[0]!.bytes)
    await result.get(blocks[1]!.cid, signal())
    await result.get(blocks[0]!.cid, signal())
    await result.get(blocks[2]!.cid, signal())
    await result.get(blocks[0]!.cid, signal())
    expect(fetch).toHaveBeenCalledTimes(6)
    await result.get(blocks[1]!.cid, signal())
    expect(fetch).toHaveBeenCalledTimes(8)
  })

  it('respects a zero cache cap and partitions different bindings', async () => {
    const block = await rawBlock('binding cache')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const retrieve = vi.fn(async () => block.bytes.slice())
    const a = source(fetch, retrieve)
    const b = source(fetch, retrieve)
    await a.get(block.cid, signal())
    await a.get(block.cid, signal())
    await b.get(block.cid, signal())
    expect(retrieve).toHaveBeenCalledTimes(2)
    const disabled = source(fetch, retrieve, config(undefined, { maxBlockCacheBytes: 0 }))
    await disabled.get(block.cid, signal())
    await disabled.get(block.cid, signal())
    expect(retrieve).toHaveBeenCalledTimes(4)
  })

  it('never caches an integrity failure', async () => {
    const block = await rawBlock('uncorrupted')
    let corrupt = true
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname === 'delegated-ipfs.dev') return routing([httpsProvider()])
      return corrupt ? response(Uint8Array.of(8)) : response(block.bytes)
    })
    const result = source(fetch)
    await expect(result.get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
    corrupt = false
    const before = fetch.mock.calls.length
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(before + 2)
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(before + 2)
  })

  it('charges source cache hits to each reader operation input budget', async () => {
    const block = await rawBlock('reader cache input')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const retrieve = vi.fn(async () => block.bytes.slice())
    const result = source(fetch, retrieve)
    const reader = createContentReader(result, { maxInputBytes: block.bytes.byteLength * 2 })
    const ref = { cid: block.cid, path: [] }
    expect(await reader.stat(ref, signal())).toEqual({ kind: 'file', size: BigInt(block.bytes.byteLength) })
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: block.bytes.byteLength }))).toEqual(block.bytes)
    await expect(reader.stat(ref, signal())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('tries provider HTTPS after a candidate protocol restriction, with no gateway requests', async () => {
    const block = await rawBlock('provider HTTP')
    const calls: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      calls.push(input.toString())
      return calls.length === 1 ? routing([providerRecord(), httpsProvider()]) : response(block.bytes)
    })
    const retrieve = vi.fn(async () => { throw networkError('NETWORK', 'candidate protocol cap') })
    expect(await source(fetch, retrieve).get(block.cid, signal())).toEqual(block.bytes)
    expect(calls).toEqual([`https://delegated-ipfs.dev/routing/v1/providers/${block.cid}`, `https://provider.ipfs.tech/ipfs/${block.cid}?format=raw`])
  })

  it('validates HTTP provider bytes then invokes only configured gateway fallback', async () => {
    const block = await rawBlock('fallback verified')
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      if (host === 'delegated-ipfs.dev') return routing([httpsProvider()])
      return response(host === 'provider.ipfs.tech' ? Uint8Array.of(1) : block.bytes)
    })
    const result = source(fetch)
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result.snapshot()).toMatchObject([{ url: 'https://a.gateway.net', successes: 1 }, { url: 'https://b.gateway.net', successes: 0 }])
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('accepts a verified 4 MiB raw HTTP block without a Bitswap-only size restriction', async () => {
    const block = await rawBlock('x'.repeat(4 * 1024 * 1024))
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev' ? routing([httpsProvider()]) : response(block.bytes))
    expect(Buffer.from(await source(fetch).get(block.cid, signal())).equals(block.bytes)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('preserves a direct integrity error when the fallback fails ordinarily', async () => {
    const block = await rawBlock('integrity')
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      if (host === 'delegated-ipfs.dev') return routing([httpsProvider()])
      return host === 'provider.ipfs.tech' ? response(Uint8Array.of(8)) : new Response(null, { status: 502 })
    })
    await expect(source(fetch).get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
  })

  it.each(['LIMIT', 'CANCELLED', 'INVALID_INPUT'] as const)('does not fall back after %s', async code => {
    const block = await rawBlock(code)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord(), httpsProvider()]))
    const retrieve = vi.fn(async () => { throw networkError(code, 'terminal') })
    await expect(source(fetch, retrieve).get(block.cid, signal())).rejects.toMatchObject({ error: { code } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retains its binding slot until cancelled direct work actually exits', async () => {
    const block = await rawBlock('settlement')
    const pending = deferred<Uint8Array>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const retrieve = vi.fn(() => pending.promise)
    const result = source(fetch, retrieve, config(undefined, { maxBlockConcurrency: 1 }))
    const controller = new AbortController()
    const operation = result.get(block.cid, controller.signal)
    const rejected = expect(operation).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await vi.waitFor(() => expect(retrieve).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(result.get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    pending.resolve(block.bytes)
    await rejected
    expect(await result.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('waits for direct cancellation cleanup before entering the remaining-deadline gateway stage', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('phase timeout')
    const pending = deferred<Uint8Array>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev' ? routing([providerRecord()]) : response(block.bytes))
    const retrieve = vi.fn(() => pending.promise)
    const result = source(fetch, retrieve)
    const operation = result.get(block.cid, signal())
    await vi.advanceTimersByTimeAsync(10001)
    expect(fetch).toHaveBeenCalledTimes(1)
    pending.reject(networkError('TIMEOUT', 'direct done'))
    expect(await operation).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('strict fallback keeps the slot and telemetry until aborted fetch settles', async () => {
    const block = await rawBlock('fallback settlement')
    const pending = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev' ? routing([]) : pending.promise)
    const result = source(fetch, vi.fn(), config(undefined, { maxBlockConcurrency: 1 }))
    const controller = new AbortController()
    const operation = result.get(block.cid, controller.signal)
    const rejected = expect(operation).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    controller.abort()
    expect(result.snapshot()[0]?.inFlight).toBe(1)
    await expect(result.get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    pending.resolve(response(block.bytes))
    await rejected
    expect(result.snapshot()[0]?.inFlight).toBe(0)
  })

  it('does not enter fallback when direct cleanup exhausts the outer deadline', async () => {
    vi.useFakeTimers()
    const block = await rawBlock('outer deadline')
    const pending = deferred<Uint8Array>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const result = source(fetch, vi.fn(() => pending.promise))
    const operation = result.get(block.cid, signal())
    const rejected = expect(operation).rejects.toMatchObject({ error: { code: 'TIMEOUT' } })
    await vi.advanceTimersByTimeAsync(30001)
    pending.reject(networkError('TIMEOUT', 'cleanup complete'))
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('dispose initiates cancellation synchronously but preserves real cleanup ownership', async () => {
    const block = await rawBlock('dispose')
    const pending = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev' ? routing([]) : pending.promise)
    const result = source(fetch)
    const operation = result.get(block.cid, signal())
    const rejected = expect(operation).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    let settled = false
    void operation.catch(() => {}).then(() => { settled = true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    result.dispose()
    const barrier = result.settled()
    let cleaned = false
    void barrier.then(() => { cleaned = true })
    expect(result.snapshot()[0]?.inFlight).toBe(1)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(cleaned).toBe(false)
    pending.resolve(response(block.bytes))
    await rejected
    await barrier
    expect(result.snapshot()[0]?.inFlight).toBe(0)
  })

  it('isolates cleanup failure without fallback, caching or a successful barrier', async () => {
    const block = await rawBlock('cleanup failure')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord(), httpsProvider()]))
    const retrieve = vi.fn(async () => { throw new DirectCleanupError() })
    const result = source(fetch, retrieve)
    await expect(result.get(block.cid, signal())).rejects.toBeInstanceOf(DirectCleanupError)
    await expect(result.settled()).rejects.toBeInstanceOf(DirectCleanupError)
    await expect(result.get(block.cid, signal())).rejects.toBeInstanceOf(DirectCleanupError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits for every captured operation before rejecting a failed cleanup barrier', async () => {
    const a = await rawBlock('failure A')
    const b = await rawBlock('pending B')
    const first = deferred<Uint8Array>()
    const second = deferred<Uint8Array>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const retrieve = vi.fn((cid: CID) => cid.toString() === a.cid ? first.promise : second.promise)
    const result = source(fetch, retrieve)
    const readA = result.get(a.cid, signal())
    const readB = result.get(b.cid, signal())
    const outcomeA = readA.catch((error: unknown) => error)
    const outcomeB = readB.catch((error: unknown) => error)
    await vi.waitFor(() => expect(retrieve).toHaveBeenCalledTimes(2))
    const barrier = result.settled()
    let settled = false
    void barrier.then(() => { settled = true }, () => { settled = true })
    first.reject(new DirectCleanupError())
    expect(await outcomeA).toBeInstanceOf(DirectCleanupError)
    expect(settled).toBe(false)
    second.resolve(b.bytes)
    expect(await outcomeB).toBeInstanceOf(DirectCleanupError)
    await expect(barrier).rejects.toBeInstanceOf(DirectCleanupError)
  })

  it('captures a settlement snapshot without waiting for later independent reads', async () => {
    const a = await rawBlock('snapshot A')
    const b = await rawBlock('later B')
    const first = deferred<Uint8Array>()
    const second = deferred<Uint8Array>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const retrieve = vi.fn((cid: CID) => cid.toString() === a.cid ? first.promise : second.promise)
    const result = source(fetch, retrieve)
    const readA = result.get(a.cid, signal())
    const barrier = result.settled()
    const readB = result.get(b.cid, signal())
    let laterSettled = false
    void readB.then(() => { laterSettled = true })
    first.resolve(a.bytes)
    expect(await readA).toEqual(a.bytes)
    await barrier
    expect(laterSettled).toBe(false)
    second.resolve(b.bytes)
    expect(await readB).toEqual(b.bytes)
  })
})
