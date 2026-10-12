import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  const checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  checksum.writeUInt32BE(crc32(payload))
  return Buffer.concat([length, payload, checksum])
}

/** A complete RGB PNG with deterministic pixels, valid zlib and PNG CRCs. */
export function createPng(width: number, height: number, seed: number): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const scanlines = Buffer.alloc(height * (1 + width * 3))
  let state = seed >>> 0
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    scanlines[row] = 0
    for (let x = 0; x < width * 3; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      scanlines[row + x + 1] = state >>> 24
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', new Uint8Array()),
  ]))
}

/** Complete PNG structure with a CRC-valid unknown critical chunk rejected by native decoders. */
export function createUndecodablePng(width: number, height: number, seed: number): Uint8Array {
  const png = createPng(width, height, seed)
  return new Uint8Array(Buffer.concat([png.subarray(0, 33), pngChunk('ABCD', new Uint8Array()), png.subarray(33)]))
}

export const IMAGE_SIZE = { width: 32, height: 24 } as const
export const MULTIBLOCK_IMAGE_SIZE = { width: 96, height: 64 } as const

export async function fixtureMedia() {
  return {
    amber: createPng(IMAGE_SIZE.width, IMAGE_SIZE.height, 1),
    blue: createPng(IMAGE_SIZE.width, IMAGE_SIZE.height, 2),
    large: createPng(MULTIBLOCK_IMAGE_SIZE.width, MULTIBLOCK_IMAGE_SIZE.height, 3),
    video: new Uint8Array(await readFile(new URL('./tiny.webm', import.meta.url))),
  }
}
