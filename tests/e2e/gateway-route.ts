import type { ContentRef } from '../../src/shared/contracts'
import { contentUri } from '../fixtures/unixfs'

export const FIXTURE_GATEWAYS = {
  slow: 'https://slow.gallery-fixture.net',
  fast: 'https://fast.gallery-fixture.net',
} as const

export function sourceUrl(
  source: 'unixfs' | 'meta' | 'cid',
  refs: ContentRef | ContentRef[],
  view: Record<string, string | string[]> = {},
  gateways: string[] = [FIXTURE_GATEWAYS.slow, FIXTURE_GATEWAYS.fast],
): string {
  const query = new URLSearchParams()
  for (const ref of Array.isArray(refs) ? refs : [refs]) query.append(source, contentUri(ref))
  for (const gateway of gateways) query.append('gateway', gateway)
  for (const [key, values] of Object.entries(view)) {
    for (const value of Array.isArray(values) ? values : [values]) query.append(key, value)
  }
  return `/?${query}`
}
