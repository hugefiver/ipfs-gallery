import { describe, expect, it, vi } from 'vitest'
import { buildPolicyDefines, parseBuildPolicy } from '../../build/build-policy'
import { BUILD_POLICY, matchesBuildPolicy } from '../../src/shared/build-policy'
import { BUILTIN_DEFAULT_GATEWAYS } from '../../src/shared/build-policy-defaults'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

const gateway = 'https://gateway.net'
const withGateways = (values: unknown) => parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: JSON.stringify(values) })

describe('explicit build policy inputs', () => {
  it('defaults to strict verification and the built-in gateways only when missing', () => {
    expect(parseBuildPolicy({})).toEqual({ defaultGateways: BUILTIN_DEFAULT_GATEWAYS, trustless: true })
    expect(parseBuildPolicy({ IPFS_GALLERY_TRUSTLESS: 'true' }).trustless).toBe(true)
    expect(parseBuildPolicy({ IPFS_GALLERY_TRUSTLESS: 'false' }).trustless).toBe(false)
  })

  it('normalizes every entry and deduplicates in first-seen order', () => {
    expect(withGateways([' HTTPS://Gateway.NET:443/service/%E7%9B%B8%E5%86%8C/ ', 'https://other.net.', 'https://gateway.net/service/相册'])).toEqual({
      defaultGateways: ['https://gateway.net/service/%E7%9B%B8%E5%86%8C', 'https://other.net'], trustless: true,
    })
    expect(withGateways(Array<string>(DEFAULT_LIMITS.maxGateways).fill(gateway)).defaultGateways).toEqual([gateway])
    expect(() => withGateways(Array<string>(DEFAULT_LIMITS.maxGateways + 1).fill(gateway))).toThrow()
  })

  it.each(['', ' ', 'TRUE', 'False', ' true', 'false ', '0', '1', 'null', 'secret-value'])('rejects non-exact boolean input %#', input => {
    expect(() => parseBuildPolicy({ IPFS_GALLERY_TRUSTLESS: input })).toThrow(/IPFS_GALLERY_TRUSTLESS/)
  })

  it.each(['', ' ', '{bad', 'null', '{}', '"https://gateway.net"', '[]', '[1]', '[null]', '[true]', '[[]]'])('rejects invalid gateway JSON %#', input => {
    expect(() => parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: input })).toThrow(/IPFS_GALLERY_GATEWAYS/)
  })

  it.each([
    '', 'http://gateway.net', 'https://localhost', 'https://host.internal', 'https://127.0.0.1',
    'https://[::1]', 'https://user:secret@gateway.net', 'https://gateway.net?token=secret',
    'https://gateway.net/a/../b', 'https://gateway.net/a%2fb', 'https://gateway.net/%00',
  ])('rejects the entire list when one entry is unsafe %#', value => {
    expect(() => withGateways([gateway, value])).toThrow(/IPFS_GALLERY_GATEWAYS: entry 2/)
  })

  it('bounds both original and normalized gateway lengths', () => {
    const prefix = `${gateway}/`
    const exact = `${prefix}${'a'.repeat(4096 - prefix.length)}`
    expect(withGateways([exact]).defaultGateways).toEqual([exact])
    expect(() => withGateways([`${exact} `])).toThrow()
    expect(() => withGateways([`${prefix}${'中'.repeat(500)}`])).toThrow()
    const gateways = Array.from({ length: DEFAULT_LIMITS.maxGateways }, (_, index) => `${prefix}${index}${'a'.repeat(4096 - prefix.length - 1)}`)
    expect(withGateways(gateways).defaultGateways).toEqual(gateways)
  })

  it('checks the JSON byte budget before parsing and accepts its exact boundary', () => {
    const input = JSON.stringify([gateway]).padEnd(40 * 1024, ' ')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: `${input} ` })).toThrow()
      expect(() => parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: `"${'中'.repeat(14 * 1024)}"` })).toThrow()
      expect(parse).not.toHaveBeenCalled()
      expect(parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: input }).defaultGateways).toEqual([gateway])
    } finally {
      parse.mockRestore()
    }
  })

  it('never exposes input values or parser details in failures', () => {
    for (const environment of [
      { IPFS_GALLERY_TRUSTLESS: 'secret-value' },
      { IPFS_GALLERY_GATEWAYS: '["secret-value"' },
      { IPFS_GALLERY_GATEWAYS: JSON.stringify([gateway, 'https://user:secret-value@gateway.net']) },
    ]) {
      let failure: unknown
      try { parseBuildPolicy(environment) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain('secret-value')
    }
  })

  it('returns immutable policy snapshots and serializes the exact compilation values', () => {
    const policy = parseBuildPolicy({ IPFS_GALLERY_GATEWAYS: JSON.stringify([gateway]), IPFS_GALLERY_TRUSTLESS: 'false' })
    expect(Reflect.set(policy, 'trustless', true)).toBe(false)
    expect(Reflect.set(policy.defaultGateways, '0', 'https://other.net')).toBe(false)
    const definitions = buildPolicyDefines(policy)
    expect(JSON.parse(definitions.__IPFS_GALLERY_DEFAULT_GATEWAYS__!)).toEqual([gateway])
    expect(JSON.parse(definitions.__IPFS_GALLERY_TRUSTLESS__!)).toBe(false)
  })
})

describe('compiled policy identity', () => {
  it('exports the same immutable default list to existing callers', () => {
    expect(DEFAULT_GATEWAYS).toBe(BUILD_POLICY.defaultGateways)
    expect(Reflect.set(BUILD_POLICY, 'trustless', !BUILD_POLICY.trustless)).toBe(false)
    expect(Reflect.set(DEFAULT_GATEWAYS, '0', gateway)).toBe(false)
  })

  it('accepts only an exact compilation identity, without normalization or mode negotiation', () => {
    expect(matchesBuildPolicy(structuredClone(BUILD_POLICY))).toBe(true)
    for (const value of [
      undefined, null, [], {},
      { ...BUILD_POLICY, trustless: !BUILD_POLICY.trustless },
      { ...BUILD_POLICY, trustless: String(BUILD_POLICY.trustless) },
      { ...BUILD_POLICY, defaultGateways: [...DEFAULT_GATEWAYS].reverse() },
      { ...BUILD_POLICY, defaultGateways: DEFAULT_GATEWAYS.map(value => `${value}/`) },
      { ...BUILD_POLICY, defaultGateways: [...DEFAULT_GATEWAYS, gateway] },
      { ...BUILD_POLICY, runtimeOverride: true },
    ]) expect(matchesBuildPolicy(value)).toBe(false)
  })
})
