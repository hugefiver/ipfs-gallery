import { createHash } from 'node:crypto'
import { CID } from 'multiformats/cid'
import { create as digest } from 'multiformats/hashes/digest'
import type { ContentRef } from '../../src/shared/contracts'
import { GalleryDomainError } from '../../src/shared/errors'
import { canonicalRef } from '../../src/core/paths'
import type { ContentEntry, ContentReader, ContentStat, ReadOptions } from '../../src/core/types'

export function cid(value: string): string {
  return CID.createV1(0x55, digest(0x12, createHash('sha256').update(value).digest())).toString()
}
export const ROOT = cid('root'), OTHER = cid('other'), THIRD = cid('third')
export const ref = (value = ROOT, ...path: string[]): ContentRef => ({ cid: value, path })
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
export const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWWQAAAAASUVORK5CYII=', 'base64'))
export const GIF = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'))
export function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}
export function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value)
  return result
}
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const data = concat(...parts)
  return concat(uint32(data.length + 8), utf8(type), data)
}
export function avif(width = 2, height = 3): Uint8Array {
  const ispe = box('ispe', uint32(0), uint32(width), uint32(height))
  return concat(box('ftyp', utf8('avif'), uint32(0), utf8('mif1')),
    box('meta', uint32(0), box('pitm', new Uint8Array([0, 0, 0, 0, 0, 1])),
      box('iprp', box('ipco', ispe), box('ipma', uint32(0), uint32(1), new Uint8Array([0, 1, 1, 129])))),
    box('mdat', new Uint8Array([1])))
}
export function mp4(width = 2, height = 3, codedWidth = width, codedHeight = height): Uint8Array {
  const tkhd = new Uint8Array(84), sample = new Uint8Array(78)
  const view = new DataView(tkhd.buffer)
  view.setUint32(76, width * 65536); view.setUint32(80, height * 65536)
  new DataView(sample.buffer).setUint16(24, codedWidth)
  new DataView(sample.buffer).setUint16(26, codedHeight)
  const stsd = box('stsd', uint32(0), uint32(1), box('avc1', sample))
  const mdia = box('mdia', box('hdlr', uint32(0), uint32(0), utf8('vide')),
    box('minf', box('stbl', stsd)))
  return concat(box('ftyp', utf8('isom'), uint32(0), utf8('mp42')),
    box('mdat', new Uint8Array([1])), box('moov', box('trak', box('tkhd', tkhd), mdia)))
}
function ebml(id: number[], data: Uint8Array): Uint8Array {
  if (data.length > 126) throw new Error('fixture element too long')
  return concat(new Uint8Array([...id, 128 | data.length]), data)
}
export function webm(width = 2, height = 3): Uint8Array {
  const video = ebml([0xe0], concat(ebml([0xb0], new Uint8Array([width])), ebml([0xba], new Uint8Array([height]))))
  const track = ebml([0xae], concat(ebml([0x83], new Uint8Array([1])), video))
  return concat(ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], utf8('webm'))),
    ebml([0x18, 0x53, 0x80, 0x67], ebml([0x16, 0x54, 0xae, 0x6b], track)))
}
export function webp(width = 2, height = 3): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14)
  const frame = new Uint8Array(6)
  frame[0] = 47
  new DataView(frame.buffer).setUint32(1, bits, true)
  const chunk = concat(utf8('VP8L'), new Uint8Array([5, 0, 0, 0]), frame)
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, chunk.length + 4, true)
  return concat(utf8('RIFF'), size, utf8('WEBP'), chunk)
}
export function jpeg(width = 2, height = 3): Uint8Array {
  return new Uint8Array([255, 216, 255, 192, 0, 11, 8, height >>> 8, height & 255,
    width >>> 8, width & 255, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217])
}

interface Node { stat: ContentStat; bytes?: Uint8Array; children?: ContentEntry[]; error?: GalleryDomainError }
export class MemoryReader implements ContentReader {
  readonly nodes = new Map<string, Node>()
  readonly reads: { ref: ContentRef; options: ReadOptions }[] = []
  readonly stats: ContentRef[] = []
  readonly listings: ContentRef[] = []
  closed = 0
  chunkSize = 7
  file(target: ContentRef, bytes: Uint8Array, knownSize = true): this {
    this.nodes.set(canonicalRef(target), { stat: { kind: 'file', ...(knownSize ? { size: BigInt(bytes.length) } : {}) }, bytes })
    return this
  }
  directory(target: ContentRef, children: ContentEntry[] = []): this {
    this.nodes.set(canonicalRef(target), { stat: { kind: 'directory' }, children })
    return this
  }
  error(target: ContentRef, code: 'NETWORK' | 'CANCELLED' = 'NETWORK'): this {
    this.nodes.set(canonicalRef(target), { stat: { kind: 'file' }, error: new GalleryDomainError({ code, message: 'fixture', retryable: true }) })
    return this
  }
  private node(target: ContentRef): Node {
    const node = this.nodes.get(canonicalRef(target))
    if (!node) throw new GalleryDomainError({ code: 'NOT_FOUND', message: 'fixture missing', retryable: false })
    if (node.error) throw node.error
    return node
  }
  async stat(target: ContentRef, signal: AbortSignal): Promise<ContentStat> {
    signal.throwIfAborted()
    this.stats.push(target)
    return this.node(target).stat
  }
  async *ls(target: ContentRef, signal: AbortSignal): AsyncIterable<ContentEntry> {
    this.listings.push(target)
    try {
      for (const entry of this.node(target).children ?? []) { signal.throwIfAborted(); yield entry }
    } finally { this.closed++ }
  }
  async *read(target: ContentRef, options: ReadOptions): AsyncIterable<Uint8Array> {
    this.reads.push({ ref: target, options })
    const bytes = this.node(target).bytes ?? new Uint8Array()
    const offset = options.offset ?? 0
    const end = Math.min(bytes.length, offset + (options.length ?? bytes.length))
    try {
      for (let index = offset; index < end; index += this.chunkSize) {
        options.signal.throwIfAborted()
        yield bytes.subarray(index, Math.min(end, index + this.chunkSize))
      }
    } finally { this.closed++ }
  }
}
export function entry(name: string, target: ContentRef, kind: ContentEntry['kind'] = 'file', size?: bigint): ContentEntry {
  return { name, ref: target, kind, ...(size === undefined ? {} : { size }) }
}
