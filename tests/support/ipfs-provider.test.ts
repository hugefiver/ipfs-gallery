import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withBitswap } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { startIpfsProvider, IPFS_PROVIDER_MAX_BLOCK_BYTES, IPFS_PROVIDER_MAX_MESSAGE_BYTES } from './ipfs-provider'
import { SW_TEST_TLS } from './sw-test-tls'
import { loadIpfsProviderWire } from './ipfs-provider-wire'
import { createGalleryFixtures } from '../fixtures/unixfs'

const originalCertificates = getCACertificates('default')
beforeAll(() => setDefaultCACertificates([...originalCertificates, String(SW_TEST_TLS.certificate)]))
afterAll(() => setDefaultCACertificates(originalCertificates))

function client() {
  return withBitswap(withLibp2pLight(createHeliaLight({ routers: [] }), {
    addresses: { listen: [] },
    transports: [webSockets()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
    services: { identify: identify() }, peerDiscovery: [],
  }), { maxIncomingMessageSize: IPFS_PROVIDER_MAX_MESSAGE_BYTES, maxOutgoingMessageSize: IPFS_PROVIDER_MAX_MESSAGE_BYTES })
}

async function block(bytes: Uint8Array) {
  return { cid: CID.createV1(0x55, await sha256.digest(bytes)), bytes }
}

async function read(helia: ReturnType<typeof client>, cid: CID, signal: AbortSignal) {
  const parts: Uint8Array[] = []
  for await (const part of helia.blockstore.get(cid, { signal })) parts.push(part)
  return new Uint8Array(Buffer.concat(parts))
}

describe('real WSS Bitswap fixture provider', () => {
  it('transfers an exact 2 MiB standard block and records real stream bytes in both directions', async () => {
    const fixture = await block(Uint8Array.from({ length: IPFS_PROVIDER_MAX_BLOCK_BYTES }, (_, index) => index % 251))
    const provider = await startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions })
    const consumer = client()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const bytes = await read(consumer, fixture.cid, AbortSignal.timeout(5000))
      expect(Buffer.from(bytes).equals(fixture.bytes)).toBe(true)
      await provider.waitForRecord(record => record.type === 'want' && record.cid === fixture.cid.toString())
      const sent = await provider.waitForRecord(record => record.type === 'sent' && record.payloadBytes === fixture.bytes.length)
      if (sent.type !== 'sent') throw new Error('Missing sent record')
      expect(Buffer.from(sent.blocks[0]!.data).equals(fixture.bytes)).toBe(true)
      expect(sent.encodedBytes).toBeLessThanOrEqual(IPFS_PROVIDER_MAX_MESSAGE_BYTES)
      expect(provider.records.reduce((sum, record) => sum + (record.type === 'received' ? record.payloadBytes : 0), 0)).toBe(0)
      expect(provider.records).toContainEqual(expect.objectContaining({ type: 'connection:open', direction: 'inbound', peerId: consumer.libp2p.peerId.toString() }))
      expect(provider.publicAddress('provider.example.com', 443).toString()).toBe(`/dns4/provider.example.com/tcp/443/wss/p2p/${provider.peerId}`)
      expect(provider.localTarget.port).toBeGreaterThan(0)

      // This independent Helia consumer stores downloads. Asking it over the
      // same connection proves the provider's upload-direction observation.
      const uploaded = await provider.requestBlockFromPeer(fixture.cid, consumer.libp2p.peerId, AbortSignal.timeout(5000))
      expect(Buffer.from(uploaded).equals(fixture.bytes)).toBe(true)
      expect(provider.records.some(record => record.type === 'sent' && record.wants.some(want => want.cid === fixture.cid.toString() && !want.cancel))).toBe(true)
      await provider.waitForRecord(record => record.type === 'received' && record.payloadBytes === fixture.bytes.length)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      await consumer.stop()
      await provider.close()
      await provider.close()
    }
  }, 20000)

  it('holds delivery during consumer abort and observes an explicitly encoded standard wire cancel', async () => {
    const fixture = await block(new TextEncoder().encode('paused bitswap fixture'))
    const provider = await startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions, mode: { kind: 'pause' } })
    const consumer = client()
    const cancellation = new AbortController()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const result = read(consumer, fixture.cid, cancellation.signal).then(() => undefined, (error: unknown) => error)
      await provider.waitForRecord(record => record.type === 'store:read' && record.cid === fixture.cid.toString())
      cancellation.abort(new Error('Test consumer cancelled'))
      expect(await result).toBeInstanceOf(Error)
      // Explicit protocol probe, not evidence that Helia abort sends a cancel.
      const { BitswapMessage, framing } = await loadIpfsProviderWire()
      const stream = await consumer.libp2p.dialProtocol(provider.peerId, '/ipfs/bitswap/1.2.0', { signal: AbortSignal.timeout(5000) })
      await stream.closeRead()
      const encoded = BitswapMessage.encode({
        wantlist: { entries: [{ cid: fixture.cid.bytes, priority: 1, cancel: true, wantType: 'WantBlock' }] },
        blocks: [], blockPresences: [], pendingBytes: 0,
      })
      if (!stream.send(framing.encode.single(encoded))) await stream.onDrain({ signal: AbortSignal.timeout(5000) })
      await stream.close({ signal: AbortSignal.timeout(5000) })
      await provider.waitForRecord(record => record.type === 'cancel' && record.cid === fixture.cid.toString())
      expect(provider.records.some(record => record.type === 'sent' && record.payloadBytes > 0)).toBe(false)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      cancellation.abort()
      await consumer.stop()
      await provider.close()
    }
  }, 15000)

  it('releases a paused read and sends the fixture bytes over the official protocol', async () => {
    const fixture = await block(new TextEncoder().encode('release bitswap fixture'))
    const provider = await startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions })
    provider.setBlockMode(fixture.cid, { kind: 'pause' })
    const consumer = client()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const result = read(consumer, fixture.cid, AbortSignal.timeout(5000))
      await provider.waitForRecord(record => record.type === 'store:read' && record.cid === fixture.cid.toString())
      provider.release(fixture.cid)
      expect(await result).toEqual(fixture.bytes)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      await consumer.stop()
      await provider.close()
    }
  }, 15000)

  it('rejects oversized Bitswap fixtures before opening any listener', async () => {
    const fixture = await block(new Uint8Array(IPFS_PROVIDER_MAX_BLOCK_BYTES + 1))
    await expect(startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions })).rejects.toThrow()
  })

  it('accepts the existing gallery fixture map and transfers the actual PNG bytes', async () => {
    const fixtures = await createGalleryFixtures()
    const provider = await startIpfsProvider(fixtures.blocks, { tls: SW_TEST_TLS.serverOptions })
    const consumer = client()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const bytes = await read(consumer, CID.parse(fixtures.raw.cid), AbortSignal.timeout(5000))
      expect(Buffer.from(bytes).equals(fixtures.raw.bytes)).toBe(true)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      await consumer.stop()
      await provider.close()
    }
  }, 15000)

  it('sends deliberately corrupt bytes without satisfying the wanted CID', async () => {
    const fixture = await block(new TextEncoder().encode('corrupt bitswap fixture'))
    const provider = await startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions, mode: { kind: 'corrupt' } })
    const consumer = client()
    const cancellation = new AbortController()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const result = read(consumer, fixture.cid, cancellation.signal).then(() => undefined, (error: unknown) => error)
      const sent = await provider.waitForRecord(record => record.type === 'sent' && record.payloadBytes > 0)
      if (sent.type !== 'sent') throw new Error('Missing corrupt send record')
      expect(Buffer.from(sent.blocks[0]!.data).equals(fixture.bytes)).toBe(false)
      cancellation.abort(new Error('End corrupt provider probe'))
      expect(await result).toBeInstanceOf(Error)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      cancellation.abort()
      await consumer.stop()
      await provider.close()
    }
  }, 15000)

  it('drops a selected block without sending content bytes', async () => {
    const fixture = await block(new TextEncoder().encode('dropped bitswap fixture'))
    const provider = await startIpfsProvider(new Map([[fixture.cid, fixture.bytes]]), { tls: SW_TEST_TLS.serverOptions })
    provider.setBlockMode(fixture.cid.toString(), { kind: 'drop' })
    const consumer = client()
    const cancellation = new AbortController()
    try {
      await consumer.start()
      await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
      const result = read(consumer, fixture.cid, cancellation.signal).then(() => undefined, (error: unknown) => error)
      await provider.waitForRecord(record => record.type === 'store:has' && record.cid === fixture.cid.toString() && !record.present)
      expect(provider.records.some(record => record.type === 'sent' && record.payloadBytes > 0)).toBe(false)
      cancellation.abort(new Error('End dropped provider probe'))
      expect(await result).toBeInstanceOf(Error)
      expect(provider.instrumentationErrors).toEqual([])
    } finally {
      cancellation.abort()
      await consumer.stop()
      await provider.close()
    }
  }, 15000)
})
