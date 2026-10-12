import type { ContentRef, VerifiedAsset } from '../shared/contracts'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { inspectMedia } from './headers'
import { fail } from './paths'
import { checkSignal, readBounded, rethrowCancellation } from './read'
import type { ContentReader, OperationOptions } from './types'

export async function readVerifiedAsset(
  ref: ContentRef,
  reader: ContentReader,
  options: OperationOptions,
): Promise<VerifiedAsset> {
  try {
    checkSignal(options.signal)
    const stat = await reader.stat(ref, options.signal)
    checkSignal(options.signal)
    if (stat.kind !== 'file') fail('UNSUPPORTED', '只能加载普通文件媒体。', ref)
    // Unknown lengths retain reader chunks plus a final exclusive buffer at assembly time.
    const maxBytes = Math.min(options.limits.maxAssetBytes, options.limits.maxAssetInputBytes,
      stat.size === undefined ? Math.floor(options.limits.maxAssemblyBytes / 2) : options.limits.maxAssemblyBytes)
    const bytes = await readBounded(reader, ref, { signal: options.signal, maxBytes }, {
      size: stat.size, ...(stat.size === undefined ? { maxRetainedBytes: maxBytes } : {}),
    })
    const header = inspectMedia(bytes, options.limits)
    checkSignal(options.signal)
    return { ...header, bytes: bytes.buffer, byteLength: bytes.byteLength }
  } catch (error) {
    rethrowCancellation(error, options.signal)
    throw new GalleryDomainError({ ...toGalleryError(error), ref })
  }
}
