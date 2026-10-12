import type { ContentRef, ParsedLocation } from '../shared/contracts'
import { DEFAULT_LIMITS } from '../shared/limits'
import { MAX_PATH_LENGTH, canonicalRef, fail, normalizeCid, splitPath, wellFormed } from './paths'
import { normalizeGateway } from '../network/broker'

export function normalizeContentRef(value: string): ContentRef {
  let text = value.trimStart()
  if (/^[a-z][a-z\d+.-]*:/iu.test(text) || !text.includes('/')) text = text.trimEnd()
  if (!text || text.length > MAX_PATH_LENGTH * 12 + 512) fail('INVALID_INPUT', '内容引用为空或过长。')
  let content = text
  let decode = false
  if (/^ipfs:\/\//iu.test(text)) {
    content = text.slice(7)
    if (/[?#]/u.test(content)) fail('INVALID_INPUT', 'IPFS 引用不能包含查询或片段。')
    decode = true
  } else if (/^https?:\/\//iu.test(text)) {
    try { new URL(text) } catch { fail('INVALID_INPUT', '无效的网关内容链接。') }
    const pathname = /^https?:\/\/[^/?#]+([^?#]*)/iu.exec(text)?.[1] ?? ''
    if (!pathname.startsWith('/ipfs/')) fail('INVALID_INPUT', '只接受网关的 /ipfs/ 内容链接。')
    content = pathname.slice(6)
    decode = true
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(text)) {
    fail('INVALID_INPUT', '只接受 CID 与 IPFS 内容引用。')
  }
  const slash = content.indexOf('/')
  let cidText = slash < 0 ? content : content.slice(0, slash)
  if (decode) {
    try { cidText = decodeURIComponent(cidText) } catch { fail('INVALID_INPUT', 'CID 包含无效的 URI 编码。') }
  }
  const cid = normalizeCid(cidText)
  return { cid, path: slash < 0 ? [] : splitPath(content.slice(slash + 1), decode) }
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name)
  if (values.length > 1) fail('INVALID_INPUT', `${name} 只能提供一次。`)
  return values[0]
}

export function parseLocation(search: string): ParsedLocation {
  const params = new URLSearchParams(search)
  const meta = single(params, 'meta')
  const unixfs = single(params, 'unixfs')
  const browse = single(params, 'browse')
  const q = single(params, 'q') ?? ''
  const type = single(params, 'type')
  const item = single(params, 'item')
  if (browse !== undefined && browse !== '1') fail('INVALID_INPUT', 'browse 只接受 1。')
  if (q.length > 200 || !wellFormed(q)) fail('INVALID_INPUT', '搜索词最多 200 字符。')
  if (type !== undefined && type !== 'image' && type !== 'video') fail('INVALID_INPUT', '无效的媒体过滤类型。')
  if (item !== undefined && (!item || !wellFormed(item))) fail('INVALID_INPUT', '无效的媒体 ID。')
  const tags = [...new Set(params.getAll('tag'))]
  if (tags.length > 20 || tags.some((tag) => !tag || tag.length > 64 || !wellFormed(tag))) {
    fail('INVALID_INPUT', '标签过滤超出限制。')
  }
  const gatewayValues = params.getAll('gateway')
  if (gatewayValues.length > DEFAULT_LIMITS.maxGateways) fail('INVALID_INPUT', '网关数量超出限制。')
  const gateways = [...new Set(gatewayValues.map(normalizeGateway))]
  const location: ParsedLocation = {
    view: { q, tags, ...(type ? { type } : {}), ...(item ? { item } : {}) }, gateways, notices: [],
  }
  const lowerPresent = params.has('cid') || params.has('cids')
  if (meta !== undefined) {
    location.input = { source: { kind: 'manifest', ref: normalizeContentRef(meta) } }
    if (unixfs !== undefined || lowerPresent) location.notices.push('显式描述文件覆盖了低优先级来源。')
  } else if (unixfs !== undefined) {
    location.input = { source: { kind: 'unixfs', ref: normalizeContentRef(unixfs), browse: browse === '1' } }
    if (lowerPresent) location.notices.push('UnixFS 来源覆盖了 CID 列表。')
  } else if (lowerPresent) {
    const refs: ContentRef[] = []
    const seen = new Set<string>()
    for (const [key, value] of params) {
      if (key !== 'cid' && key !== 'cids') continue
      for (const token of key === 'cids' ? value.split(',') : [value]) {
        if (!token.trim()) fail('INVALID_INPUT', 'CID 列表不能包含空项。')
        const ref = normalizeContentRef(key === 'cids' ? token.trim() : token)
        const canonical = canonicalRef(ref)
        if (!seen.has(canonical)) { refs.push(ref); seen.add(canonical) }
        if (refs.length > DEFAULT_LIMITS.maxRoots) fail('INVALID_INPUT', '根来源数量超出限制。')
      }
    }
    location.input = { source: { kind: 'cids', refs, browse: browse === '1' } }
  }
  return location
}

export function serializeLocation(location: ParsedLocation): string {
  const params = new URLSearchParams()
  const source = location.input?.source
  if (source?.kind === 'cids' && source.refs.length === 0) fail('INVALID_INPUT', 'CID 列表不能为空。')
  if (source?.kind === 'manifest') params.set('meta', canonicalRef(source.ref))
  if (source?.kind === 'unixfs') params.set('unixfs', canonicalRef(source.ref))
  if (source?.kind === 'cids') for (const ref of source.refs) params.append('cid', canonicalRef(ref))
  if (source && source.kind !== 'manifest' && source.browse) params.set('browse', '1')
  for (const gateway of location.gateways) params.append('gateway', normalizeGateway(gateway))
  if (location.view.q) params.set('q', location.view.q)
  for (const tag of location.view.tags) params.append('tag', tag)
  if (location.view.type) params.set('type', location.view.type)
  if (location.view.item) params.set('item', location.view.item)
  // Validate programmatic form state with the same boundary as navigation.
  parseLocation(params.toString())
  return params.size ? `?${params.toString()}` : ''
}
