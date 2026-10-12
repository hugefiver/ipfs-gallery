import { describe, expect, it } from 'vitest'
import { readVerifiedAsset } from '../../src/core/media'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import type { ContentReader } from '../../src/core/types'
import { GIF, MemoryReader, PNG, ROOT, avif, jpeg, mp4, ref, utf8, webm, webp } from './fixtures'

const options = () => ({ signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS } })

describe('exclusive verified asset assembly and safe headers', () => {
  it.each([
    ['image/png', PNG, 1, 1], ['image/gif', GIF, 1, 1], ['image/jpeg', jpeg(), 2, 3],
    ['image/webp', webp(), 2, 3], ['image/avif', avif(), 2, 3],
    ['video/mp4', mp4(), 2, 3], ['video/webm', webm(), 2, 3],
  ] as const)('reads %s with no filename hints, exact bytes and recognized dimensions', async (mime, source, width, height) => {
    const reader = new MemoryReader().file(ref(ROOT), source)
    const result = await readVerifiedAsset(ref(ROOT), reader, options())
    expect(result).toMatchObject({ mime, kind: mime.startsWith('image/') ? 'image' : 'video', width, height, byteLength: source.length })
    expect(result.bytes.byteLength).toBe(source.length)
    expect(new Uint8Array(result.bytes)).toEqual(source)
    expect(result.bytes).not.toBe(source.buffer)
    const transferred = structuredClone(result.bytes, { transfer: [result.bytes] })
    expect(new Uint8Array(transferred)).toEqual(source)
    expect(source.buffer.byteLength).toBeGreaterThan(0)
  })
  it('supports unknown-size multi-chunk assembly under the peak-memory budget', async () => {
    const reader = new MemoryReader().file(ref(ROOT), PNG, false)
    const result = await readVerifiedAsset(ref(ROOT), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssemblyBytes: PNG.length * 2 } })
    expect(new Uint8Array(result.bytes)).toEqual(PNG)
    await expect(readVerifiedAsset(ref(ROOT), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssemblyBytes: PNG.length * 2 - 1 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
  })
  it('preflights stat size before allocating or reading and bounds observed unknown streams', async () => {
    const known = new MemoryReader().file(ref(ROOT), PNG)
    await expect(readVerifiedAsset(ref(ROOT), known, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssetBytes: PNG.length - 1 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(known.reads).toHaveLength(0)
    const unknown = new MemoryReader().file(ref(ROOT), PNG, false)
    await expect(readVerifiedAsset(ref(ROOT), unknown, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssetBytes: 4 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(unknown.closed).toBe(1)
  })
  it('accounts for retained backing buffers, not merely the small views into them', async () => {
    const backing = new Uint8Array(PNG.length * 10)
    backing.set(PNG)
    const reader = new MemoryReader().file(ref(ROOT), backing.subarray(0, PNG.length), false)
    await expect(readVerifiedAsset(ref(ROOT), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxAssemblyBytes: PNG.length * 2 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(reader.closed).toBe(1)
  })
  it('rejects under-read and over-read of verified stat sizes', async () => {
    for (const reported of [PNG.length + 1, PNG.length - 1]) {
      const reader = new MemoryReader().file(ref(ROOT), PNG)
      reader.stat = async () => ({ kind: 'file', size: BigInt(reported) })
      await expect(readVerifiedAsset(ref(ROOT), reader, options())).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
    }
  })
  it('rejects oversized dimensions and pixels before browser decoding, including coded video samples', async () => {
    for (const source of [jpeg(200, 2), webp(200, 2), avif(200, 2), mp4(200, 2), mp4(2, 3, 200, 2), webm(200, 2)]) {
      const reader = new MemoryReader().file(ref(ROOT), source)
      await expect(readVerifiedAsset(ref(ROOT), reader, { ...options(), limits: { ...DEFAULT_LIMITS, maxMediaDimension: 100 } }))
        .rejects.toMatchObject({ error: { code: 'LIMIT' } })
    }
    await expect(readVerifiedAsset(ref(ROOT), new MemoryReader().file(ref(ROOT), avif(10, 10)),
      { ...options(), limits: { ...DEFAULT_LIMITS, maxImagePixels: 99 } }))
      .rejects.toMatchObject({ error: { code: 'LIMIT' } })
  })
  it.each([
    utf8('<svg width="1" height="1"><script/></svg>'), utf8('<html><img src="https://example.org"></html>'),
    utf8('not image bytes'), PNG.subarray(0, 20), GIF.subarray(0, 12), jpeg().subarray(0, 9),
    webp().subarray(0, 20), avif().subarray(0, 30), mp4().subarray(0, 30), webm().subarray(0, 9),
  ])('rejects unsafe/unknown/truncated media %# rather than trusting its suffix', async (source) => {
    await expect(readVerifiedAsset(ref(ROOT, 'fake.png'), new MemoryReader().file(ref(ROOT, 'fake.png'), source), options()))
      .rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
  })
  it('rejects malformed container bounds, absent dimensions and invalid primary associations', async () => {
    const png = PNG.slice(); new DataView(png.buffer).setUint32(8, 14)
    const webpBytes = webp(); new DataView(webpBytes.buffer).setUint32(4, 0xffffffff, true)
    const avifBytes = avif(); avifBytes[avifBytes.length - 11] = 0
    const mp4Bytes = mp4(); new DataView(mp4Bytes.buffer).setUint32(0, 0xfffffff0)
    const badJpeg = jpeg(); badJpeg[5] = 1
    const sources = [png, webpBytes, mp4Bytes, badJpeg, avif(0, 2), mp4(0, 2), webm(0, 2)]
    // ipma is the authoritative association; a random ispe is not enough.
    const ipma = Buffer.from(avifBytes).indexOf('ipma')
    avifBytes[ipma + 15] = 0
    sources.push(avifBytes)
    for (const source of sources) {
      await expect(readVerifiedAsset(ref(ROOT), new MemoryReader().file(ref(ROOT), source), options()))
        .rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
    }
  })
  it('does not follow directories or symlinks and propagates signal cancellation', async () => {
    const reader = new MemoryReader().directory(ref(ROOT))
    await expect(readVerifiedAsset(ref(ROOT), reader, options())).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
    reader.stat = async () => ({ kind: 'symlink' })
    await expect(readVerifiedAsset(ref(ROOT), reader, options())).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
    const controller = new AbortController(); controller.abort()
    await expect(readVerifiedAsset(ref(ROOT), reader, { ...options(), signal: controller.signal }))
      .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
  })
  it('checks cancellation between chunks and closes the reader iterator', async () => {
    const controller = new AbortController()
    let closed = false
    const reader: ContentReader = {
      stat: async () => ({ kind: 'file', size: BigInt(PNG.length) }),
      ls: () => new MemoryReader().directory(ref(ROOT)).ls(ref(ROOT), new AbortController().signal),
      async *read() {
        try { yield PNG.subarray(0, 7); controller.abort(); yield PNG.subarray(7) }
        finally { closed = true }
      },
    }
    await expect(readVerifiedAsset(ref(ROOT), reader, { ...options(), signal: controller.signal }))
      .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    expect(closed).toBe(true)
  })
})
