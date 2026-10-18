import { CID } from 'multiformats/cid'
import { create as digest } from 'multiformats/hashes/digest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { brokerConfiguredGatewayEvidence, createGatewayBroker } from '../../src/network/broker'
import { configuredGatewayEvidence, createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { networkError } from '../../src/network/errors'
import type { VerifiedBlockSource } from '../../src/network/types'
import { parseBlockCid, verifyBlock } from '../../src/network/verify'
import { config, rawBlock, response, signal } from './helpers'
import { providerRecord } from './provider-helpers'

const sources: VerifiedBlockSource[] = []
afterEach(() => { for (const source of sources.splice(0)) source.dispose() })
function broker(fetch: typeof globalThis.fetch) {
  const source = createGatewayBroker(config(['https://gateway.net']), {
    fetch, now: Date.now, random: () => 0, settleOnAbort: true,
  })
  sources.push(source)
  return source
}
const routing = (records: unknown[]) => new Response(JSON.stringify({ Providers: records }), {
  headers: { 'content-type': 'application/json' },
})
function ipfs(fetch: typeof globalThis.fetch, retrieve = vi.fn(), gateways = ['https://gateway.net']) {
  const source = createIpfsBlockSourceWithOptions(config(gateways), {
    fetch, router: 'https://router.example', policy: publicProviderAddress,
    transport: { retrieve, dispose() {} },
  })
  sources.push(source)
  return source
}

describe('compiled configured-gateway policy', () => {
  it('keeps verifyBlock strict regardless of the compiled gateway exception', async () => {
    const block = await rawBlock('strict primitive')
    await expect(verifyBlock(parseBlockCid(block.cid, 100), Uint8Array.of(9), 100))
      .rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
  })

  it('binds any gateway exception to the producing source, canonical CID and exclusive returned object', async () => {
    const block = await rawBlock('requested bytes')
    const replacement = Uint8Array.of(1, 2, 3)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(replacement))
    const source = broker(fetch)
    if (BUILD_POLICY.trustless) {
      await expect(source.get(block.cid, signal())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
      return
    }
    const [first, second] = await Promise.all([source.get(block.cid, signal()), source.get(block.cid, signal())])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(first).toEqual(replacement)
    expect(second).toEqual(replacement)
    expect(first).not.toBe(second)
    expect(brokerConfiguredGatewayEvidence(source, block.cid, first)).toEqual({
      canonicalCid: block.cid, gateway: 'https://gateway.net', byteLength: replacement.byteLength,
    })
    expect(brokerConfiguredGatewayEvidence(source, block.cid, second)).toBeDefined()
    expect(brokerConfiguredGatewayEvidence(source, block.cid, first.slice())).toBeUndefined()
    expect(brokerConfiguredGatewayEvidence(source, (await rawBlock('other CID')).cid, first)).toBeUndefined()
    expect(brokerConfiguredGatewayEvidence(broker(fetch), block.cid, first)).toBeUndefined()
    first.fill(0)
    structuredClone(second.buffer, { transfer: [second.buffer] })
    expect(await source.get(block.cid, signal())).toEqual(replacement)
    expect(fetch).toHaveBeenCalledTimes(2)
    source.dispose()
    expect(brokerConfiguredGatewayEvidence(source, block.cid, first)).toBeUndefined()
  })

  it('retains verified gateway caching only in strict builds and isolates cache buffers', async () => {
    const block = await rawBlock('cache isolation')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(block.bytes))
    const source = broker(fetch)
    const first = await source.get(block.cid, signal())
    first.fill(0)
    const second = await source.get(block.cid, signal())
    expect(second).toEqual(block.bytes)
    structuredClone(second.buffer, { transfer: [second.buffer] })
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(fetch).toHaveBeenCalledTimes(BUILD_POLICY.trustless ? 1 : 3)
  })

  it('verifies WSS and HTTPS providers even when the HTTPS provider equals a configured gateway', async () => {
    const block = await rawBlock('provider requested bytes')
    const corrupt = Uint8Array.of(8)
    const fallback = BUILD_POLICY.trustless ? block.bytes : Uint8Array.of(4, 5)
    let blockCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname === 'router.example') return routing([
        providerRecord(), providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https']),
      ])
      return response(++blockCalls === 1 ? corrupt : fallback)
    })
    const retrieve = vi.fn(async () => corrupt.slice())
    const source = ipfs(fetch, retrieve, ['https://provider.ipfs.tech'])
    const result = await source.get(block.cid, signal())
    expect(result).toEqual(fallback)
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(blockCalls).toBe(2)
    expect(fetch.mock.calls[1]![0]).toBe(fetch.mock.calls[2]![0])
    expect(source.snapshot()[0]?.successes).toBe(1)
    expect(configuredGatewayEvidence(source, block.cid, result)).toEqual(BUILD_POLICY.trustless ? undefined : {
      canonicalCid: block.cid, gateway: 'https://provider.ipfs.tech', byteLength: fallback.byteLength,
    })
    expect(configuredGatewayEvidence({ ...source }, block.cid, result)).toBeUndefined()
    expect(configuredGatewayEvidence(source, block.cid, result.slice())).toBeUndefined()
  })

  it('never puts exempt fallback bytes into the verified cache before a later valid provider result', async () => {
    const block = await rawBlock('later provider')
    let lookups = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname === 'router.example') return routing(++lookups === 1 ? [] : [providerRecord()])
      return response(BUILD_POLICY.trustless ? block.bytes : Uint8Array.of(7))
    })
    const retrieve = vi.fn(async () => block.bytes.slice())
    const source = ipfs(fetch, retrieve)
    const first = await source.get(block.cid, signal())
    expect(first).toEqual(BUILD_POLICY.trustless ? block.bytes : Uint8Array.of(7))
    first.fill(0)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(await source.get(block.cid, signal())).toEqual(block.bytes)
    expect(lookups).toBe(BUILD_POLICY.trustless ? 1 : 2)
    expect(retrieve).toHaveBeenCalledTimes(BUILD_POLICY.trustless ? 0 : 1)
  })

  it.each(['LIMIT', 'CANCELLED'] as const)('never enters a gateway after provider %s', async code => {
    const block = await rawBlock(code)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => routing([providerRecord()]))
    const source = ipfs(fetch, vi.fn(async () => { throw networkError(code, 'terminal') }))
    await expect(source.get(block.cid, signal())).rejects.toMatchObject({ error: { code } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported codec/hash and truncated SHA2 before any gateway request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const source = broker(fetch)
    for (const cid of [CID.createV1(0x71, digest(0x12, new Uint8Array(32))),
      CID.createV1(0x55, digest(0x13, new Uint8Array(32))), CID.createV1(0x55, digest(0x12, new Uint8Array(16)))]) {
      await expect(source.get(cid.toString(), signal())).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['redirect', 'type', 'truncated', 'oversize'] as const)('retains configured-gateway response boundaries: %s', async kind => {
    const block = await rawBlock('response boundaries')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const result = kind === 'oversize'
        ? new Response(null, { headers: { 'content-length': String(config().limits.maxBlockBytes + 1) } })
        : new Response(block.bytes.slice().buffer, { headers: kind === 'type' ? { 'content-type': 'text/html' }
          : kind === 'truncated' ? { 'content-length': String(block.bytes.byteLength + 1) } : {} })
      if (kind === 'redirect') Object.defineProperty(result, 'redirected', { value: true })
      return result
    })
    await expect(broker(fetch).get(block.cid, signal())).rejects.toMatchObject({ error: { code: kind === 'oversize' ? 'LIMIT' : 'NETWORK' } })
  })
})
