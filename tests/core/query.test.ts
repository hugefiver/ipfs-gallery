import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { base58btc } from 'multiformats/bases/base58'
import { base32upper } from 'multiformats/bases/base32'
import { base16 } from 'multiformats/bases/base16'
import { create as digest } from 'multiformats/hashes/digest'
import { normalizeContentRef, parseLocation, serializeLocation } from '../../src/core/query'
import { canonicalRef } from '../../src/core/paths'
import { ROOT, OTHER, THIRD, ref } from './fixtures'

describe('content references and location boundary', () => {
  it('canonicalizes CID bases without lowercasing the CID before parsing', () => {
    const v0 = CID.createV0(digest(0x12, CID.parse(ROOT).multihash.digest)).toString()
    const b58 = CID.parse(ROOT).toString(base58btc)
    expect(normalizeContentRef(v0).cid).toBe(CID.parse(v0).toV1().toString())
    expect(normalizeContentRef(b58).cid).toBe(ROOT)
    expect(normalizeContentRef(CID.parse(ROOT).toString(base32upper)).cid).toBe(ROOT)
    expect(normalizeContentRef(CID.parse(ROOT).toString(base16)).cid).toBe(ROOT)
    expect(() => normalizeContentRef(v0.toLowerCase())).toThrow()
    expect(normalizeContentRef(`https://user:password@discard.invalid/ipfs/${ROOT}/file.png?q=ignored#ignored`)).toEqual(ref(ROOT, 'file.png'))
  })
  it('treats bare paths literally and decodes URI segments exactly once', () => {
    expect(normalizeContentRef(`${ROOT}/a%20b+?.png`)).toEqual(ref(ROOT, 'a%20b+?.png'))
    expect(normalizeContentRef(`${ROOT}/ leading and trailing `)).toEqual(ref(ROOT, ' leading and trailing '))
    expect(normalizeContentRef(`https://gateway.tld/ipfs/%62${ROOT.slice(1)}/a`)).toEqual(ref(ROOT, 'a'))
    expect(normalizeContentRef(`ipfs://${ROOT}/a%252Fb%20%2B%3F%23%2C`)).toEqual(ref(ROOT, 'a%2Fb +?#,'))
    const input = parseLocation(`?cid=${encodeURIComponent(`ipfs://${ROOT}/a%252Fb%20%2B%3F%23%2C`)}`)
    expect(parseLocation(serializeLocation(input))).toEqual(input)
  })
  it('roundtrips maximum-safe Unicode paths and stable viewer IDs without recursive decoding', () => {
    const value = ref(ROOT, ...Array<string>(16).fill('花'.repeat(200)))
    const location = parseLocation(`?cid=${encodeURIComponent(canonicalRef(value))}`)
    location.view.item = JSON.stringify([canonicalRef(value), 1, canonicalRef(value)])
    expect(parseLocation(serializeLocation(location))).toEqual(location)
  })
  it('preserves ordered expansion, deduplication, filters, and comma-bearing paths', () => {
    const location = parseLocation(`?cid=${ROOT}&cids=${OTHER},${ROOT}&cid=${THIRD}&cid=${encodeURIComponent(`${ROOT}/a,b`)}&q=%E8%8A%B1&tag=red&tag=warm&type=image&item=test`)
    expect(location.input?.source).toEqual({ kind: 'cids', refs: [ref(ROOT), ref(OTHER), ref(THIRD), ref(ROOT, 'a,b')], browse: false })
    const serialized = serializeLocation(location)
    expect(new URLSearchParams(serialized).has('cids')).toBe(false)
    expect(parseLocation(serialized)).toEqual(location)
  })
  it('honors source precedence without interpreting or adopting overridden references', () => {
    const meta = parseLocation(`?cid=bad&unixfs=also-bad&meta=${ROOT}&browse=1`)
    expect(meta.input?.source).toEqual({ kind: 'manifest', ref: ref(ROOT) })
    expect(meta.notices.length).toBe(1)
    expect(meta.gateways).toEqual([])
    expect(parseLocation(`?cids=bad&unixfs=${ROOT}&browse=1`).input?.source).toEqual({ kind: 'unixfs', ref: ref(ROOT), browse: true })
  })
  it('keeps an honest empty location and validates programmatic serialization', () => {
    expect(parseLocation('')).toEqual({ view: { q: '', tags: [] }, gateways: [], notices: [] })
    expect(serializeLocation(parseLocation(''))).toBe('')
    expect(() => serializeLocation({ ...parseLocation(''), view: { q: 'x'.repeat(201), tags: [] } })).toThrow()
  })
  it.each([
    `ipfs://${ROOT}/a%2Fb`, `https://gateway.tld/ipfs/${ROOT}/a%5Cb`,
    `ipfs://${ROOT}/%00`, `ipfs://${ROOT}/%ZZ`, `${ROOT}/a//b`, `${ROOT}/..`,
    `${ROOT}/a\\b`, `${ROOT}/${'x'.repeat(256)}`, `${ROOT}/${Array(65).fill('x').join('/')}`,
    `ipns://${ROOT}`, `https://gateway.tld/file.png`, `data:image/png;base64,abc`,
  ])('rejects unsafe reference %s', (value) => { expect(() => normalizeContentRef(value)).toThrow() })
  it.each([
    `?cid=${ROOT}&cid=invalid`, `?cids=${ROOT},`, `?meta=${ROOT}&meta=${OTHER}`,
    `?unixfs=${ROOT}&unixfs=${OTHER}`, `?browse=0`, '?browse=1&browse=1', '?type=audio',
    `?q=${'x'.repeat(201)}`, '?tag=',
  ])('rejects invalid query %s', (value) => { expect(() => parseLocation(value)).toThrow() })
  it('bounds roots and uses canonical references for deduplication', () => {
    expect(() => parseLocation(`?${Array.from({ length: 101 }, (_, index) => `cid=${ROOT}/p${index}`).join('&')}`)).toThrow()
    expect(parseLocation(`?cid=${ROOT}&cid=${canonicalRef(ref(ROOT))}`).input?.source).toEqual({ kind: 'cids', refs: [ref(ROOT)], browse: false })
    expect(parseLocation(`?cids=%20${ROOT}%20,%20${OTHER}%20`).input?.source).toEqual({ kind: 'cids', refs: [ref(ROOT), ref(OTHER)], browse: false })
  })
  it('normalizes valid public gateway prefixes and refuses unsafe gateway configuration', () => {
    expect(parseLocation('?gateway=https%3A%2F%2FGateway.tld%3A443%2Fprefix%2F').gateways).toEqual(['https://gateway.tld/prefix'])
    for (const value of ['http://gateway.tld', 'https://localhost', 'https://127.1', 'https://10.0.0.1',
      'https://[::1]', 'https://user:pass@gateway.tld', 'https://gateway.tld/?x=1',
      'https://gateway.tld/#', 'https://gateway.tld/a/../b', 'https://gateway.tld/a%2fb']) {
      expect(() => parseLocation(`?gateway=${encodeURIComponent(value)}`)).toThrow()
    }
  })
})
