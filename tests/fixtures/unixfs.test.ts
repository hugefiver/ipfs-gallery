import { beforeAll, describe, expect, it } from 'vitest'
import { exporter } from 'ipfs-unixfs-exporter'
import { decode as decodeDagPb, code as dagPbCode } from '@ipld/dag-pb'
import { code as rawCode } from 'multiformats/codecs/raw'
import { createGalleryFixtures, validateFixtureBlocks, type GalleryFixtures } from './unixfs'
import { startTrustlessGateway } from '../support/trustless-gateway'
import { normalizeGateway } from '../../src/network/gateways'
import { FIXTURE_GATEWAYS, sourceUrl } from '../e2e/gateway-route'

let fixtures: GalleryFixtures
beforeAll(async () => { fixtures = await createGalleryFixtures() })

async function readFile(path: string): Promise<Uint8Array> {
  const entry = await exporter(path, fixtures.store)
  if (entry.type !== 'file' && entry.type !== 'raw') throw new Error('Expected a UnixFS file')
  const chunks: Uint8Array[] = []
  for await (const chunk of entry.content()) chunks.push(chunk)
  return new Uint8Array(Buffer.concat(chunks))
}

describe('standard UnixFS fixtures', () => {
  it('hashes every block and retains complete raw and DAG-PB graphs', async () => {
    await validateFixtureBlocks(fixtures.blocks)
    expect(fixtures.blocks.get(fixtures.raw.cid)!.cid.code).toBe(rawCode)
    expect(fixtures.blocks.get(fixtures.dagPb.cid)!.cid.code).toBe(dagPbCode)
    for (const asset of [fixtures.multiblock, fixtures.video]) {
      const root = fixtures.blocks.get(asset.cid)!
      expect(root.cid.code).toBe(dagPbCode)
      expect(decodeDagPb(root.bytes).Links.length).toBeGreaterThan(1)
    }
  })

  it('exports exact original image/video bytes through the v7 generator blockstore', async () => {
    for (const asset of [fixtures.raw, fixtures.dagPb, fixtures.multiblock, fixtures.video, fixtures.thumbnail]) {
      expect(await readFile(asset.cid)).toEqual(asset.bytes)
    }
    for (const directory of Object.values(fixtures.directories)) {
      for (const [path, asset] of Object.entries(directory.files)) {
        expect(await readFile(`${directory.ref.cid}/${path}`)).toEqual(asset.bytes)
      }
    }
    for (const manifest of Object.values(fixtures.manifests)) {
      expect(await readFile(`${manifest.ref.cid}/${manifest.ref.path.join('/')}`)).toEqual(manifest.bytes)
    }
  })

  it('addresses distinct original and thumbnail bytes in a real gallery manifest', async () => {
    const manifestFile = fixtures.thumbnailGallery.files['gallery.json']!
    const bytes = await readFile(`${manifestFile.ref.cid}/${manifestFile.ref.path.join('/')}`)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      items: { cid: string; thumbnail: { cid: string } }[]
    }
    for (const [index, original] of [fixtures.raw, fixtures.dagPb].entries()) {
      const item = manifest.items[index]!
      expect(await readFile(item.cid)).toEqual(original.bytes)
      expect(await readFile(item.thumbnail.cid)).toEqual(fixtures.thumbnail.bytes)
      expect(fixtures.thumbnail.bytes).not.toEqual(original.bytes)
      const view = new DataView(fixtures.thumbnail.bytes.buffer)
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([12, 8])
    }
  })

  it('uses a real HAMT shard and enumerates filenames rather than shard links', async () => {
    const entry = await exporter(fixtures.directories.hamt.ref.cid, fixtures.store)
    expect(entry.type).toBe('directory')
    if (entry.type !== 'directory') throw new Error('Expected HAMT directory')
    expect(entry.unixfs.type).toBe('hamt-sharded-directory')
    const names: string[] = []
    for await (const child of entry.entries()) names.push(child.name)
    expect(names.sort()).toEqual(fixtures.expected.hamtPaths)
  })
})

describe('raw-block gateway', () => {
  it('accepts shared fixture gateway URLs through production gateway normalization', () => {
    const query = new URL(sourceUrl('cid', fixtures.raw.ref), 'http://127.0.0.1').searchParams
    const gateways = query.getAll('gateway')
    expect(gateways).toHaveLength(2)
    expect(gateways.map(normalizeGateway)).toEqual(Object.values(FIXTURE_GATEWAYS))
  })

  it('records real raw options, CORS and exact bytes on independent assigned ports', async () => {
    const first = await startTrustlessGateway(fixtures.blocks)
    const second = await startTrustlessGateway(fixtures.blocks)
    try {
      expect(first.origin).not.toBe(second.origin)
      const response = await fetch(`${first.origin}/ipfs/${fixtures.raw.cid}?format=raw`, {
        headers: { Accept: 'application/vnd.ipld.raw' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('content-type')).toBe('application/vnd.ipld.raw')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtures.raw.bytes)
      expect(first.requests[0]!.cid).toBe(fixtures.raw.cid)
      expect(first.requests[0]!.headers.accept).toBe('application/vnd.ipld.raw')
      expect(first.counts.total).toBe(1)
      expect(first.counts.peak).toBe(1)
      const preflight = await fetch(`${second.origin}/ipfs/${fixtures.raw.cid}?format=raw`, { method: 'OPTIONS' })
      expect(preflight.status).toBe(204)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it('serves corruption, per-block 404, Retry-After 429, delay and enforces raw requests', async () => {
    const gateway = await startTrustlessGateway(fixtures.blocks)
    const url = `${gateway.origin}/ipfs/${fixtures.raw.cid}?format=raw`
    const options = { headers: { Accept: 'application/vnd.ipld.raw' } }
    try {
      expect((await fetch(url)).status).toBe(406)
      expect((await fetch(`${gateway.origin}/ipfs/${fixtures.raw.cid}`, options)).status).toBe(406)
      gateway.setMode({ kind: 'corrupt' })
      const corrupt = new Uint8Array(await (await fetch(url, options)).arrayBuffer())
      expect(corrupt).not.toEqual(fixtures.raw.bytes)
      expect(fixtures.blocks.get(fixtures.raw.cid)!.bytes).toEqual(fixtures.raw.bytes)
      gateway.setBlockMode(fixtures.raw.cid, { kind: '404' })
      expect((await fetch(url, options)).status).toBe(404)
      gateway.setBlockMode(fixtures.raw.cid, undefined)
      gateway.setMode({ kind: '429', retryAfter: '2' })
      const busy = await fetch(url, options)
      expect(busy.status).toBe(429)
      expect(busy.headers.get('retry-after')).toBe('2')
      gateway.setMode({ kind: 'delay', milliseconds: 40 })
      const nextIndex = gateway.requests.length
      const pending = fetch(url, options)
      const observed = await gateway.waitForRequest((record) => gateway.requests.indexOf(record) === nextIndex)
      expect(observed.completedAt).toBeUndefined()
      expect(new Uint8Array(await (await pending).arrayBuffer())).toEqual(fixtures.raw.bytes)
      expect(observed.completedAt! - observed.startedAt).toBeGreaterThanOrEqual(30)
    } finally {
      await gateway.close()
    }
  })

  it('stops owned delayed requests and closes its server without leaving active connections', async () => {
    const gateway = await startTrustlessGateway(fixtures.blocks, { kind: 'delay', milliseconds: 60_000 })
    try {
      const pending = fetch(`${gateway.origin}/ipfs/${fixtures.raw.cid}?format=raw`, {
        headers: { Accept: 'application/vnd.ipld.raw' },
      }).catch((error: unknown) => error)
      await gateway.waitForRequest((record) => record.cid === fixtures.raw.cid)
      expect(gateway.counts.active).toBe(1)
      await gateway.close()
      expect(await pending).toBeInstanceOf(TypeError)
      await expect.poll(() => gateway.counts.active).toBe(0)
      expect(gateway.requests[0]!.aborted).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('observes consumer abort and rejects outstanding request waiters during teardown', async () => {
    const gateway = await startTrustlessGateway(fixtures.blocks, { kind: 'delay', milliseconds: 60_000 })
    try {
      const controller = new AbortController()
      const pending = fetch(`${gateway.origin}/ipfs/${fixtures.raw.cid}?format=raw`, {
        headers: { Accept: 'application/vnd.ipld.raw' }, signal: controller.signal,
      }).catch((error: unknown) => error)
      const record = await gateway.waitForRequest((request) => request.cid === fixtures.raw.cid)
      controller.abort()
      expect(await pending).toBeInstanceOf(DOMException)
      await expect.poll(() => record.aborted).toBe(true)
      const waiter = gateway.waitForRequest(() => false).catch((error: unknown) => error)
      await gateway.close()
      expect(await waiter).toBeInstanceOf(Error)
      expect(gateway.counts.active).toBe(0)
    } finally {
      await gateway.close()
    }
  })
})
