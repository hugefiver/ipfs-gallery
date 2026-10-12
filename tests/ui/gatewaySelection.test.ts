import { describe, expect, it } from 'vitest'
import { resolveGalleryGateways } from '../../src/hooks/useGallery'
import { parseLocation } from '../../src/core/query'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import type { ParsedLocation } from '../../src/shared/contracts'

const location: ParsedLocation = { view: { q: '', tags: [] }, gateways: [], notices: [] }

describe('URL gateway meaning and effective configuration', () => {
  it('uses URL over preference over defaults without changing the URL location', () => {
    const saved = ['https://saved.example/']
    expect(resolveGalleryGateways(location, [])).toEqual(DEFAULT_GATEWAYS)
    expect(resolveGalleryGateways(location, saved)).toEqual(saved)
    expect(location.gateways).toEqual([])
    const explicit = { ...location, gateways: ['https://shared.example/'] }
    expect(resolveGalleryGateways(explicit, saved)).toEqual(explicit.gateways)
    expect(resolveGalleryGateways(explicit, [])).toEqual(explicit.gateways)
  })
  it('rejects invalid explicit URL gateways instead of falling back to a preference', () => {
    expect(() => parseLocation('?gateway=http%3A%2F%2Flocalhost%2F')).toThrow()
  })
})
