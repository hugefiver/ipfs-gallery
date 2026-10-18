import { expect, it } from 'vitest'
import { inspectMedia } from '../../src/core/headers'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { createSwBoundaryPng } from './sw-gallery-media'

it.each([2, 4] as const)('the %i MiB PNG block passes the production media validator', mebibytes => {
  const bytes = createSwBoundaryPng(mebibytes)
  expect(bytes.byteLength).toBe(mebibytes * 1024 * 1024)
  expect(inspectMedia(bytes, DEFAULT_LIMITS)).toEqual({ kind: 'image', mime: 'image/png', width: 32, height: 24 })
})
