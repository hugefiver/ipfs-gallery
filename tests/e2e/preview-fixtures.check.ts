import { expect, test } from 'vitest'
import { createGalleryFixtures } from '../fixtures/unixfs'
import { createPreviewFixtures } from './preview-fixtures'
import { parseManifest } from '../../src/core/manifest'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { startTrustlessGateway } from '../support/trustless-gateway'

test('preview network fixtures contain distinct verified original and thumbnail references', async () => {
  const fixtures = await createGalleryFixtures()
  const preview = await createPreviewFixtures(fixtures)
  const result = parseManifest(preview.manifest.bytes, preview.manifest.ref, DEFAULT_LIMITS)
  expect(result.items).toHaveLength(preview.items.length)
  expect(new Set(preview.items.flatMap(item => [item.original.cid, item.thumbnail.cid])).size).toBe(preview.items.length * 2)
  for (const [index, item] of result.items.entries()) {
    const pair = preview.items[index]!
    expect(item.ref).toEqual(pair.original.ref)
    expect(item.thumbnail).toEqual(pair.thumbnail.ref)
    expect(pair.original.bytes).not.toEqual(pair.thumbnail.bytes)
  }
})

test('preview and standard DAG blocks cross the real raw-block fixture transport exactly', async () => {
  const fixtures = await createGalleryFixtures()
  const preview = await createPreviewFixtures(fixtures)
  const gateway = await startTrustlessGateway(fixtures.blocks)
  try {
    const cids = [fixtures.dagPb.cid, fixtures.multiblock.cid, preview.manifest.cid, preview.items[0]!.original.cid, preview.items[0]!.thumbnail.cid]
    for (const cid of cids) {
      const response = await fetch(`${gateway.origin}/ipfs/${cid}?format=raw`, { headers: { Accept: 'application/vnd.ipld.raw' } })
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtures.blocks.get(cid)!.bytes)
    }
    expect(gateway.requests.map(request => request.cid)).toEqual(cids)
    expect(gateway.requests.every(request => request.status === 200 && !request.aborted)).toBe(true)
  } finally {
    await gateway.close()
  }
})
