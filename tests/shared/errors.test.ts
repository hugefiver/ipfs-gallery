import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { GalleryError } from '../../src/shared/contracts'
import { GalleryDomainError, toGalleryError } from '../../src/shared/errors'

describe('domain errors', () => {
  it('preserves structured error details for local rejection and Worker serialization', async () => {
    const cid = CID.createV1(0x55, await sha256.digest(new Uint8Array([1, 2, 3])))
    const detail: GalleryError = {
      code: 'INTEGRITY',
      message: '块校验失败。',
      retryable: true,
      ref: { cid: cid.toString(), path: [] },
      gateway: 'https://ipfs.io',
    }
    const exception = new GalleryDomainError(detail)

    expect(exception).toBeInstanceOf(Error)
    expect(toGalleryError(exception)).toBe(detail)
    expect(structuredClone(toGalleryError(exception))).toEqual(detail)
  })

  it('maps cancellation without treating it as a retryable failure', () => {
    const error = toGalleryError(new DOMException('aborted', 'AbortError'))
    expect(error.code).toBe('CANCELLED')
    expect(error.retryable).toBe(false)
  })

  it('maps a timed-out operation to a retryable timeout', () => {
    const error = toGalleryError(new DOMException('timed out', 'TimeoutError'))
    expect(error.code).toBe('TIMEOUT')
    expect(error.retryable).toBe(true)
  })

  it('does not disclose arbitrary error objects across the protocol boundary', () => {
    const unknown = new Error('private implementation details')
    Object.assign(unknown, { credentials: 'not for serialization' })
    const error = toGalleryError(unknown)

    expect(error.code).toBe('INTERNAL')
    expect(error.retryable).toBe(false)
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'retryable'])
    expect(error.message).not.toBe(unknown.message)
  })
})
