import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { BitswapBlockBroker, withBitswap } from '@helia/bitswap'
import { withLibp2pLight } from '@helia/libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { createHeliaLight } from 'helia'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { startIpfsProvider } from '../support/ipfs-provider'
import { SW_TEST_TLS } from '../support/sw-test-tls'

const certificates = getCACertificates('default')
beforeAll(() => setDefaultCACertificates([...certificates, String(SW_TEST_TLS.certificate)]))
afterAll(() => setDefaultCACertificates(certificates))

it('ordinary broker abort sends a real cancel without interrupting another CID', async () => {
  const a = new TextEncoder().encode('cancelled block')
  const b = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251)
  const ac = CID.createV1(0x55, await sha256.digest(a))
  const bc = CID.createV1(0x55, await sha256.digest(b))
  const provider = await startIpfsProvider(new Map([[ac, a], [bc, b]]), { tls: SW_TEST_TLS.serverOptions })
  provider.setBlockMode(ac, { kind: 'pause' })
  provider.setBlockMode(bc, { kind: 'pause' })
  const consumer = withBitswap(withLibp2pLight(createHeliaLight({ routers: [] }), {
    addresses: { listen: [] }, peerDiscovery: [],
    transports: [webSockets()], connectionEncrypters: [noise()],
    streamMuxers: [yamux({ enableKeepAlive: false, maxIncomingFrameDataLength: 1024 * 1024,
      streamOptions: { initialStreamWindowSize: 256 * 1024, maxStreamWindowSize: 1024 * 1024 } })], services: { identify: identify() },
  }), { maxIncomingMessageSize: 4 * 1024 * 1024, maxOutgoingMessageSize: 4 * 1024 * 1024 })
  const controller = new AbortController()
  async function read(cid: CID, signal: AbortSignal) {
    const parts: Uint8Array[] = []
    for await (const part of consumer.blockstore.get(cid, { signal })) parts.push(part)
    return Buffer.concat(parts)
  }
  try {
    await consumer.start()
    await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
    const ar = read(ac, controller.signal).catch((error: unknown) => error)
    const br = read(bc, AbortSignal.timeout(10000))
    void br.catch(() => {})
    await provider.waitForRecord(r => r.type === 'want' && r.cid === ac.toString())
    await provider.waitForRecord(r => r.type === 'want' && r.cid === bc.toString())
    controller.abort(new Error('cancel A'))
    expect(await ar).toBeInstanceOf(Error)
    await provider.waitForRecord(r => r.type === 'cancel' && r.cid === ac.toString(), 2000)
    expect(provider.records.filter(r => r.type === 'connection:close')).toHaveLength(0)
    provider.setBlockMode(bc, undefined)
    provider.release(bc)
    provider.release(ac)
    expect((await br).equals(b)).toBe(true)
    expect(provider.instrumentationErrors).toEqual([])
  } finally {
    controller.abort()
    await consumer.stop()
    await provider.close()
  }
})

it('the published operation API preserves the other consumer of a real provider want', async () => {
  const bytes = new TextEncoder().encode('shared real provider block')
  const cid = CID.createV1(0x55, await sha256.digest(bytes))
  const provider = await startIpfsProvider(new Map([[cid, bytes]]), { tls: SW_TEST_TLS.serverOptions, mode: { kind: 'pause' } })
  const consumer = withLibp2pLight(createHeliaLight({ routers: [] }), {
    addresses: { listen: [] }, peerDiscovery: [],
    transports: [webSockets()], connectionEncrypters: [noise()],
    streamMuxers: [yamux({ enableKeepAlive: false, maxIncomingFrameDataLength: 1024 * 1024,
      streamOptions: { initialStreamWindowSize: 256 * 1024, maxStreamWindowSize: 1024 * 1024 } })],
    services: { identify: identify() },
  })
  let broker: BitswapBlockBroker | undefined
  try {
    await consumer.start()
    broker = new BitswapBlockBroker(consumer)
    await broker.start()
    await consumer.libp2p.dial(provider.localAddress, { signal: AbortSignal.timeout(5000) })
    const a = broker.retrieveOperation(cid, { signal: AbortSignal.timeout(5000) })
    const b = broker.retrieveOperation(cid, { signal: AbortSignal.timeout(5000) })
    void a.result.catch(() => {})
    void b.result.catch(() => {})
    await provider.waitForRecord(r => r.type === 'store:read' && r.cid === cid.toString())
    a.cancel()
    await expect(a.result).rejects.toThrow()
    await a.settled
    expect(provider.records.filter(r => r.type === 'cancel' && r.cid === cid.toString())).toHaveLength(0)
    provider.release(cid)
    expect(await b.result).toEqual(bytes)
    await b.settled
    await provider.waitForRecord(r => r.type === 'cancel' && r.cid === cid.toString())
    expect(provider.records.filter(r => r.type === 'want' && r.cid === cid.toString())).toHaveLength(1)
    expect(provider.instrumentationErrors).toEqual([])
  } finally {
    await broker?.stop()
    await consumer.stop()
    await provider.close()
  }
})
