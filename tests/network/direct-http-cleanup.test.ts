import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { PROVIDER_LIMITS } from '../../src/network/provider-routing'
import { config, deferred, rawBlock, response } from './helpers'
import { providerRecord } from './provider-helpers'

let DirectCleanupError: typeof import('../../src/network/direct-transport').DirectCleanupError
let createIpfsBlockSourceWithOptions: typeof import('../../src/network/ipfs-source').createIpfsBlockSourceWithOptions
beforeEach(async () => {
  // Each case owns a fresh budget; unknown cleanup debt is never released in its realm.
  vi.resetModules()
  DirectCleanupError = (await import('../../src/network/direct-transport')).DirectCleanupError
  createIpfsBlockSourceWithOptions = (await import('../../src/network/ipfs-source')).createIpfsBlockSourceWithOptions
})

const sources: ReturnType<typeof createIpfsBlockSourceWithOptions>[] = []
afterEach(async () => { for (const source of sources.splice(0)) { source.dispose(); await source.settled().catch(() => {}) } })
function badResponse(kind: 'headers' | 'stream' | 'abort', cancelError = new Error('underlying cancellation failed'), reading?: ReturnType<typeof deferred<void>>) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { if (kind === 'stream') controller.enqueue(new Uint8Array(9)) },
    cancel() { return Promise.reject(cancelError) },
  })
  if (reading) {
    const getReader = body.getReader.bind(body)
    body.getReader = (() => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      reader.read = () => { reading.resolve(); return read() }
      return reader
    }) as typeof body.getReader
  }
  return new Response(body, { headers: kind === 'headers' ? { 'content-length': '99999999' } : {} })
}

describe('HTTP cleanup failure isolation', () => {
  it('quarantines a new cancellation-algorithm AbortError even when the request is aborted', async () => {
    const block = await rawBlock('ok')
    const controller = new AbortController()
    const cancelError = new DOMException('cancel algorithm failed', 'AbortError')
    const reading = deferred<void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => new URL(input.toString()).hostname === 'delegated-ipfs.dev'
      ? badResponse('abort', cancelError, reading) : new Response(null, { status: 404 }))
    const source = createIpfsBlockSourceWithOptions(config(), { fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress })
    sources.push(source)
    const outcome = source.get(block.cid, controller.signal).catch((error: unknown) => error)
    await reading.promise
    controller.abort(cancelError)
    expect(await outcome).toBeInstanceOf(DirectCleanupError)
    await expect(source.settled()).rejects.toBeInstanceOf(DirectCleanupError)
    const calls = fetch.mock.calls.length
    await expect(source.get(block.cid, new AbortController().signal)).rejects.toBeInstanceOf(DirectCleanupError)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it.each(['routing headers', 'routing scan cap', 'provider headers', 'provider stream', 'gateway headers', 'gateway stream', 'routing abort', 'provider abort', 'gateway abort', 'gateway reader abort'] as const)('quarantines %s cancellation failure instead of masking it or falling back', async path => {
    const block = await rawBlock('ok')
    const controller = new AbortController()
    const late = deferred<Response>()
    const reading = deferred<void>()
    const requested = deferred<void>()
    const cancelling = deferred<void>()
    const cancelFailure = deferred<void>()
    const cancelMode = path.endsWith('abort') ? 'abort' : path.endsWith('stream') ? 'stream' : 'headers'
    const targetHost = path.startsWith('routing') ? 'delegated-ipfs.dev' : path.startsWith('provider') ? 'provider.ipfs.tech' : 'a.gateway.net'
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const host = new URL(input.toString()).hostname
      if (host === targetHost) {
        requested.resolve()
        if (path === 'routing scan cap') return new Response(new ReadableStream({
          start(stream) { stream.enqueue(new TextEncoder().encode((JSON.stringify(providerRecord()) + '\n').repeat(PROVIDER_LIMITS.scanned))) },
          cancel() { cancelling.resolve(); return cancelFailure.promise },
        }), { headers: { 'content-type': 'application/x-ndjson' } })
        return path === 'gateway abort' ? late.promise : badResponse(cancelMode, undefined, reading)
      }
      if (host === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: path.startsWith('provider')
        ? [providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https'])] : [] }), { headers: { 'content-type': 'application/json' } })
      if (path.startsWith('provider')) return new Response(null, { status: 404 })
      if (path === 'routing scan cap') await cancelling.promise
      if (path === 'routing abort') await new Promise<void>(resolve => {
        if (init!.signal!.aborted) resolve()
        else init!.signal!.addEventListener('abort', () => resolve(), { once: true })
      })
      return response(block.bytes)
    })
    const source = createIpfsBlockSourceWithOptions(config(undefined, { maxBlockBytes: 8 }), {
      fetch, router: 'https://delegated-ipfs.dev', policy: publicProviderAddress,
    })
    sources.push(source)
    const operation = source.get(block.cid, controller.signal)
    const outcome = operation.then(value => value, (error: unknown) => error)
    try {
      if (path === 'routing scan cap') {
        await vi.waitFor(() => expect(source.snapshot().reduce((total, gateway) => total + gateway.successes, 0)).toBe(1))
        cancelFailure.reject(new Error('metadata cancellation failed'))
      }
      if (cancelMode === 'abort') {
        await (path === 'gateway abort' ? requested.promise : reading.promise)
        controller.abort()
        if (path === 'gateway abort') late.resolve(badResponse('abort'))
      }
      expect(await outcome).toBeInstanceOf(DirectCleanupError)
      await expect(source.settled()).rejects.toBeInstanceOf(DirectCleanupError)
      expect(fetch.mock.calls.some(([input]) => new URL(input.toString()).hostname === targetHost)).toBe(true)
      const calls = fetch.mock.calls.length
      await expect(source.get(block.cid, new AbortController().signal)).rejects.toBeInstanceOf(DirectCleanupError)
      expect(fetch).toHaveBeenCalledTimes(calls)
    } finally {
      controller.abort()
      cancelFailure.resolve()
      late.resolve(badResponse('abort'))
    }
  })
})
