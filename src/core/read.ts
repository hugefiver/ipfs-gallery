import type { ContentRef } from '../shared/contracts'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { fail } from './paths'
import type { ContentReader, ReadOptions } from './types'

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = toGalleryError(signal.reason)
    throw new GalleryDomainError(error.code === 'TIMEOUT' ? error
      : { code: 'CANCELLED', message: '操作已取消。', retryable: false })
  }
}

export function rethrowCancellation(error: unknown, signal: AbortSignal): void {
  checkSignal(signal)
  const mapped = toGalleryError(error)
  if (mapped.code === 'CANCELLED') throw new GalleryDomainError(mapped)
}

export async function readBounded(
  reader: ContentReader,
  ref: ContentRef,
  options: ReadOptions,
  assembly: { size?: bigint; onChunk?: (byteLength: number) => void; maxRetainedBytes?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { size, onChunk, maxRetainedBytes } = assembly
  checkSignal(options.signal)
  if (size !== undefined && (size < 0n || size > BigInt(options.maxBytes))) {
    fail('LIMIT', '内容超过读取字节限制。', ref)
  }
  const destination = size === undefined ? undefined : new Uint8Array(Number(size))
  const chunks: Uint8Array[] = []
  const retainedBuffers = new Set<ArrayBufferLike>()
  let retainedBytes = 0
  let total = 0
  for await (const chunk of reader.read(ref, options)) {
    checkSignal(options.signal)
    onChunk?.(chunk.byteLength)
    total += chunk.byteLength
    if (total > options.maxBytes) fail('LIMIT', '内容超过读取字节限制。', ref)
    if (destination && total > destination.byteLength) fail('INTEGRITY', '内容长度与已验证文件大小不一致。', ref)
    if (destination) destination.set(chunk, total - chunk.byteLength)
    else if (chunk.byteLength) {
      if (maxRetainedBytes !== undefined && !retainedBuffers.has(chunk.buffer)) {
        retainedBuffers.add(chunk.buffer)
        retainedBytes += chunk.buffer.byteLength
        if (retainedBytes > maxRetainedBytes) fail('LIMIT', '未知大小文件的组装空间超过限制。', ref)
      }
      chunks.push(chunk)
    }
  }
  checkSignal(options.signal)
  if (destination) {
    if (total !== destination.byteLength) fail('INTEGRITY', '内容长度与已验证文件大小不一致。', ref)
    return destination
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
