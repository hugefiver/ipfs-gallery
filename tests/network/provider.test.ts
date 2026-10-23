import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { describe, expect, it, vi } from 'vitest'
import { DirectBudget } from '../../src/network/direct-budget'
import { fetchBounded } from '../../src/network/direct-http'
import { BoundedDatastore, NonRetainingBlockstore } from '../../src/network/ipfs-stores'
import { providerGater, publicProviderAddress } from '../../src/network/provider-policy'
import { findProviders, parseProvider, PROVIDER_LIMITS } from '../../src/network/provider-routing'
import { Key } from 'interface-datastore/key'
import { collect, deferred, rawBlock, signal } from './helpers'
import { peer, providerRecord } from './provider-helpers'
const routingOptions = (fetch: typeof globalThis.fetch) => ({ fetch, endpoint: 'https://delegated-ipfs.dev', policy: publicProviderAddress })

describe('provider address policy', () => {
  it.each([
    '/dns4/provider.ipfs.tech/tcp/443/wss', '/dns/provider.ipfs.tech/tcp/8443/tls/ws', '/dns6/provider.ipfs.tech/tcp/443/https',
  ])('accepts narrow public TLS transport %s', address => {
    expect(publicProviderAddress(multiaddr(address), peer)).toBeDefined()
  })

  it.each([
    '/ip4/8.8.8.8/tcp/443/wss', '/ip4/127.0.0.1/tcp/443/wss', '/ip6/::1/tcp/443/wss',
    '/dns4/localhost/tcp/443/wss', '/dns4/a.local/tcp/443/wss', '/dns4/a.home.arpa/tcp/443/wss',
    '/dns4/a.onion/tcp/443/wss', '/dns4/a.test/tcp/443/wss', '/dnsaddr/provider.ipfs.tech',
    '/dns4/provider.ipfs.tech/tcp/22/wss', '/dns4/provider.ipfs.tech/tcp/443/ws',
    '/dns4/provider.ipfs.tech/tcp/443/http', '/dns4/provider.ipfs.tech/udp/443/quic-v1/webtransport',
    '/dns4/provider.ipfs.tech/tcp/443/wss/p2p-circuit',
  ])('rejects unsafe transport %s', address => {
    expect(publicProviderAddress(multiaddr(address), peer)).toBeUndefined()
  })

  it('requires an admitted matching peer and exact safe address at every gate', async () => {
    const address = publicProviderAddress(multiaddr('/dns4/provider.ipfs.tech/tcp/443/wss'), peer)!.address
    const allowed = new Map<string, Set<string>>()
    const gater = providerGater(allowed)
    expect(await gater.denyDialMultiaddr!(address)).toBe(true)
    allowed.set(peer.toString(), new Set([address.toString()]))
    expect(await gater.denyDialMultiaddr!(address)).toBe(false)
    expect(await gater.filterMultiaddrForPeer!(peer, address)).toBe(true)
    expect(await gater.filterMultiaddrForPeer!(peer, multiaddr('/dns4/other.ipfs.tech/tcp/443/wss'))).toBe(false)
    expect(await gater.denyInboundRelayReservation!(peer)).toBe(true)
  })

  it('does not turn unsupported, oversized or mixed peer records into configuration', () => {
    expect(parseProvider({ ...providerRecord(), Schema: 'bitswap' })).toBeUndefined()
    expect(parseProvider({ ...providerRecord(), ID: 'https://attacker.net' })).toBeUndefined()
    expect(parseProvider({ ...providerRecord(), Protocols: ['transport-unknown'] })).toBeUndefined()
    expect(parseProvider(providerRecord(Array(5).fill('/dns4/provider.ipfs.tech/tcp/443/wss')))?.addresses).toHaveLength(1)
    expect(parseProvider({ ...providerRecord(), Error: 'x'.repeat(PROVIDER_LIMITS.recordBytes) })).toBeUndefined()
    const other = peerIdFromString(CID.createV1(0x72, identity.digest(Uint8Array.from([8, 1, 18, 32, ...new Uint8Array(32).fill(2)]))).toString())
    expect(parseProvider(providerRecord([`/dns4/provider.ipfs.tech/tcp/443/wss/p2p/${other}`]))).toBeUndefined()
  })
})

describe('bounded delegated routing HTTP', () => {
  it.each([undefined, []])('admits unknown protocols at low confidence: %j', Protocols => {
    const provider = parseProvider({ ...providerRecord(), Protocols })
    expect(provider?.unknownProtocols).toBe(true)
    expect(provider?.addresses).toHaveLength(1)
  })
  it.each([null, 'transport-bitswap', {}, [1]])('rejects malformed protocol metadata: %j', Protocols => {
    expect(parseProvider({ ...providerRecord(), Protocols })).toBeUndefined()
  })
  it('filters unsafe and duplicate addresses before the four-safe-address cap', () => {
    const Addrs = ['/ip4/127.0.0.1/tcp/443/wss', ...Array(5).fill('/dns4/provider.ipfs.tech/tcp/443/wss'),
      ...Array.from({ length: 5 }, (_, i) => `/dns4/p${i}.ipfs.tech/tcp/443/https`)]
    expect(parseProvider({ ...providerRecord(Addrs), Protocols: [] })?.addresses).toHaveLength(4)
  })
  it.each(['application/json', 'application/x-ndjson'])('scans past invalid and duplicate records in %s', async type => {
    const block = await rawBlock('later valid provider')
    const records = [...Array(20).fill({ Schema: 'other' }), ...Array(20).fill(providerRecord())]
    const payload = type === 'application/json' ? JSON.stringify({ Providers: records }) : records.map(value => JSON.stringify(value)).join('\n')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(payload, { headers: { 'content-type': type } }))
    expect(await findProviders(CID.parse(block.cid), signal(), routingOptions(fetch))).toHaveLength(1)
  })
  it.each(['application/json', 'application/x-ndjson'])('reads %s and uses only the provider GET API', async type => {
    const block = await rawBlock('routing')
    const payload = type === 'application/json' ? JSON.stringify({ extra: 'plain data', Providers: [providerRecord()] }) : JSON.stringify(providerRecord()) + '\n'
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(payload, { headers: { 'content-type': type } }))
    const result = await findProviders(CID.parse(block.cid), signal(), routingOptions(fetch))
    expect(result).toHaveLength(1)
    expect(result[0]?.id.equals(peer)).toBe(true)
    expect(fetch).toHaveBeenCalledWith(`https://delegated-ipfs.dev/routing/v1/providers/${block.cid}`, expect.objectContaining({
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
    }))
  })

  it('merges safe transport addresses from duplicate peer records without consuming another provider slot', async () => {
    const block = await rawBlock('duplicate peer transports')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ Providers: [providerRecord(),
      providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https'])] }), { headers: { 'content-type': 'application/json' } }))
    const providers = await findProviders(CID.parse(block.cid), signal(), routingOptions(fetch))
    expect(providers).toHaveLength(1)
    expect(providers[0]!.addresses.map(address => address.kind)).toEqual(['wss', 'https'])
  })
  it('bounds raw NDJSON scanning independently of unique provider capacity', async () => {
    let cancelled = false
    const block = await rawBlock('cap')
    const line = new TextEncoder().encode(JSON.stringify(providerRecord()) + '\n')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(line) }, cancel() { cancelled = true },
    }), { headers: { 'content-type': 'application/x-ndjson' } }))
    expect(await findProviders(CID.parse(block.cid), signal(), routingOptions(fetch))).toHaveLength(1)
    expect(cancelled).toBe(true)
  })

  it.each([
    ['application/json', '{"Providers":[', {}],
    ['application/x-ndjson', 'x'.repeat(16385), {}],
    ['text/html', '<html>not metadata</html>', {}],
    ['application/json', '{"Providers":[]}', { 'content-length': '262145' }],
    ['application/json', '{"Providers":[]}', { 'content-length': '-1' }],
    ['application/json', '{"Providers":[]}', { 'content-length': '1' }],
  ])('rejects bad metadata %s', async (type, body, headers) => {
    const block = await rawBlock('bad routing')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { headers: { ...headers, 'content-type': type } }))
    await expect(findProviders(CID.parse(block.cid), signal(), routingOptions(fetch))).rejects.toBeDefined()
  })

  it('rejects redirected responses and never accepts the body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = new Response('unsafe')
      Object.defineProperty(response, 'redirected', { value: true })
      return response
    })
    await expect(fetchBounded(fetch, 'https://provider.ipfs.tech', 'application/json', 100, signal())).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  })

  it('keeps cancellation pending until the exclusive reader cancel completes', async () => {
    const barrier = deferred<void>()
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel: () => barrier.promise })))
    const operation = fetchBounded(fetch, 'https://provider.ipfs.tech', 'application/vnd.ipld.raw', 100, controller.signal)
    const rejected = expect(operation).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    let settled = false
    void operation.catch(() => {}).then(() => { settled = true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    barrier.resolve()
    await rejected
  })
})

describe('nonretaining and shared bounded metadata', () => {
  it('never retains downloaded block bytes for inbound wants', async () => {
    const block = await rawBlock('no upload')
    const store = new NonRetainingBlockstore()
    await store.put(CID.parse(block.cid), block.bytes)
    expect(store.has()).toBe(false)
    expect(() => store.get()).toThrow(expect.objectContaining({ name: 'NotFoundError' }))
    expect(await collect(store.getAll())).toEqual([])
  })

  it.each([['dial', 2], ['connection', 6], ['peer', 32]] as const)('shares %s admission across factories and never queues overflow', (kind, cap) => {
    const budget = new DirectBudget()
    const releases = Array.from({ length: cap }, () => budget.acquire(kind))
    expect(() => budget.acquire(kind)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'LIMIT' }) }))
    releases[0]!()
    const next = budget.acquire(kind)
    releases[0]!()
    for (const release of releases.slice(1)) release()
    next()
    expect(budget.snapshot()).toMatchObject({ dials: 0, connections: 0, peers: 0 })
  })

  it('accounts peer metadata globally, copies buffers and releases on clear', () => {
    const budget = new DirectBudget()
    const a = new BoundedDatastore(budget)
    const b = new BoundedDatastore(budget)
    const bytes = new Uint8Array(16384)
    for (let index = 0; index < 63; index++) (index % 2 ? a : b).put(new Key(`/p/${index}`), bytes)
    expect(() => a.put(new Key('/overflow'), bytes)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'LIMIT' }) }))
    const key = new Key('/small')
    a.put(key, Uint8Array.of(1))
    a.get(key).fill(9)
    expect(a.get(key)).toEqual(Uint8Array.of(1))
    a.clear(); b.clear()
    expect(budget.snapshot()).toMatchObject({ metadataBytes: 0, metadataEntries: 0 })
  })
})
