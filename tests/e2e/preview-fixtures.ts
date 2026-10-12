import { importBytes } from 'ipfs-unixfs-importer'
import { createPng } from '../fixtures/media'
import { validateFixtureBlocks, type FixtureFile, type GalleryFixtures } from '../fixtures/unixfs'
import { parseManifest } from '../../src/core/manifest'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

export interface PreviewFixtures {
  manifest: FixtureFile
  items: { id: string; title: string; original: FixtureFile; thumbnail: FixtureFile }[]
}

/** Distinct original/thumbnail blocks make lazy scheduling observable over real UnixFS. */
export async function createPreviewFixtures(fixtures: GalleryFixtures): Promise<PreviewFixtures> {
  async function file(bytes: Uint8Array): Promise<FixtureFile> {
    const { cid: imported } = await importBytes(bytes, fixtures.store, { cidVersion: 1, rawLeaves: true })
    const cid = imported.toV1().toString()
    return { cid, ref: { cid, path: [] }, bytes }
  }
  const pairs = []
  for (let index = 0; index < 24; index += 1) {
    pairs.push({
      title: `预览-${String(index).padStart(2, '0')}${index === 23 ? '-很长的文件名'.repeat(12) : ''}.png`,
      original: await file(createPng(96, 64, 100 + index)),
      thumbnail: await file(createPng(16, 12, 200 + index)),
    })
  }
  const manifest = await file(new TextEncoder().encode(JSON.stringify({
    version: 1, title: '原图与缩略图调度夹具',
    items: pairs.map(({ title, original, thumbnail }) => ({
      cid: original.cid, title, type: 'image', width: 96, height: 64, thumbnail: { cid: thumbnail.cid },
    })),
  })))
  const parsed = parseManifest(manifest.bytes, manifest.ref, DEFAULT_LIMITS)
  await validateFixtureBlocks(fixtures.blocks)
  return { manifest, items: pairs.map((pair, index) => ({ ...pair, id: parsed.items[index]!.id })) }
}
