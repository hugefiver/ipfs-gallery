import { CID } from 'multiformats/cid'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { networkError } from './errors'

export function parseBlockCid(value: string, maxBlockBytes: number): CID {
  if (value.length > maxBlockBytes * 2 + 256) throw networkError('LIMIT', 'CID 内嵌数据超过块上限。')
  let cid: CID
  try { cid = CID.parse(value) } catch { throw networkError('INVALID_INPUT', 'CID 格式无效。') }
  if (cid.code !== 0x55 && cid.code !== 0x70) throw networkError('UNSUPPORTED', `不支持 CID codec ${cid.code}。`)
  const hash = cid.multihash
  if (hash.code !== 0 && hash.code !== sha256.code && hash.code !== sha512.code) {
    throw networkError('UNSUPPORTED', `不支持 multihash ${hash.code}。`)
  }
  if (hash.code === 0 && hash.size > maxBlockBytes) throw networkError('LIMIT', 'CID 内嵌数据超过块上限。')
  if ((hash.code === sha256.code && hash.size !== 32) || (hash.code === sha512.code && hash.size !== 64)) {
    throw networkError('UNSUPPORTED', '不支持截断的 SHA2 multihash。')
  }
  return cid
}

export async function verifyBlock(cid: CID, bytes: Uint8Array, maxBlockBytes: number): Promise<void> {
  if (bytes.byteLength > maxBlockBytes) throw networkError('LIMIT', '原始块超过字节上限。')
  const supported = parseBlockCid(cid.toString(), maxBlockBytes)
  const expected = supported.multihash.digest
  const actual = supported.multihash.code === 0
    ? bytes
    : (await (supported.multihash.code === sha256.code ? sha256 : sha512).digest(bytes)).digest
  if (expected.length !== actual.length || expected.some((byte, index) => byte !== actual[index])) {
    throw networkError('INTEGRITY', '网关返回的块与 CID 不匹配。')
  }
}
