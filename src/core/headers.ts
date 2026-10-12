import type { ResourceLimits } from '../shared/contracts'
import { fail } from './paths'

export interface MediaHeader {
  mime: string
  kind: 'image' | 'video'
  width: number
  height: number
}

const MAX_HEADER_NODES = 10000
const JPEG_FRAME_MARKERS = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207])
const png = [137, 80, 78, 71, 13, 10, 26, 10]
function matches(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
function need(bytes: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) malformed()
}
function malformed(): never { return fail('UNSUPPORTED', '媒体头损坏或无法安全识别尺寸。') }
function u16(bytes: Uint8Array, offset: number, little = false): number {
  need(bytes, offset, 2)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, little)
}
function u32(bytes: Uint8Array, offset: number, little = false): number {
  need(bytes, offset, 4)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little)
}
function u24(bytes: Uint8Array, offset: number): number {
  need(bytes, offset, 3)
  return bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16)
}

export function sniffMedia(bytes: Uint8Array): Pick<MediaHeader, 'mime' | 'kind'> | undefined {
  if (matches(bytes, png)) return { mime: 'image/png', kind: 'image' }
  if (matches(bytes, [255, 216, 255])) return { mime: 'image/jpeg', kind: 'image' }
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return { mime: 'image/gif', kind: 'image' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { mime: 'image/webp', kind: 'image' }
  if (matches(bytes, [26, 69, 223, 163])) return { mime: 'video/webm', kind: 'video' }
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === 'ftyp') {
    const size = u32(bytes, 0)
    if (size < 16 || size > 4096 || size > bytes.length || (size - 16) % 4) return undefined
    const brands = [ascii(bytes, 8, 4)]
    for (let offset = 16; offset < size; offset += 4) brands.push(ascii(bytes, offset, 4))
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return { mime: 'image/avif', kind: 'image' }
    if (brands.some((brand) => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/u.test(brand))) {
      return { mime: 'video/mp4', kind: 'video' }
    }
  }
  return undefined
}

function dimensions(width: number, height: number, limits: ResourceLimits): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) malformed()
  if (width > limits.maxMediaDimension || height > limits.maxMediaDimension
    || width * height > limits.maxImagePixels) fail('LIMIT', '媒体尺寸超过安全限制。')
}

function jpegDimensions(bytes: Uint8Array): [number, number] {
  if (!matches(bytes, [255, 216]) || !matches(bytes, [255, 217], bytes.length - 2)) malformed()
  let offset = 2
  for (let nodes = 0; nodes < MAX_HEADER_NODES && offset < bytes.length; nodes++) {
    if (bytes[offset++] !== 255) malformed()
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 218) malformed()
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    const length = u16(bytes, offset)
    if (length < 2) malformed()
    need(bytes, offset, length)
    if (JPEG_FRAME_MARKERS.has(marker)) {
      const components = bytes[offset + 7] ?? 0
      if (length < 8 || components < 1 || components > 4
        || length !== 8 + 3 * components || bytes[offset + 2] !== 8) malformed()
      return [u16(bytes, offset + 5), u16(bytes, offset + 3)]
    }
    offset += length
  }
  return malformed()
}

function pngDimensions(bytes: Uint8Array, limits: ResourceLimits): [number, number] {
  need(bytes, 0, 33)
  if (u32(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') malformed()
  const depth = bytes[24]!
  const color = bytes[25]!
  const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!validDepths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) malformed()
  const width = u32(bytes, 16), height = u32(bytes, 20)
  dimensions(width, height, limits)
  let offset = 33
  let hasData = false
  for (let nodes = 0; nodes < MAX_HEADER_NODES && offset < bytes.length; nodes++) {
    const size = u32(bytes, offset)
    need(bytes, offset, size + 12)
    const tag = ascii(bytes, offset + 4, 4)
    if (tag === 'IHDR') malformed()
    if (tag === 'IDAT') hasData = true
    if (tag === 'fcTL') {
      if (size !== 26) malformed()
      const w = u32(bytes, offset + 12), h = u32(bytes, offset + 16)
      dimensions(w, h, limits)
      if (u32(bytes, offset + 20) + w > width || u32(bytes, offset + 24) + h > height) malformed()
    }
    offset += size + 12
    if (tag === 'IEND') {
      if (size !== 0 || !hasData || offset !== bytes.length) malformed()
      return [width, height]
    }
  }
  return malformed()
}

function gifDimensions(bytes: Uint8Array): [number, number] {
  need(bytes, 0, 13)
  const width = u16(bytes, 6, true), height = u16(bytes, 8, true)
  let offset = 13
  if (bytes[10]! & 128) offset += 3 * (1 << ((bytes[10]! & 7) + 1))
  let nodes = 0, frames = 0
  function subBlocks(): void {
    for (;;) {
      if (++nodes > MAX_HEADER_NODES) malformed()
      need(bytes, offset, 1)
      const size = bytes[offset++]!
      need(bytes, offset, size)
      offset += size
      if (!size) return
    }
  }
  while (++nodes <= MAX_HEADER_NODES) {
    need(bytes, offset, 1)
    const tag = bytes[offset++]!
    if (tag === 59) {
      if (!frames || offset !== bytes.length) malformed()
      return [width, height]
    }
    if (tag === 33) { need(bytes, offset++, 1); subBlocks(); continue }
    if (tag !== 44) malformed()
    need(bytes, offset, 9)
    const x = u16(bytes, offset, true), y = u16(bytes, offset + 2, true)
    const w = u16(bytes, offset + 4, true), h = u16(bytes, offset + 6, true)
    if (!w || !h || x + w > width || y + h > height) malformed()
    const flags = bytes[offset + 8]!
    offset += 9
    if (flags & 128) offset += 3 * (1 << ((flags & 7) + 1))
    need(bytes, offset, 1)
    const codeSize = bytes[offset++]!
    if (codeSize < 2 || codeSize > 8) malformed()
    subBlocks()
    frames++
  }
  return malformed()
}

function webpFrame(bytes: Uint8Array, start: number, size: number, type: string): [number, number] {
  if (type === 'VP8 ') {
    if (size < 10 || (bytes[start]! & 1) || !matches(bytes, [157, 1, 42], start + 3)) malformed()
    return [u16(bytes, start + 6, true) & 16383, u16(bytes, start + 8, true) & 16383]
  }
  if (size < 5 || bytes[start] !== 47 || (bytes[start + 4]! & 224)) malformed()
  const bits = u32(bytes, start + 1, true)
  return [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1]
}

function webpDimensions(bytes: Uint8Array, limits: ResourceLimits): [number, number] {
  if (u32(bytes, 4, true) + 8 !== bytes.length) malformed()
  let offset = 12, canvas: [number, number] | undefined, frames = 0
  for (let nodes = 0; nodes < MAX_HEADER_NODES && offset < bytes.length; nodes++) {
    need(bytes, offset, 8)
    const type = ascii(bytes, offset, 4), size = u32(bytes, offset + 4, true), start = offset + 8
    need(bytes, start, size + (size & 1))
    if (type === 'VP8X') {
      if (offset !== 12 || size !== 10 || (bytes[start]! & 193)
        || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) malformed()
      canvas = [u24(bytes, start + 4) + 1, u24(bytes, start + 7) + 1]
      dimensions(...canvas, limits)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      const frame = webpFrame(bytes, start, size, type)
      dimensions(...frame, limits)
      if (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1])) malformed()
      canvas ??= frame
      frames++
    } else if (type === 'ANMF') {
      if (!canvas || size < 24) malformed()
      const x = u24(bytes, start) * 2, y = u24(bytes, start + 3) * 2
      const w = u24(bytes, start + 6) + 1, h = u24(bytes, start + 9) + 1
      if (x + w > canvas[0] || y + h > canvas[1]) malformed()
      let frameOffset = start + 16, found = false
      while (frameOffset < start + size) {
        if (++nodes > MAX_HEADER_NODES) malformed()
        need(bytes, frameOffset, 8)
        const frameType = ascii(bytes, frameOffset, 4), frameSize = u32(bytes, frameOffset + 4, true)
        if (frameOffset + 8 + frameSize + (frameSize & 1) > start + size) malformed()
        if (frameType === 'VP8 ' || frameType === 'VP8L') {
          const frame = webpFrame(bytes, frameOffset + 8, frameSize, frameType)
          if (frame[0] !== w || frame[1] !== h) malformed()
          found = true
        }
        frameOffset += 8 + frameSize + (frameSize & 1)
      }
      if (!found) malformed()
      frames++
    }
    offset = start + size + (size & 1)
  }
  if (offset !== bytes.length || !canvas || !frames) malformed()
  return canvas
}

interface Box { type: string; start: number; end: number }
function isoParser(bytes: Uint8Array): (start: number, end: number) => Box[] {
  let count = 0
  return (start, end) => {
    const boxes: Box[] = []
    while (start < end) {
      if (++count > MAX_HEADER_NODES || end - start < 8) malformed()
      let size = u32(bytes, start), header = 8
      if (size === 1) {
        need(bytes, start, 16)
        const big = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(start + 8)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) malformed()
        size = Number(big); header = 16
      } else if (size === 0) size = end - start
      if (size < header || start + size > end) malformed()
      boxes.push({ type: ascii(bytes, start + 4, 4), start: start + header, end: start + size })
      start += size
    }
    return boxes
  }
}

function avifDimensions(bytes: Uint8Array, limits: ResourceLimits): [number, number] {
  const boxes = isoParser(bytes)
  const meta = boxes(0, bytes.length).find((box) => box.type === 'meta')
  if (!meta || meta.end - meta.start < 4 || u32(bytes, meta.start) !== 0) malformed()
  const children = boxes(meta.start + 4, meta.end)
  const pitm = children.find((box) => box.type === 'pitm')
  const iprp = children.find((box) => box.type === 'iprp')
  if (!pitm || !iprp) malformed()
  need(bytes, pitm.start, 6)
  const version = bytes[pitm.start]
  if (version !== 0 && version !== 1) malformed()
  if (pitm.end - pitm.start !== (version === 0 ? 6 : 8)) malformed()
  const primary = version === 0 ? u16(bytes, pitm.start + 4) : u32(bytes, pitm.start + 4)
  const properties = boxes(iprp.start, iprp.end)
  const ipco = properties.find((box) => box.type === 'ipco')
  if (!ipco) malformed()
  const dimensionsByIndex = new Map<number, [number, number]>()
  const propertyBoxes = boxes(ipco.start, ipco.end)
  propertyBoxes.forEach((box, index) => {
    if (box.type !== 'ispe') return
    if (box.end - box.start !== 12 || u32(bytes, box.start) !== 0) malformed()
    const size: [number, number] = [u32(bytes, box.start + 4), u32(bytes, box.start + 8)]
    dimensions(...size, limits)
    dimensionsByIndex.set(index + 1, size)
  })
  let result: [number, number] | undefined
  for (const box of properties.filter((child) => child.type === 'ipma')) {
    need(bytes, box.start, 8)
    const version = bytes[box.start]!, flags = u32(bytes, box.start) & 0xffffff
    if (version > 1 || flags > 1) malformed()
    let offset = box.start + 8
    const entries = u32(bytes, box.start + 4)
    if (entries > MAX_HEADER_NODES) malformed()
    for (let entry = 0; entry < entries; entry++) {
      const id = version === 0 ? u16(bytes, offset) : u32(bytes, offset)
      offset += version === 0 ? 2 : 4
      need(bytes, offset, 1)
      const count = bytes[offset++]!
      for (let property = 0; property < count; property++) {
        need(bytes, offset, flags ? 2 : 1)
        const index = flags ? u16(bytes, offset) & 32767 : bytes[offset]! & 127
        if (index > propertyBoxes.length) malformed()
        offset += flags ? 2 : 1
        const size = dimensionsByIndex.get(index)
        if (id === primary && size) {
          if (result && (result[0] !== size[0] || result[1] !== size[1])) malformed()
          result = size
        }
      }
    }
    if (offset !== box.end) malformed()
  }
  if (!result) malformed()
  return result
}

function mp4Dimensions(bytes: Uint8Array, limits: ResourceLimits): [number, number] {
  const boxes = isoParser(bytes)
  const moov = boxes(0, bytes.length).find((box) => box.type === 'moov')
  if (!moov) malformed()
  const videos: [number, number][] = []
  for (const track of boxes(moov.start, moov.end).filter((box) => box.type === 'trak')) {
    const children = boxes(track.start, track.end)
    const mdia = children.find((box) => box.type === 'mdia')
    if (!mdia) malformed()
    const media = boxes(mdia.start, mdia.end)
    const handler = media.find((box) => box.type === 'hdlr')
    if (!handler || handler.end - handler.start < 12) malformed()
    if (ascii(bytes, handler.start + 8, 4) !== 'vide') continue
    const tkhd = children.find((box) => box.type === 'tkhd')
    if (!tkhd) malformed()
    const version = bytes[tkhd.start]
    if (version !== 0 && version !== 1) malformed()
    const offset = tkhd.start + (version === 0 ? 76 : 88)
    if (offset + 8 > tkhd.end) malformed()
    const width = u32(bytes, offset) / 65536, height = u32(bytes, offset + 4) / 65536
    dimensions(width, height, limits)
    const minf = media.find((box) => box.type === 'minf')
    if (!minf) malformed()
    const stbl = boxes(minf.start, minf.end).find((box) => box.type === 'stbl')
    if (!stbl) malformed()
    const stsd = boxes(stbl.start, stbl.end).find((box) => box.type === 'stsd')
    if (!stsd || stsd.end - stsd.start < 8 || u32(bytes, stsd.start) !== 0) malformed()
    const samples = boxes(stsd.start + 8, stsd.end)
    if (!samples.length || samples.length !== u32(bytes, stsd.start + 4)) malformed()
    for (const sample of samples) {
      if (!['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'vp08', 'mp4v'].includes(sample.type)
        || sample.end - sample.start < 78) malformed()
      dimensions(u16(bytes, sample.start + 24), u16(bytes, sample.start + 26), limits)
    }
    videos.push([width, height])
  }
  if (!videos.length) malformed()
  const size: [number, number] = [Math.max(...videos.map(([w]) => w)), Math.max(...videos.map(([, h]) => h))]
  dimensions(...size, limits)
  return size
}

interface Ebml { id: number; start: number; end: number }
function webmDimensions(bytes: Uint8Array, limits: ResourceLimits): [number, number] {
  let nodes = 0
  function vint(offset: number, id = false): { value: number; length: number; unknown: boolean } {
    need(bytes, offset, 1)
    const first = bytes[offset]!
    let length = 1, mask = 128
    while (mask && !(first & mask)) { mask >>= 1; length++ }
    if (!mask || length > (id ? 4 : 8)) malformed()
    need(bytes, offset, length)
    let value = BigInt(id ? first : first & (mask - 1))
    for (let i = 1; i < length; i++) value = (value << 8n) + BigInt(bytes[offset + i]!)
    const unknown = !id && value === (1n << BigInt(7 * length)) - 1n
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) malformed()
    return { value: unknown ? 0 : Number(value), length, unknown }
  }
  function elements(start: number, end: number): Ebml[] {
    const result: Ebml[] = []
    while (start < end) {
      if (++nodes > MAX_HEADER_NODES) malformed()
      const id = vint(start, true)
      const size = vint(start + id.length)
      const payload = start + id.length + size.length
      if (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675) malformed()
      const finish = size.unknown ? end : payload + size.value
      if (finish > end) malformed()
      result.push({ id: id.value, start: payload, end: finish })
      start = finish
    }
    return result
  }
  function integer(element: Ebml | undefined): number {
    if (!element || element.end === element.start || element.end - element.start > 8) malformed()
    let value = 0n
    for (let i = element.start; i < element.end; i++) value = (value << 8n) + BigInt(bytes[i]!)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) malformed()
    return Number(value)
  }
  const root = elements(0, bytes.length)
  const header = root.find((element) => element.id === 0x1a45dfa3)
  const segment = root.find((element) => element.id === 0x18538067)
  if (!header || !segment) malformed()
  const docType = elements(header.start, header.end).find((element) => element.id === 0x4282)
  if (!docType || docType.end - docType.start !== 4 || ascii(bytes, docType.start, 4) !== 'webm') malformed()
  const tracks = elements(segment.start, segment.end).find((element) => element.id === 0x1654ae6b)
  if (!tracks) malformed()
  const sizes: [number, number][] = []
  for (const track of elements(tracks.start, tracks.end).filter((element) => element.id === 0xae)) {
    const fields = elements(track.start, track.end)
    if (integer(fields.find((element) => element.id === 0x83)) !== 1) continue
    const video = fields.find((element) => element.id === 0xe0)
    if (!video) malformed()
    const values = elements(video.start, video.end)
    const width = integer(values.find((element) => element.id === 0xb0))
    const height = integer(values.find((element) => element.id === 0xba))
    dimensions(width, height, limits)
    const displayWidth = values.find((element) => element.id === 0x54b0)
    const displayHeight = values.find((element) => element.id === 0x54ba)
    if ((displayWidth === undefined) !== (displayHeight === undefined)) malformed()
    if (displayWidth && displayHeight) dimensions(integer(displayWidth), integer(displayHeight), limits)
    sizes.push([width, height])
  }
  if (!sizes.length) malformed()
  return [Math.max(...sizes.map(([w]) => w)), Math.max(...sizes.map(([, h]) => h))]
}

export function inspectMedia(bytes: Uint8Array, limits: ResourceLimits): MediaHeader {
  const type = sniffMedia(bytes)
  if (!type) fail('UNSUPPORTED', '不支持此媒体格式；HTML、SVG 与未知内容不能加载。')
  let size: [number, number]
  switch (type.mime) {
    case 'image/jpeg': size = jpegDimensions(bytes); break
    case 'image/png': size = pngDimensions(bytes, limits); break
    case 'image/gif': size = gifDimensions(bytes); break
    case 'image/webp': size = webpDimensions(bytes, limits); break
    case 'image/avif': size = avifDimensions(bytes, limits); break
    case 'video/mp4': size = mp4Dimensions(bytes, limits); break
    case 'video/webm': size = webmDimensions(bytes, limits); break
    default: return malformed()
  }
  dimensions(...size, limits)
  return { ...type, width: size[0], height: size[1] }
}
