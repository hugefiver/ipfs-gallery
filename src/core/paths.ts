import { CID } from 'multiformats/cid'
import { base32, base32upper, base32hex, base32hexupper } from 'multiformats/bases/base32'
import { base36, base36upper } from 'multiformats/bases/base36'
import { base16, base16upper } from 'multiformats/bases/base16'
import { base64url } from 'multiformats/bases/base64'
import { base58btc } from 'multiformats/bases/base58'
import type { ContentRef, ErrorCode } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'

export const MAX_PATH_LENGTH = 4096
export const MAX_PATH_SEGMENTS = 64
export const MAX_SEGMENT_LENGTH = 255
const cidDecoder = base32.decoder.or(base32upper.decoder).or(base32hex.decoder).or(base32hexupper.decoder)
  .or(base36.decoder).or(base36upper.decoder).or(base16.decoder).or(base16upper.decoder)
  .or(base64url.decoder).or(base58btc.decoder)

export function wellFormed(value: string): boolean {
  return !/[\ud800-\udfff]/u.test(value)
}

export function fail(code: ErrorCode, message: string, ref?: ContentRef): never {
  throw new GalleryDomainError({ code, message, retryable: false, ...(ref ? { ref } : {}) })
}

export function normalizeCid(value: string): string {
  try {
    return CID.parse(value, cidDecoder)
      .toV1().toString()
  } catch {
    return fail('INVALID_INPUT', '无效的 CID。')
  }
}

export function validateSegment(segment: string, relative = false): void {
  if (!segment || segment.length > MAX_SEGMENT_LENGTH || /[/\\]/u.test(segment)
    || [...segment].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || (!relative && (segment === '.' || segment === '..'))
    || !wellFormed(segment)) {
    fail('INVALID_INPUT', '内容路径包含非法分段。')
  }
}

export function validatePath(path: string[]): string[] {
  if (path.length > MAX_PATH_SEGMENTS || path.join('/').length > MAX_PATH_LENGTH) {
    fail('INVALID_INPUT', '内容路径超过长度限制。')
  }
  for (const segment of path) validateSegment(segment)
  return path
}

export function splitPath(value: string, decode = false): string[] {
  if (value.length > MAX_PATH_LENGTH * (decode ? 12 : 1)) fail('INVALID_INPUT', '内容路径超过长度限制。')
  const text = value.endsWith('/') ? value.slice(0, -1) : value
  if (!text) return []
  const path = text.split('/').map((segment) => {
    if (!decode) return segment
    try {
      return decodeURIComponent(segment)
    } catch {
      return fail('INVALID_INPUT', '内容路径包含无效的 URI 编码。')
    }
  })
  return validatePath(path)
}

export function canonicalRef(ref: ContentRef): string {
  const cid = normalizeCid(ref.cid)
  const path = validatePath(ref.path)
  return `ipfs://${cid}${path.length ? `/${path.map(encodeURIComponent).join('/')}` : ''}`
}

export function resolveManifestRef(
  value: { cid?: string; path?: string },
  manifest: ContentRef,
): ContentRef {
  if (value.cid === undefined && value.path === undefined) {
    fail('INVALID_METADATA', '条目需要 CID 或路径。', manifest)
  }
  if (value.cid === undefined && manifest.path.length === 0) {
    fail('INVALID_METADATA', '裸文件 CID 的条目必须提供自己的 CID。', manifest)
  }
  const cid = value.cid === undefined ? manifest.cid : normalizeCid(value.cid)
  const path = value.cid === undefined ? manifest.path.slice(0, -1) : []
  if (value.path !== undefined) {
    if (!value.path || value.path.length > MAX_PATH_LENGTH || value.path.startsWith('/')
      || /^[a-z][a-z\d+.-]*:/iu.test(value.path)) {
      fail('INVALID_METADATA', '描述文件只能使用 CID 内的相对路径。', manifest)
    }
    for (const segment of value.path.split('/')) {
      validateSegment(segment, true)
      if (segment === '.') continue
      if (segment === '..') {
        if (path.length === 0) fail('INVALID_METADATA', '相对路径不能越过 CID 根。', manifest)
        path.pop()
      } else path.push(segment)
    }
  }
  return { cid, path: validatePath(path) }
}

export function stableItemId(source: ContentRef, ordinal: number | string, ref: ContentRef): string {
  // An injective tuple is stable without collisions, random state, or async hashing.
  return JSON.stringify([canonicalRef(source), ordinal, canonicalRef(ref)])
}
