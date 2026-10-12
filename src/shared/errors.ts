import type { GalleryError } from './contracts'

export class GalleryDomainError extends Error {
  readonly error: GalleryError

  constructor(error: GalleryError) {
    super(error.message)
    this.name = 'GalleryDomainError'
    this.error = error
  }
}

export function toGalleryError(value: unknown): GalleryError {
  if (value instanceof GalleryDomainError) return value.error
  if (value instanceof Error && value.name === 'AbortError') {
    return { code: 'CANCELLED', message: '操作已取消。', retryable: false }
  }
  if (value instanceof Error && value.name === 'TimeoutError') {
    return { code: 'TIMEOUT', message: '读取超时，请重试。', retryable: true }
  }
  return { code: 'INTERNAL', message: '发生内部错误。', retryable: false }
}
