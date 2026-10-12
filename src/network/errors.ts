import type { ErrorCode } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'

export function networkError(code: ErrorCode, message: string, gateway?: string): GalleryDomainError {
  return new GalleryDomainError({
    code,
    message,
    retryable: ['NETWORK', 'TIMEOUT', 'INTEGRITY', 'NOT_FOUND'].includes(code),
    ...(gateway === undefined ? {} : { gateway }),
  })
}

export function cancellationError(reason: unknown, gateway?: string): GalleryDomainError {
  if (reason instanceof GalleryDomainError) return reason
  return reason instanceof Error && reason.name === 'TimeoutError'
    ? networkError('TIMEOUT', '读取期限已到。', gateway)
    : networkError('CANCELLED', '读取已取消。', gateway)
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal.reason)
}

export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      try {
        checkSignal(signal)
      } catch (error) {
        reject(error)
      }
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error) },
    )
    if (signal.aborted) onAbort()
  })
}
