import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { peerIdFromString } from '@libp2p/peer-id'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { directBudget } from '../../src/network/direct-budget'
import { createDirectTransport } from '../../src/network/direct-transport'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { startIpfsProvider } from '../support/ipfs-provider'
import { SW_TEST_TLS } from '../support/sw-test-tls'
import { config, rawBlock } from './helpers'

const originalCertificates = getCACertificates('default')
beforeAll(() => setDefaultCACertificates([...originalCertificates, String(SW_TEST_TLS.certificate)]))
afterAll(() => setDefaultCACertificates(originalCertificates))

describe('narrow transport real WSS interoperability', () => {
  it('retrieves a 2 MiB block over official WSS/Noise/Yamux/Bitswap and releases physical connections', async () => {
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251)
    const cid = CID.createV1(0x55, await sha256.digest(bytes))
    const provider = await startIpfsProvider([[cid, bytes]], { tls: SW_TEST_TLS.serverOptions })
    // Fixture-only explicit capability: exactly this test's listener and peer.
    const transport = createDirectTransport((address, peer) =>
      peer.equals(provider.peerId) && address.equals(provider.localAddress) ? { kind: 'wss', address } : undefined)
    try {
      const result = await transport.retrieve(cid, { id: provider.peerId, addresses: [{ kind: 'wss', address: provider.localAddress }] }, provider.localAddress, AbortSignal.timeout(7000))
      expect(Buffer.from(result).equals(bytes)).toBe(true)
      await provider.waitForRecord(record => record.type === 'sent' && record.payloadBytes === bytes.byteLength)
      await provider.waitForRecord(record => record.type === 'connection:close')
      expect(provider.instrumentationErrors).toEqual([])
      expect(directBudget.snapshot()).toEqual({ dials: 0, connections: 0, peers: 0, metadataEntries: 0, metadataBytes: 0 })
    } finally {
      transport.dispose()
      await provider.close()
    }
  }, 15000)

  it('sends the actual A cancel while B uses the same peer connection', async () => {
    const a = await rawBlock('cancel A')
    const b = await rawBlock('keep B')
    const provider = await startIpfsProvider([[a.cid, a.bytes], [b.cid, b.bytes]], { tls: SW_TEST_TLS.serverOptions })
    provider.setBlockMode(a.cid, { kind: 'pause' })
    provider.setBlockMode(b.cid, { kind: 'pause' })
    const transport = createDirectTransport((address, peer) =>
      peer.equals(provider.peerId) && address.equals(provider.localAddress) ? { kind: 'wss', address } : undefined)
    const candidate = { id: provider.peerId, addresses: [{ kind: 'wss' as const, address: provider.localAddress }] }
    const cancellation = new AbortController()
    const lifetime = new AbortController()
    let readA: Promise<Uint8Array> | undefined
    let readB: Promise<Uint8Array> | undefined
    try {
      readA = transport.retrieve(CID.parse(a.cid), candidate, provider.localAddress, cancellation.signal)
      const outcomeA = readA.then(() => undefined, (error: unknown) => error)
      readB = transport.retrieve(CID.parse(b.cid), candidate, provider.localAddress, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]))
      void readB.catch(() => {})
      await provider.waitForRecord(record => record.type === 'want' && record.cid === a.cid)
      await provider.waitForRecord(record => record.type === 'want' && record.cid === b.cid)
      cancellation.abort()
      await provider.waitForRecord(record => record.type === 'cancel' && record.cid === a.cid)
      expect(await outcomeA).toBeInstanceOf(Error)
      expect(provider.records.filter(record => record.type === 'connection:open')).toHaveLength(1)
      expect(provider.records.filter(record => record.type === 'connection:close')).toHaveLength(0)
      provider.setBlockMode(a.cid, { kind: 'correct' })
      provider.setBlockMode(b.cid, { kind: 'correct' })
      provider.release(a.cid)
      provider.release(b.cid)
      expect(await readB).toEqual(b.bytes)
      await provider.waitForRecord(record => record.type === 'connection:close')
      expect(provider.instrumentationErrors).toEqual([])
      expect(directBudget.snapshot()).toEqual({ dials: 0, connections: 0, peers: 0, metadataEntries: 0, metadataBytes: 0 })
    } finally {
      cancellation.abort(); lifetime.abort()
      provider.release()
      await Promise.allSettled([readA, readB])
      transport.dispose()
      await provider.close()
    }
  }, 20000)

  it('does not revoke another consumer of the same CID', async () => {
    const block = await rawBlock('two consumers')
    const provider = await startIpfsProvider([[block.cid, block.bytes]], { tls: SW_TEST_TLS.serverOptions, mode: { kind: 'pause' } })
    const transport = createDirectTransport((address, peer) =>
      peer.equals(provider.peerId) && address.equals(provider.localAddress) ? { kind: 'wss', address } : undefined)
    const candidate = { id: provider.peerId, addresses: [{ kind: 'wss' as const, address: provider.localAddress }] }
    const cancellation = new AbortController()
    const lifetime = new AbortController()
    const first = transport.retrieve(CID.parse(block.cid), candidate, provider.localAddress, cancellation.signal)
    const outcome = first.then(() => undefined, (error: unknown) => error)
    const second = transport.retrieve(CID.parse(block.cid), candidate, provider.localAddress, AbortSignal.any([lifetime.signal, AbortSignal.timeout(7000)]))
    void second.catch(() => {})
    try {
      await provider.waitForRecord(record => record.type === 'store:read' && record.cid === block.cid)
      cancellation.abort()
      expect(provider.records.some(record => record.type === 'cancel' && record.cid === block.cid)).toBe(false)
      provider.release(block.cid)
      expect(await second).toEqual(block.bytes)
      expect(await outcome).toBeInstanceOf(Error)
      expect(provider.instrumentationErrors).toEqual([])
      expect(directBudget.snapshot()).toEqual({ dials: 0, connections: 0, peers: 0, metadataEntries: 0, metadataBytes: 0 })
    } finally {
      cancellation.abort(); lifetime.abort(); provider.release()
      await Promise.allSettled([first, second])
      transport.dispose()
      await provider.close()
    }
  }, 15000)

  it('preserves resource admission LIMIT through libp2p dial error aggregation', async () => {
    const block = await rawBlock('admission')
    const provider = await startIpfsProvider([[block.cid, block.bytes]], { tls: SW_TEST_TLS.serverOptions })
    const transport = createDirectTransport((address, peer) =>
      peer.equals(provider.peerId) && address.equals(provider.localAddress) ? { kind: 'wss', address } : undefined)
    const releases = [directBudget.acquire('dial'), directBudget.acquire('dial')]
    try {
      await expect(transport.retrieve(CID.parse(block.cid), { id: provider.peerId, addresses: [{ kind: 'wss', address: provider.localAddress }] }, provider.localAddress, AbortSignal.timeout(5000))).rejects.toMatchObject({ error: { code: 'LIMIT' } })
      expect(provider.records.some(record => record.type === 'connection:open')).toBe(false)
    } finally {
      for (const release of releases) release()
      transport.dispose()
      await provider.close()
    }
    expect(directBudget.snapshot()).toEqual({ dials: 0, connections: 0, peers: 0, metadataEntries: 0, metadataBytes: 0 })
  }, 10000)

  it('does not supply a verified cached A to an inbound want while the same connection serves paused B', async () => {
    const a = await rawBlock('verified A is not uploaded')
    const b = await rawBlock('paused B keeps the connection in use')
    const provider = await startIpfsProvider([[a.cid, a.bytes], [b.cid, b.bytes]], { tls: SW_TEST_TLS.serverOptions })
    provider.setBlockMode(a.cid, { kind: 'pause' })
    provider.setBlockMode(b.cid, { kind: 'pause' })
    // Only discovery is injected; both content reads use the production source
    // and the installed Bitswap/WSS transport against this owned TLS listener.
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (new URL(input.toString()).hostname !== 'delegated-ipfs.dev') throw new Error('Unexpected gateway fallback')
      return new Response(JSON.stringify({ Providers: [{
        Schema: 'peer', ID: provider.peerId.toString(), Protocols: ['transport-bitswap'], Addrs: [provider.localAddress.toString()],
      }] }), { headers: { 'content-type': 'application/json' } })
    })
    const source = createIpfsBlockSourceWithOptions(config(undefined, { maxBlockCacheBytes: 2 * 1024 * 1024 }), {
      fetch, router: 'https://delegated-ipfs.dev',
      policy: (address, peer) => peer.equals(provider.peerId) && address.equals(provider.localAddress) ? { kind: 'wss', address } : undefined,
    })
    const lifetime = new AbortController()
    const probeController = new AbortController()
    const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)])
    const readA = source.get(a.cid, deadline)
    void readA.catch(() => {})
    let readB: Promise<Uint8Array> | undefined
    let probeOutcome: Promise<unknown> | undefined
    try {
      await provider.waitForRecord(record => record.type === 'store:read' && record.cid === a.cid)
      readB = source.get(b.cid, deadline)
      void readB.catch(() => {})
      await provider.waitForRecord(record => record.type === 'want' && record.cid === b.cid)
      provider.setBlockMode(a.cid, { kind: 'correct' })
      provider.release(a.cid)
      expect(await readA).toEqual(a.bytes)
      expect(await source.get(a.cid, deadline)).toEqual(a.bytes)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(provider.records.reduce((total, record) => total + (record.type === 'sent' ? record.payloadBytes : 0), 0)).toBe(a.bytes.byteLength)
      await provider.waitForRecord(record => record.type === 'cancel' && record.cid === a.cid)
      const connection = provider.records.find(record => record.type === 'connection:open')!
      if (connection.type !== 'connection:open') throw new Error('Missing client connection')
      expect(provider.records.some(record => record.type === 'connection:close')).toBe(false)
      expect(directBudget.snapshot().connections).toBe(1)

      const clientPeer = peerIdFromString(connection.peerId)
      probeOutcome = provider.requestBlockFromPeer(CID.parse(a.cid), clientPeer,
        AbortSignal.any([probeController.signal, AbortSignal.timeout(1000)]),
      ).then(bytes => bytes, (error: unknown) => error)
      await provider.waitForRecord(record => record.type === 'sent' && record.wants.some(want => want.cid === a.cid && !want.cancel), 2000)
      expect(await probeOutcome).toBeInstanceOf(Error)
      expect(provider.records.filter(record => record.type === 'connection:open')).toHaveLength(1)
      expect(provider.records.some(record => record.type === 'connection:close')).toBe(false)
      expect(provider.records.filter(record => record.type === 'received').flatMap(record => record.type === 'received' ? record.blocks : [])).toEqual([])

      provider.setBlockMode(b.cid, { kind: 'correct' })
      provider.release(b.cid)
      expect(await readB).toEqual(b.bytes)
      await source.settled()
      await provider.waitForRecord(record => record.type === 'connection:close')
      expect(provider.records.filter(record => record.type === 'received').reduce((total, record) => total + (record.type === 'received' ? record.payloadBytes : 0), 0)).toBe(0)
      expect(provider.instrumentationErrors).toEqual([])
      expect(directBudget.snapshot()).toEqual({ dials: 0, connections: 0, peers: 0, metadataEntries: 0, metadataBytes: 0 })
    } finally {
      lifetime.abort(); probeController.abort(); provider.release()
      source.dispose()
      await Promise.allSettled([readA, readB, probeOutcome, source.settled()])
      await provider.close()
    }
  }, 15000)
})
