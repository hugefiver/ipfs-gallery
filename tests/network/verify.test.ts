import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import * as digest from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { normalizeGateway } from '../../src/network/broker'
import { parseBlockCid, verifyBlock } from '../../src/network/verify'

describe('gateway configuration boundary', () => {
  it('canonicalizes HTTPS public domains and encoded path prefixes', () => {
    expect(normalizeGateway('  HTTPS://Gateway.NET:443/service/%E7%9B%B8%E5%86%8C/  ')).toBe('https://gateway.net/service/%E7%9B%B8%E5%86%8C')
    expect(normalizeGateway('https://gateway.net.:8443')).toBe('https://gateway.net:8443')
  })

  it.each([
    'http://gateway.net', 'https://user:pass@gateway.net', 'https://gateway.net?a=1',
    'https://gateway.net#x', 'https://gateway.net?', 'https://gateway.net#',
    'https://localhost', 'https://a.localhost', 'https://host.local', 'https://host.internal',
    'https://a.localdomain', 'https://host.home.arpa', 'https://host.alt', 'https://@gateway.net', 'https:gateway.net/prefix',
    'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.169.254', 'https://8.8.8.8',
    'https://2130706433', 'https://[::1]', 'https://[fe80::1]', 'https://[fc00::1]',
    'https://gateway.net/../admin', 'https://gateway.net/%2e%2e/admin', 'https://gateway.net/a%2fb',
    'https://gateway.net/a%5cb', 'https://gateway.net/%00', 'https://gateway.net/a//b',
    'https://gateway.net/%not-valid', 'https://gateway.net\\private',
  ])('rejects unsafe gateway %s', (value) => {
    expect(() => normalizeGateway(value)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_INPUT' }) }))
  })
})

describe('CID integrity boundary', () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 254, 255])
  it.each([sha256, sha512, identity])('checks complete %s digest bytes', async (hasher) => {
    const cid = CID.createV1(0x55, await hasher.digest(bytes))
    await expect(verifyBlock(cid, bytes, 100)).resolves.toBeUndefined()
    await expect(verifyBlock(cid, bytes.subarray(1), 100)).rejects.toMatchObject({ error: { code: 'INTEGRITY' } })
  })

  it('accepts CIDv0 dag-pb but rejects unsupported codecs, hashes and truncation', async () => {
    const hash = await sha256.digest(bytes)
    expect(parseBlockCid(CID.createV0(hash).toString(), 100).code).toBe(0x70)
    for (const cid of [
      CID.createV1(0x71, hash),
      CID.createV1(0x55, digest.create(0x99, hash.digest)),
      CID.createV1(0x55, digest.create(sha256.code, hash.digest.subarray(0, 16))),
    ]) expect(() => parseBlockCid(cid.toString(), 100)).toThrow(expect.objectContaining({ error: { code: 'UNSUPPORTED', message: expect.any(String), retryable: false } }))
  })

  it('bounds both fetched blocks and identity payloads before use', async () => {
    const cid = CID.createV1(0x55, identity.digest(bytes))
    expect(() => parseBlockCid(cid.toString(), 5)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'LIMIT' }) }))
    const hashCid = CID.createV1(0x55, await sha256.digest(bytes))
    await expect(verifyBlock(hashCid, bytes, 5)).rejects.toMatchObject({ error: { code: 'LIMIT' } })
  })
})
