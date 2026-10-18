import { createPng } from '../fixtures/media'

/** An exact-size PNG with a CRC-valid ancillary chunk and terminal IEND. */
export function createSwBoundaryPng(mebibytes: 2 | 4): Uint8Array {
  const png = createPng(32, 24, 173)
  const dataLength = mebibytes * 1024 * 1024 - png.byteLength - 12
  const chunk = Buffer.alloc(dataLength + 12)
  chunk.writeUInt32BE(dataLength, 0)
  chunk.write('raNd', 4, 'ascii')
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return new Uint8Array(Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]))
}
