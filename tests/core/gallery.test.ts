import { describe, expect, it, vi } from 'vitest'
import { discoverGallery } from '../../src/core/gallery'
import { readVerifiedAsset } from '../../src/core/media'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { GalleryDomainError } from '../../src/shared/errors'
import type { GalleryInput } from '../../src/shared/contracts'
import type { ContentReader } from '../../src/core/types'
import { GIF, MemoryReader, OTHER, PNG, ROOT, THIRD, cid, entry, ref, utf8 } from './fixtures'

const options = () => ({ signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS } })
const unixfs = (browse = false): GalleryInput => ({ source: { kind: 'unixfs', ref: ref(ROOT), browse } })
const cids: GalleryInput = { source: { kind: 'cids', refs: [ref(ROOT), ref(OTHER)], browse: false } }
const metaText = (title = 'Manifest') => utf8(JSON.stringify({ version: 1, title, items: [{ cid: THIRD, title: 'Editorial' }] }))

describe('reader-driven gallery discovery', () => {
  it.each(['json', 'yaml', 'toml'])('reads explicit %s through the verified reader', async (extension) => {
    const target = ref(ROOT, 'gallery.' + extension)
    const source = extension === 'json' ? metaText() : extension === 'yaml'
      ? utf8(`version: 1\nitems:\n - cid: ${THIRD}`) : utf8(`version = 1\n[[items]]\ncid = "${THIRD}"`)
    const reader = new MemoryReader().file(target, source)
    const result = await discoverGallery({ source: { kind: 'manifest', ref: target } }, reader, options())
    expect(result.items[0]!.ref).toEqual(ref(THIRD))
    expect(reader.reads).toHaveLength(1)
  })
  it('uses the filename priority, not directory entry order, and never probes later candidates after existence', async () => {
    const reader = new MemoryReader().directory(ref(ROOT))
      .file(ref(ROOT, 'gallery.json'), metaText('JSON'))
      .file(ref(ROOT, 'gallery.yaml'), utf8('version: 1\nitems: []\ntitle: YAML'))
    const result = await discoverGallery(unixfs(), reader, options())
    expect(result.title).toBe('JSON')
    expect(reader.reads.map((call) => call.ref)).toEqual([ref(ROOT, 'gallery.json')])
    expect(reader.stats).not.toContainEqual(ref(ROOT, 'gallery.yaml'))
    expect(reader.listings).toHaveLength(0)
  })
  it('finds yaml, yml and toml only when preceding candidate names do not exist', async () => {
    for (const extension of ['yaml', 'yml', 'toml']) {
      const source = extension === 'toml' ? 'version = 1\nitems = []' : 'version: 1\nitems: []'
      const reader = new MemoryReader().directory(ref(ROOT)).file(ref(ROOT, `gallery.${extension}`), utf8(source))
      await expect(discoverGallery(unixfs(), reader, options())).resolves.toMatchObject({ items: [], partial: false })
      expect(reader.reads[0]!.ref).toEqual(ref(ROOT, `gallery.${extension}`))
    }
  })
  it('keeps broken authoritative metadata fatal but browse=1 scans files instead', async () => {
    const image = ref(THIRD)
    const reader = new MemoryReader().directory(ref(ROOT), [entry('photo', image, 'file', BigInt(PNG.length))])
      .file(ref(ROOT, 'gallery.json'), utf8('broken')).file(ref(ROOT, 'gallery.yaml'), utf8('version: 1\nitems: []'))
      .file(image, PNG)
    await expect(discoverGallery(unixfs(), reader, options())).rejects.toMatchObject({ error: { code: 'INVALID_METADATA' } })
    expect(reader.reads).toHaveLength(1)
    const browsed = await discoverGallery(unixfs(true), reader, options())
    expect(browsed.items).toHaveLength(1)
    expect(browsed.items[0]!.kind).toBe('image')
    await expect(discoverGallery({ source: { kind: 'manifest', ref: ref(ROOT, 'gallery.json') } }, reader, options()))
      .rejects.toMatchObject({ error: { code: 'INVALID_METADATA' } })
  })
  it('never treats a metadata gateway block 404 as an absent directory name', async () => {
    const reader = new MemoryReader().directory(ref(ROOT)).file(ref(ROOT, 'gallery.yaml'), utf8('version: 1\nitems: []'))
    const stat = reader.stat.bind(reader)
    reader.stat = async (target, signal) => {
      if (target.path.at(-1) === 'gallery.json') {
        throw new GalleryDomainError({ code: 'NOT_FOUND', message: 'fixture block unavailable', retryable: true, gateway: 'https://fixture.tld' })
      }
      return stat(target, signal)
    }
    await expect(discoverGallery(unixfs(), reader, options())).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(reader.reads).toHaveLength(0)
  })
  it('discovers no-extension media, skips suffix-only false positives and ignores nested manifests', async () => {
    const image = ref(cid('image')), nested = ref(cid('nested')), falseImage = ref(cid('fake'))
    const nestedMeta = ref(cid('nested meta'))
    const reader = new MemoryReader().directory(ref(ROOT), [entry('z.jpg', falseImage), entry('nested', nested, 'directory'), entry('a', image)])
      .directory(nested, [entry('gallery.json', nestedMeta), entry('b', ref(THIRD))])
      .file(image, PNG).file(falseImage, utf8('<svg><script/></svg>')).file(nestedMeta, metaText()).file(ref(THIRD), GIF)
    const result = await discoverGallery(unixfs(), reader, options())
    expect(result.items.map((item) => item.title)).toEqual(['a', 'b'])
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED', ref: falseImage }))
    expect(reader.stats).not.toContainEqual({ ...nested, path: ['gallery.json'] })
    const asset = await readVerifiedAsset(result.items[0]!.ref, reader, options())
    expect(new Uint8Array(asset.bytes)).toEqual(PNG)
  })
  it('recognizes bare file/raw roots and small extensionless valid manifests, not arbitrary text', async () => {
    const reader = new MemoryReader().file(ref(ROOT), PNG).file(ref(OTHER), metaText())
    const result = await discoverGallery(cids, reader, options())
    expect(result.items.map((item) => item.ref)).toEqual([ref(ROOT), ref(THIRD)])
    expect(result.items[0]!.title).toBe(ROOT)
    await expect(discoverGallery(unixfs(), new MemoryReader().file(ref(ROOT), utf8('ordinary text')), options()))
      .rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
  })
  it('isolates failed roots, retains root order, sorts each root by path, and has stable IDs', async () => {
    const a = ref(cid('a')), b = ref(cid('b'))
    const reader = new MemoryReader().directory(ref(ROOT), [entry('b', b), entry('a', a)])
      .file(a, PNG).file(b, GIF).error(ref(OTHER)).file(ref(THIRD), GIF)
    const input: GalleryInput = { source: { kind: 'cids', refs: [ref(ROOT), ref(OTHER), ref(THIRD), ref(ROOT)], browse: true } }
    const result = await discoverGallery(input, reader, options())
    expect(result.items.map((item) => item.ref)).toEqual([a, b, ref(THIRD)])
    expect(result.partial).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'NETWORK', ref: ref(OTHER) }))
    expect((await discoverGallery(input, reader, options())).items).toEqual(result.items)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(3)
  })
  it('warns for symlinks/cycles while preserving the same CID at different legitimate paths', async () => {
    const sub = ref(OTHER), image = ref(THIRD)
    const reader = new MemoryReader().directory(ref(ROOT), [entry('second', sub, 'directory'), entry('first', sub, 'directory'), entry('link', image, 'symlink')])
      .directory(sub, [entry('cycle', ref(ROOT), 'directory'), entry('image', image)])
      .file(image, PNG)
    const result = await discoverGallery(unixfs(true), reader, options())
    expect(result.items).toHaveLength(2)
    expect(result.items[0]!.id).not.toBe(result.items[1]!.id)
    expect(result.items.map((item) => item.ref)).toEqual([image, image])
    expect(result.warnings.filter((warning) => warning.code === 'UNSUPPORTED')).toHaveLength(3)
    expect(result.partial).toBe(true)
  })
  it('returns visible partial LIMIT results for entry, recursion and aggregate item caps', async () => {
    const image = ref(THIRD), sub = ref(OTHER)
    const reader = new MemoryReader().directory(ref(ROOT), [entry('a', image), entry('b', image), entry('sub', sub, 'directory')])
      .directory(sub, [entry('c', image)]).file(image, PNG)
    const entryLimit = await discoverGallery(unixfs(true), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxDirectoryEntries: 1 } })
    expect(entryLimit).toMatchObject({ partial: true, items: [expect.anything()], warnings: [expect.objectContaining({ code: 'LIMIT' })] })
    const depthLimit = await discoverGallery(unixfs(true), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxDirectoryDepth: 0 } })
    expect(depthLimit.items).toHaveLength(2)
    expect(depthLimit.partial).toBe(true)
    const itemLimit = await discoverGallery(unixfs(true), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxItems: 1 } })
    expect(itemLimit.items).toHaveLength(1)
    expect(itemLimit.partial).toBe(true)
    expect(reader.closed).toBeGreaterThan(0)
  })
  it('enforces manifest, source, media and discovery-output limits', async () => {
    const reader = new MemoryReader().directory(ref(ROOT), [entry('a', ref(THIRD), 'file', BigInt(PNG.length))]).file(ref(THIRD), PNG)
    await expect(discoverGallery(cids, reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxRoots: 1 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    const tooLarge = await discoverGallery(unixfs(true), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssetBytes: 1 } })
    expect(tooLarge).toMatchObject({ partial: true, items: [], warnings: [expect.objectContaining({ code: 'LIMIT' })] })
    const tinyInput = await discoverGallery(unixfs(true), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxDiscoveryInputBytes: 1 } })
    expect(tinyInput).toMatchObject({ partial: true, items: [], warnings: [expect.objectContaining({ code: 'LIMIT' })] })
    const target = ref(ROOT, 'gallery.json')
    reader.file(target, metaText())
    await expect(discoverGallery({ source: { kind: 'manifest', ref: target } }, reader,
      { ...options(), limits: { ...DEFAULT_LIMITS, maxManifestBytes: 1 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
  })
  it('propagates reader cancellation and pre-aborted signals instead of partial success', async () => {
    const reader = new MemoryReader().error(ref(ROOT), 'CANCELLED').file(ref(OTHER), PNG)
    await expect(discoverGallery(cids, reader, options())).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    const controller = new AbortController(); controller.abort()
    await expect(discoverGallery(cids, reader, { ...options(), signal: controller.signal }))
      .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    expect(reader.stats).not.toContainEqual(ref(OTHER))
  })
  it('terminates directory iteration on cancellation and propagates signal timeout', async () => {
    const controller = new AbortController()
    let closed = false
    const reader: ContentReader = {
      stat: async () => ({ kind: 'directory' }),
      async *ls() {
        try { yield entry('a', ref(THIRD)); controller.abort(); yield entry('b', ref(THIRD)) }
        finally { closed = true }
      },
      async *read() { yield PNG },
    }
    await expect(discoverGallery(unixfs(true), reader, { ...options(), signal: controller.signal }))
      .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    expect(closed).toBe(true)
    const timeout = new AbortController(); timeout.abort(new DOMException('timeout', 'TimeoutError'))
    await expect(discoverGallery(unixfs(), reader, { ...options(), signal: timeout.signal }))
      .rejects.toMatchObject({ error: { code: 'TIMEOUT' } })
  })
  it('throttles progress and never invents an unknown total', async () => {
    const reader = new MemoryReader().directory(ref(ROOT), [entry('a', ref(THIRD))]).file(ref(THIRD), PNG)
    const onProgress = vi.fn()
    await discoverGallery(unixfs(true), reader, { ...options(), onProgress })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress.mock.calls[0]![0].total).toBeUndefined()
  })
  it('never swallows plain AbortError from the reader as an unsupported item', async () => {
    const reader = new MemoryReader().directory(ref(ROOT), [entry('a', ref(THIRD))])
    reader.read = async function* () { throw new DOMException('abort', 'AbortError'); yield PNG }
    await expect(discoverGallery(unixfs(true), reader, options())).rejects.toBeInstanceOf(GalleryDomainError)
  })
})
