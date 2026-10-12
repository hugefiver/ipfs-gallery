import { MemoryBlockstore } from 'blockstore-core/memory'
import { decode as decodeDagPb, code as dagPbCode } from '@ipld/dag-pb'
import { importer, importBytes } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import type { ImporterOptions, ImportResult } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ContentRef } from '../../src/shared/contracts'
import { createPng, fixtureMedia, IMAGE_SIZE, MULTIBLOCK_IMAGE_SIZE } from './media'

export interface FixtureBlock {
  cid: CID
  bytes: Uint8Array
}

/** Records original codecs: MemoryBlockstore.getAll() returns raw-codec CIDs. */
export class FixtureBlockstore extends MemoryBlockstore {
  readonly blocks = new Map<string, FixtureBlock>()

  override async put(...[cid, content, options]: Parameters<MemoryBlockstore['put']>) {
    const parts: Uint8Array[] = []
    if (content instanceof Uint8Array) parts.push(content)
    else for await (const part of content) parts.push(part)
    const bytes = new Uint8Array(Buffer.concat(parts))
    await super.put(cid, bytes, options)
    this.blocks.set(cid.toV1().toString(), { cid, bytes })
    return cid
  }
}

export interface FixtureFile {
  ref: ContentRef
  cid: string
  bytes: Uint8Array
}

export interface FixtureDirectory {
  ref: ContentRef
  files: Record<string, FixtureFile>
}

export interface GalleryFixtures {
  store: FixtureBlockstore
  blocks: Map<string, FixtureBlock>
  raw: FixtureFile
  dagPb: FixtureFile
  multiblock: FixtureFile
  video: FixtureFile
  thumbnail: FixtureFile
  thumbnailGallery: FixtureDirectory
  directories: Record<'json' | 'yaml' | 'toml' | 'nested' | 'hamt' | 'invalid', FixtureDirectory>
  manifests: Record<'json' | 'yaml' | 'toml' | 'extensionless' | 'standalone' | 'invalid', FixtureFile>
  expected: {
    title: string
    description: string
    imageTitles: string[]
    videoTitle: string
    tags: string[]
    hamtPaths: string[]
  }
}

export function contentUri(ref: ContentRef): string {
  return `ipfs://${ref.cid}${ref.path.length ? `/${ref.path.map(encodeURIComponent).join('/')}` : ''}`
}

const utf8 = (value: string) => new TextEncoder().encode(value)

async function file(store: FixtureBlockstore, bytes: Uint8Array, options: ImporterOptions = {}): Promise<FixtureFile> {
  const result = await importBytes(bytes, store, { cidVersion: 1, rawLeaves: true, ...options })
  const cid = result.cid.toV1().toString()
  return { cid, ref: { cid, path: [] }, bytes }
}

async function directory(
  store: FixtureBlockstore,
  files: Record<string, Uint8Array>,
  options: ImporterOptions = {},
): Promise<FixtureDirectory> {
  const results = new Map<string, ImportResult>()
  for await (const entry of importer(
    Object.entries(files).map(([path, content]) => ({ path, content })),
    store,
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true, ...options },
  )) {
    results.set(entry.path ?? '', entry)
  }
  const root = results.get('')
  if (!root) throw new Error('Importer did not yield a wrapped directory')
  const ref = { cid: root.cid.toV1().toString(), path: [] }
  return {
    ref,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => {
      const imported = results.get(path)
      if (!imported) throw new Error(`Importer did not yield ${path}`)
      return [path, { cid: imported.cid.toV1().toString(), ref: { ...ref, path: path.split('/') }, bytes }]
    })),
  }
}

export async function validateFixtureBlocks(blocks: ReadonlyMap<string, FixtureBlock>): Promise<void> {
  for (const [key, { cid, bytes }] of blocks) {
    if (cid.multihash.code !== sha256.code) throw new Error(`Unexpected fixture hash for ${key}`)
    const digest = await sha256.digest(bytes)
    if (!Buffer.from(digest.bytes).equals(Buffer.from(cid.multihash.bytes))) {
      throw new Error(`Fixture block hash mismatch: ${key}`)
    }
    if (key !== cid.toV1().toString()) throw new Error(`Noncanonical fixture key: ${key}`)
    if (cid.code === dagPbCode) {
      for (const link of decodeDagPb(bytes).Links) {
        if (!blocks.has(link.Hash.toV1().toString())) throw new Error(`Missing fixture child: ${link.Hash}`)
      }
    }
  }
}

export async function createGalleryFixtures(): Promise<GalleryFixtures> {
  const store = new FixtureBlockstore()
  const media = await fixtureMedia()
  const raw = await file(store, media.amber)
  const dagPb = await file(store, media.blue, { rawLeaves: false })
  const multiblock = await file(store, media.large, { chunker: fixedSize({ chunkSize: 1024 }) })
  const video = await file(store, media.video, { chunker: fixedSize({ chunkSize: 128 }) })
  const thumbnail = await file(store, createPng(12, 8, 4))
  const thumbnailGallery = await directory(store, {
    'gallery.json': utf8(JSON.stringify({
      version: 1,
      title: '原图与缩略图',
      items: [
        { cid: raw.cid, title: '第一原图', type: 'image', thumbnail: { cid: thumbnail.cid } },
        { cid: dagPb.cid, title: '第二原图', type: 'image', thumbnail: { cid: thumbnail.cid } },
      ],
    })),
  })
  const expected = {
    title: '可信影像夹具',
    description: '真实 UnixFS 内容；<img src=x onerror="window.fixtureExecuted=true"> 仅为文字。',
    imageTitles: ['琥珀影像', '蓝色影像', '多块影像'],
    videoTitle: '短片影像',
    tags: ['暖色', '共同', '冷色', '视频'],
    hamtPaths: Array.from({ length: 20 }, (_, index) => `frame-${String(index).padStart(2, '0')}.png`),
  }
  const manifest = {
    version: 1,
    title: expected.title,
    description: expected.description,
    items: [
      { path: './media/琥珀.png', title: expected.imageTitles[0], alt: '琥珀色测试像素', type: 'image', tags: ['暖色', '共同'], ...IMAGE_SIZE },
      { path: 'media/nested/无扩展名', title: expected.imageTitles[1], alt: '蓝色测试像素', type: 'image', tags: ['冷色', '共同'], ...IMAGE_SIZE },
      { cid: multiblock.cid, title: expected.imageTitles[2], type: 'image', tags: ['共同'], ...MULTIBLOCK_IMAGE_SIZE },
      { cid: video.cid, title: expected.videoTitle, type: 'video', tags: ['视频'] },
    ],
  }
  const manifestBytes = {
    json: utf8(JSON.stringify(manifest)),
    yaml: utf8(stringifyYaml(manifest)),
    toml: utf8(stringifyToml(manifest)),
  }
  // Ensure the serializer outputs represent the same protocol data.
  if (!isDeepStrictEqual(parseYaml(new TextDecoder().decode(manifestBytes.yaml)), manifest)) {
    throw new Error('YAML fixture roundtrip failed')
  }
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(parseToml(new TextDecoder().decode(manifestBytes.toml)))), manifest)) {
    throw new Error('TOML fixture roundtrip failed')
  }
  const mediaFiles = { 'media/琥珀.png': media.amber, 'media/nested/无扩展名': media.blue }
  const json = await directory(store, { 'gallery.json': manifestBytes.json, ...mediaFiles })
  const yaml = await directory(store, { 'gallery.yaml': manifestBytes.yaml, ...mediaFiles })
  const toml = await directory(store, { 'gallery.toml': manifestBytes.toml, ...mediaFiles })
  const nested = await directory(store, {
    'album/first.png': media.amber,
    'album/nested/无扩展名': media.blue,
    'album/nested/clip.webm': media.video,
    'album/readme.txt': utf8('This is not media.'),
  })
  const hamt = await directory(store, Object.fromEntries(expected.hamtPaths.map((path, index) => [
    path, index % 2 ? media.blue : media.amber,
  ])), { shardSplitThresholdBytes: 64 })
  const invalidBytes = utf8(JSON.stringify({ version: 99, title: '无效元数据', items: [] }))
  const invalid = await directory(store, {
    'gallery.json': invalidBytes,
    'gallery.yaml': manifestBytes.yaml,
    ...mediaFiles,
  })
  const extensionlessDirectory = await directory(store, {
    'metadata/manifest': utf8(JSON.stringify({
      ...manifest,
      items: [
        { path: '../media/琥珀.png', title: '父目录相对路径', tags: ['暖色'], type: 'image' },
        { path: '../media/nested/无扩展名', title: '嵌套无扩展名', type: 'image' },
      ],
    })),
    ...mediaFiles,
  })
  const standalone = await file(store, utf8(JSON.stringify({
    version: 1,
    title: '裸 CID 元数据',
    items: [{ cid: raw.cid, title: '独立原始图片', type: 'image' }, { cid: dagPb.cid, title: '独立 DAG-PB 图片', type: 'image' }],
  })))
  const fixtures: GalleryFixtures = {
    store,
    blocks: store.blocks,
    raw,
    dagPb,
    multiblock,
    video,
    thumbnail,
    thumbnailGallery,
    directories: { json, yaml, toml, nested, hamt, invalid },
    manifests: {
      json: json.files['gallery.json']!,
      yaml: yaml.files['gallery.yaml']!,
      toml: toml.files['gallery.toml']!,
      extensionless: extensionlessDirectory.files['metadata/manifest']!,
      standalone,
      invalid: invalid.files['gallery.json']!,
    },
    expected,
  }
  await validateFixtureBlocks(fixtures.blocks)
  return fixtures
}
