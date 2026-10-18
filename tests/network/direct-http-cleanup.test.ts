import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectCleanupError } from '../../src/network/direct-transport'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { config, deferred, rawBlock, response } from './helpers'
import { providerRecord } from './provider-helpers'

const sources: ReturnType<typeof createIpfsBlockSourceWithOptions>[] = []
afterEach(async () => { for (const source of sources.splice(0)) { source.dispose(); await source.settled().catch(() => {}) } })
function badResponse(kind: 'headers' | 'stream' | 'abort', cancelError = new Error('underlying cancellation failed')) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { if (kind === 'stream') controller.enqueue(new Uint8Array(9)) },
    cancel() { return Promise.reject(cancelError) },
  }), { headers: kind === 'headers' ? { 'content-length': '99999999' } : {} })
}

describe('HTTP cleanup failure isolation', () => {
  it('quarantines a new cancellation-algorithm AbortError even when the request is aborted', async () => {
    const block = await rawBlock('ok')
    const controller = new AbortController()
    const cancelError = new DOMException('cancel algorithm failed', 'AbortError')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => badResponse('abort', cancelError))
    const source = createIpfsBlockSourceWithOptions(config(), { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress })
    sources.push(source)
    const outcome = source.get(block.cid, controller.signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort(cancelError)
    expect(await outcome).toBeInstanceOf(DirectCleanupError)
    await expect(source.settled()).rejects.toBeInstanceOf(DirectCleanupError)
    await expect(source.get(block.cid, new AbortController().signal)).rejects.toBeInstanceOf(DirectCleanupError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['routing headers', 'routing candidate cap', 'provider headers', 'provider stream', 'gateway headers', 'gateway stream', 'routing abort', 'provider abort', 'gateway abort', 'gateway reader abort'] as const)('quarantines %s cancellation failure instead of masking it or falling back', async path => {
    const block = await rawBlock('ok')
    const controller = new AbortController()
    const late = deferred<Response>()
    const cancelMode = path.endsWith('abort') ? 'abort' : path.endsWith('stream') ? 'stream' : 'headers'
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const host = new URL(input.toString()).hostname
      const router = host === 'delegated-ipfs.dev'
      const provider = host === 'provider.ipfs.tech'
      const targeted = path.startsWith('routing') ? router : path.startsWith('provider') ? provider : !router && !provider
      if (targeted) {
        if (path === 'routing candidate cap') return new Response(new ReadableStream({
          start(stream) { stream.enqueue(new TextEncoder().encode((JSON.stringify(providerRecord()) + '\n').repeat(16))) },
          cancel() { return Promise.reject(new Error('metadata cancellation failed')) },
        }), { headers: { 'content-type': 'application/x-ndjson' } })
        return path === 'gateway abort' ? late.promise : badResponse(cancelMode)
      }
      if (router) return new Response(JSON.stringify({ Providers: path.startsWith('provider')
        ? [providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https'])] : [] }), { headers: { 'content-type': 'application/json' } })
      return response(block.bytes)
    })
    const source = createIpfsBlockSourceWithOptions(config(undefined, { maxBlockBytes: 8 }), {
      fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress,
    })
    sources.push(source)
    const operation = source.get(block.cid, controller.signal)
    const outcome = operation.then(value => value, (error: unknown) => error)
    if (cancelMode === 'abort') {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(path.startsWith('routing') ? 1 : 2))
      controller.abort()
      if (path === 'gateway abort') late.resolve(badResponse('abort'))
    }
    expect(await outcome).toBeInstanceOf(DirectCleanupError)
    await expect(source.settled()).rejects.toBeInstanceOf(DirectCleanupError)
    const calls = fetch.mock.calls.length
    expect(calls).toBe(path.startsWith('routing') ? 1 : 2)
    await expect(source.get(block.cid, new AbortController().signal)).rejects.toBeInstanceOf(DirectCleanupError)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })
})
