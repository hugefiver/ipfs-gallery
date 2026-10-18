import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { connect as connectTls, getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withBitswap } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { multiaddr } from '@multiformats/multiaddr'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { startSwGalleryBitswapProvider } from './sw-gallery-provider'
import { isActiveSwOwnedServerTarget } from './sw-owned'
import { SW_TEST_TLS } from './sw-test-tls'
import { parseProvider } from '../../src/network/provider-routing'

const originalCertificates = getCACertificates('default')
beforeAll(() => setDefaultCACertificates([...originalCertificates, String(SW_TEST_TLS.certificate)]))
afterAll(() => setDefaultCACertificates(originalCertificates))

async function fixtureBlocks() {
  const bytes = new TextEncoder().encode('TLS pass-through to the official WSS Bitswap provider')
  const cid = CID.createV1(0x55, await sha256.digest(bytes))
  return { cid, bytes, blocks: new Map([[cid.toString(), { cid, bytes }]]) }
}

describe('owned TCP relay for the gallery Bitswap provider', () => {
  it('passes authenticated TLS to the provider and closes both socket owners before the provider', async () => {
    const fixture = await fixtureBlocks()
    const relay = await startSwGalleryBitswapProvider(fixture.blocks)
    const client = connectTls({ ...SW_TEST_TLS.clientOptions, host: '127.0.0.1', port: relay.endpoint.target.connectPort })
    client.on('error', () => {})
    const clientClosed = new Promise<void>(resolve => client.once('close', resolve))
    const closeProvider = relay.provider.close
    const close = vi.spyOn(relay.provider, 'close').mockImplementation(async () => {
      expect(relay.activeCount).toBe(0)
      expect(relay.owned.every(record => record.closedAt !== undefined)).toBe(true)
      await closeProvider()
    })
    try {
      await once(client, 'secureConnect', { signal: AbortSignal.timeout(5000) })
      expect(client.authorized).toBe(true)
      expect(client.getPeerCertificate().raw).toEqual(new X509Certificate(SW_TEST_TLS.certificate).raw)
      expect(relay.owned.filter(record => record.kind === 'connection')).toHaveLength(1)
      expect(relay.owned.filter(record => record.kind === 'upstream')).toHaveLength(1)
      expect(isActiveSwOwnedServerTarget(relay.endpoint.target)).toBe(true)
      await relay.close()
      await clientClosed
      expect(client.destroyed).toBe(true)
      expect(close).toHaveBeenCalledOnce()
      expect(relay.activeCount).toBe(0)
      expect(isActiveSwOwnedServerTarget(relay.endpoint.target)).toBe(false)
      expect(relay.errors).toEqual([])
      await relay.close()
      expect(close).toHaveBeenCalledOnce()
    } finally {
      client.destroy()
      await relay.close()
    }
  }, 15_000)

  it('carries real WSS/Noise/Yamux/Bitswap bytes and closes an established peer connection', async () => {
    const fixture = await fixtureBlocks()
    const relay = await startSwGalleryBitswapProvider(fixture.blocks)
    const consumer = withBitswap(withLibp2pLight(createHeliaLight({ routers: [] }), {
      addresses: { listen: [] }, transports: [webSockets()], connectionEncrypters: [noise()],
      streamMuxers: [yamux({ enableKeepAlive: false })], services: { identify: identify() }, peerDiscovery: [],
    }))
    try {
      await consumer.start()
      const candidate = parseProvider({ Schema: 'peer', ID: relay.provider.peerId.toString(),
        Addrs: [relay.provider.publicAddress().toString()], Protocols: ['transport-bitswap'] })
      expect(candidate?.addresses[0]?.kind).toBe('wss')
      expect(candidate?.addresses[0]?.address.equals(relay.provider.publicAddress())).toBe(true)
      const address = multiaddr(`/ip4/127.0.0.1/tcp/${relay.endpoint.target.connectPort}/wss/p2p/${relay.provider.peerId}`)
      await consumer.libp2p.dial(address, { signal: AbortSignal.timeout(5000) })
      const parts: Uint8Array[] = []
      for await (const part of consumer.blockstore.get(fixture.cid, { signal: AbortSignal.timeout(5000) })) parts.push(part)
      expect(Buffer.concat(parts)).toEqual(Buffer.from(fixture.bytes))
      await relay.provider.waitForRecord(record => record.type === 'want' && record.cid === fixture.cid.toString())
      const sent = await relay.provider.waitForRecord(record => record.type === 'sent' && record.payloadBytes === fixture.bytes.byteLength)
      if (sent.type !== 'sent') throw new Error('Expected actual encoded Bitswap block delivery')
      expect(sent.blocks[0]!.data).toEqual(fixture.bytes)
      expect(relay.provider.records.filter(record => record.type === 'connection:open')).toHaveLength(1)
      expect(relay.owned.filter(record => record.kind === 'upstream')).toHaveLength(1)
      await relay.close()
      await relay.provider.waitForRecord(record => record.type === 'connection:close')
      expect(relay.activeCount).toBe(0)
      expect(relay.owned.every(record => record.closedAt !== undefined)).toBe(true)
      expect(relay.provider.instrumentationErrors).toEqual([])
      expect(relay.errors).toEqual([])
    } finally {
      await consumer.stop()
      await relay.close()
    }
  }, 20_000)
})
