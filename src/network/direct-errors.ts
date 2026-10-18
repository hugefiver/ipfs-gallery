import { GalleryDomainError } from '../shared/errors'

export class DirectCleanupError extends GalleryDomainError {
  constructor() { super({ code: 'NETWORK', message: '传输清理失败，读取器已隔离。', retryable: false }) }
}
