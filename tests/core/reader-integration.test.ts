import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createGalleryFixtures } from '../fixtures/unixfs'
import type { GalleryFixtures } from '../fixtures/unixfs'
import { createGatewayBroker } from '../../src/network/broker'
import { createContentReader } from '../../src/network/reader'
import type { VerifiedBlockSource } from '../../src/network/types'
import { discoverGallery } from '../../src/core/gallery'
import { readVerifiedAsset } from '../../src/core/media'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

let fixtures: GalleryFixtures
const sources: VerifiedBlockSource[] = []
const options = () => ({ signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS } })

beforeAll(async () => { fixtures = await createGalleryFixtures() })
afterEach(() => { for (const source of sources.splice(0)) source.dispose() })

function setup() {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const cid = url.pathname.split('/').at(-1)!
    const block = fixtures.blocks.get(cid)
    return block ? new Response(new Uint8Array(block.bytes).buffer, { headers: { 'Content-Type': 'application/vnd.ipld.raw' } })
      : new Response(null, { status: 404 })
  }
  const source = createGatewayBroker({ gateways: ['https://fixture-gateway.tld'], limits: { ...DEFAULT_LIMITS } },
    { fetch, now: () => Date.now(), random: () => 0 })
  sources.push(source)
  return {
    discoveryReader: () => createContentReader(source, { maxInputBytes: DEFAULT_LIMITS.maxDiscoveryInputBytes }),
    assetReader: () => createContentReader(source, { maxInputBytes: DEFAULT_LIMITS.maxAssetInputBytes }),
  }
}

describe('core with standard UnixFS and CID-verified fixture blocks', () => {
  it.each(['json', 'yaml', 'toml'] as const)('auto-discovers %s and loads all real image/video bytes exactly', async (format) => {
    const { discoveryReader, assetReader } = setup()
    const directory = fixtures.directories[format]
    const result = await discoverGallery({ source: { kind: 'unixfs', ref: directory.ref, browse: false } }, discoveryReader(), options())
    expect(result).toMatchObject({ title: fixtures.expected.title, description: fixtures.expected.description, partial: false })
    expect(result.items.map((item) => item.title)).toEqual([...fixtures.expected.imageTitles, fixtures.expected.videoTitle])
    const expectedBytes = [directory.files['media/琥珀.png']!.bytes, directory.files['media/nested/无扩展名']!.bytes, fixtures.multiblock.bytes, fixtures.video.bytes]
    for (const [index, item] of result.items.entries()) {
      const asset = await readVerifiedAsset(item.ref, assetReader(), options())
      expect(new Uint8Array(asset.bytes)).toEqual(expectedBytes[index])
      expect(asset.byteLength).toBe(expectedBytes[index]!.length)
      expect(asset.width).toBeGreaterThan(0)
      expect(asset.height).toBeGreaterThan(0)
    }
  })
  it('scans true HAMT children, preserves repeat content paths and never displays shard links', async () => {
    const { discoveryReader } = setup()
    const result = await discoverGallery({ source: { kind: 'unixfs', ref: fixtures.directories.hamt.ref, browse: false } }, discoveryReader(), options())
    expect(result.items.map((item) => item.title)).toEqual(fixtures.expected.hamtPaths)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(20)
    expect(new Set(result.items.map((item) => item.ref.cid)).size).toBe(2)
    expect(result.partial).toBe(false)
  })
  it('resolves extensionless parent-relative metadata and strict standalone file-CID metadata', async () => {
    const { discoveryReader, assetReader } = setup()
    for (const manifest of [fixtures.manifests.extensionless, fixtures.manifests.standalone]) {
      const result = await discoverGallery({ source: { kind: 'manifest', ref: manifest.ref } }, discoveryReader(), options())
      expect(result.items).toHaveLength(2)
      for (const item of result.items) {
        const asset = await readVerifiedAsset(item.ref, assetReader(), options())
        expect(asset.mime).toBe('image/png')
      }
    }
  })
  it('does not skip invalid authoritative JSON and browse=1 yields the actual directory media', async () => {
    const { discoveryReader } = setup()
    await expect(discoverGallery({ source: { kind: 'unixfs', ref: fixtures.directories.invalid.ref, browse: false } }, discoveryReader(), options()))
      .rejects.toMatchObject({ error: { code: 'INVALID_METADATA' } })
    const browsed = await discoverGallery({ source: { kind: 'unixfs', ref: fixtures.directories.invalid.ref, browse: true } }, discoveryReader(), options())
    expect(browsed.items).toHaveLength(2)
    expect(browsed.partial).toBe(false)
  })
})
