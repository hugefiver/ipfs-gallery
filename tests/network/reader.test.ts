import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { importer } from 'ipfs-unixfs-importer'
import type { ImportResult } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { createGatewayBroker } from '../../src/network/broker'
import { createContentReader } from '../../src/network/reader'
import type { VerifiedBlockSource } from '../../src/network/types'
import { cidFromRequest, collect, collectBytes, config, rawBlock, response, signal } from './helpers'

const store = new MemoryBlockstore()
let seed = 0x12345678
const bigBytes = Uint8Array.from({ length: 300_001 }, () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed & 255
})
let root: string
let hamt: string
const imports = new Map<string, ImportResult>()
const sources: VerifiedBlockSource[] = []

beforeAll(async () => {
  const files = [
    { path: 'album/large.bin', content: bigBytes },
    { path: 'album/nested/雪 #?,%.png', content: Uint8Array.of(1, 2, 3, 4) },
    { path: 'album/link', link: 'nested/雪 #?,%.png' },
    ...Array.from({ length: 80 }, (_, index) => ({ path: `album/sharded/file-${index}.bin`, content: Uint8Array.of(index, index + 1) })),
  ]
  for await (const entry of importer(files, store, { rawLeaves: true, cidVersion: 1, chunker: fixedSize({ chunkSize: 8192 }), shardSplitThresholdBytes: 128 })) {
    imports.set(entry.path ?? '', entry)
  }
  root = imports.get('album')!.cid.toString()
  hamt = imports.get('album/sharded')!.cid.toString()
})

afterEach(() => { for (const source of sources.splice(0)) source.dispose() })

function setup(maxInputBytes = 10_000_000) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => response(await collectBytes(store.get(CID.parse(cidFromRequest(input))))))
  const source = createGatewayBroker(config(), { fetch, now: () => Date.now(), random: () => 0 })
  sources.push(source)
  return { source, fetch, reader: createContentReader(source, { maxInputBytes }) }
}

describe('standard UnixFS adapter through verified raw-block broker', () => {
  it('reconstructs a real imported multiblock file exactly, with offset and length in file bytes', async () => {
    const { reader, fetch } = setup()
    const ref = { cid: root, path: ['large.bin'] }
    expect(await reader.stat(ref, signal())).toEqual({ kind: 'file', size: BigInt(bigBytes.byteLength) })
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: bigBytes.length }))).toEqual(bigBytes)
    expect(fetch.mock.calls.length).toBeGreaterThan(30)
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: 17_777, offset: 7001, length: 17_777 }))).toEqual(bigBytes.slice(7001, 24_778))
  })

  it('lists and resolves standard HAMT entries, not internal shard links', async () => {
    expect(imports.get('album/sharded')?.unixfs?.type).toBe('hamt-sharded-directory')
    const { reader, fetch } = setup()
    const entries = await collect(reader.ls({ cid: hamt, path: [] }, signal()))
    expect(entries).toHaveLength(80)
    expect(entries.every((entry) => entry.kind === 'file' && entry.size === 2n)).toBe(true)
    expect(entries.map((entry) => entry.name).sort()).toEqual(Array.from({ length: 80 }, (_, index) => `file-${index}.bin`).sort())
    expect(fetch.mock.calls.length).toBeGreaterThan(81)
    for (const index of [0, 17, 79]) {
      const result = await collectBytes(reader.read({ cid: root, path: ['sharded', `file-${index}.bin`] }, { signal: signal(), maxBytes: 2 }))
      expect(result).toEqual(Uint8Array.of(index, index + 1))
    }
  })

  it('preserves literal special filenames and exposes symlinks without reading their target', async () => {
    const { reader } = setup()
    const entries = await collect(reader.ls({ cid: root, path: [] }, signal()))
    expect(entries.find((entry) => entry.name === 'link')?.kind).toBe('symlink')
    expect(entries.find((entry) => entry.name === 'nested')?.kind).toBe('directory')
    expect(await collectBytes(reader.read({ cid: root, path: ['nested', '雪 #?,%.png'] }, { signal: signal(), maxBytes: 4 }))).toEqual(Uint8Array.of(1, 2, 3, 4))
    await expect(collectBytes(reader.read({ cid: root, path: ['link'] }, { signal: signal(), maxBytes: 100 }))).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
  })

  it('enforces output limits before assembling a large file and handles empty or EOF ranges', async () => {
    const { reader, fetch } = setup()
    const ref = { cid: imports.get('album/large.bin')!.cid.toString(), path: [] }
    await expect(collectBytes(reader.read(ref, { signal: signal(), maxBytes: 100 }))).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: 0, length: 0 }))).toEqual(new Uint8Array())
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: 0, offset: bigBytes.length + 1 }))).toEqual(new Uint8Array())
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: 1, offset: bigBytes.length - 1, length: 100 }))).toEqual(bigBytes.slice(-1))
    await expect(collectBytes(reader.read(ref, { signal: signal(), maxBytes: 10, offset: -1 }))).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('counts stat/read cache hits toward each reader independent input budget', async () => {
    const block = await rawBlock('count cache input')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(block.bytes))
    const source = createGatewayBroker(config(), { fetch, now: () => Date.now(), random: () => 0 })
    sources.push(source)
    const ref = { cid: block.cid, path: [] }
    const first = createContentReader(source, { maxInputBytes: block.bytes.length * 2 })
    const second = createContentReader(source, { maxInputBytes: block.bytes.length })
    expect(await first.stat(ref, signal())).toEqual({ kind: 'file', size: BigInt(block.bytes.length) })
    expect(await collectBytes(first.read(ref, { signal: signal(), maxBytes: block.bytes.length }))).toEqual(block.bytes)
    await expect(first.stat(ref, signal())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(await second.stat(ref, signal())).toEqual({ kind: 'file', size: BigInt(block.bytes.length) })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('counts cached directory metadata against the cumulative ls input budget', async () => {
    const rootBytes = await collectBytes(store.get(CID.parse(hamt)))
    const { source, fetch } = setup()
    const reader = createContentReader(source, { maxInputBytes: rootBytes.length })
    expect(await reader.stat({ cid: hamt, path: [] }, signal())).toEqual({ kind: 'directory' })
    await expect(collect(reader.ls({ cid: hamt, path: [] }, signal()))).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('counts bounded inline identity input and rejects non-UnixFS codec honestly', async () => {
    const { source } = setup()
    const bytes = Uint8Array.of(1, 2, 3)
    const ref = { cid: CID.createV1(0x55, identity.digest(bytes)).toString(), path: [] }
    const reader = createContentReader(source, { maxInputBytes: 3 })
    expect(await collectBytes(reader.read(ref, { signal: signal(), maxBytes: 3 }))).toEqual(bytes)
    await expect(reader.stat(ref, signal())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    await expect(reader.stat({ cid: CID.createV1(0x71, identity.digest(bytes)).toString(), path: [] }, signal())).rejects.toMatchObject({ error: { code: 'UNSUPPORTED' } })
  })

  it('maps missing paths to NOT_FOUND and rejects traversal segments', async () => {
    const { reader } = setup()
    await expect(reader.stat({ cid: root, path: ['does-not-exist'] }, signal())).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    await expect(reader.stat({ cid: root, path: ['..', 'large.bin'] }, signal())).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('propagates read cancellation to the active broker fetch without gateway failure penalties', async () => {
    const block = await rawBlock('stall')
    let fetchSignal: AbortSignal | null | undefined
    let started!: () => void
    const start = new Promise<void>((resolve) => { started = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>((_input, options) => {
      fetchSignal = options?.signal
      started()
      return new Promise(() => {})
    })
    const source = createGatewayBroker(config(), { fetch, now: () => Date.now(), random: () => 0 })
    sources.push(source)
    const reader = createContentReader(source, { maxInputBytes: 100 })
    const controller = new AbortController()
    const read = collectBytes(reader.read({ cid: block.cid, path: [] }, { signal: controller.signal, maxBytes: 100 }))
    const cancelled = expect(read).rejects.toMatchObject({ error: { code: 'CANCELLED' } })
    await start
    controller.abort()
    await cancelled
    expect(fetchSignal?.aborted).toBe(true)
    expect(source.snapshot().every((gateway) => gateway.failures === 0 && gateway.inFlight === 0)).toBe(true)
  })

  it('does not prefetch the rest of a multiblock file after the consumer stops iteration', async () => {
    const { reader, fetch } = setup()
    const ref = { cid: imports.get('album/large.bin')!.cid.toString(), path: [] }
    for await (const chunk of reader.read(ref, { signal: signal(), maxBytes: bigBytes.length })) {
      expect(chunk).toEqual(bigBytes.slice(0, 8192))
      break
    }
    const count = fetch.mock.calls.length
    expect(count).toBeLessThan(5)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetch).toHaveBeenCalledTimes(count)
  })
})
