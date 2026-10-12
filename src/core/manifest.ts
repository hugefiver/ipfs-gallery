import { TomlError, parse as parseToml } from 'smol-toml'
import { isAlias, isMap, isNode, isPair, isSeq, parseDocument } from 'yaml'
import type { ContentRef, GalleryItem, GalleryResult, ResourceLimits } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { canonicalRef, fail, resolveManifestRef, stableItemId, wellFormed } from './paths'

type Format = 'json' | 'toml' | 'yaml'
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
const rootKeys = new Set(['version', 'title', 'description', 'items'])
const itemKeys = new Set(['cid', 'path', 'title', 'alt', 'type', 'tags', 'width', 'height', 'thumbnail'])
const refKeys = new Set(['cid', 'path'])

function checkTree(value: unknown, limits: ResourceLimits): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()!
    if (++nodes > limits.maxManifestNodes || current.depth > limits.maxManifestDepth) {
      fail('LIMIT', '描述文件超过结构预算。')
    }
    if (current.value !== null && typeof current.value === 'object') {
      if (Array.isArray(current.value) && current.value.length > Math.max(20, limits.maxItems)) {
        fail('LIMIT', '描述文件数组超过限制。')
      }
      for (const [key, child] of Object.entries(current.value)) {
        if (unsafeKeys.has(key)) fail('INVALID_METADATA', '描述文件包含不安全的键。')
        if (++nodes > limits.maxManifestNodes) fail('LIMIT', '描述文件超过节点预算。')
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
}

function parseYaml(text: string, limits: ResourceLimits): unknown {
  const doc = parseDocument(text, {
    schema: 'core', customTags: [], resolveKnownTags: false, merge: false,
    uniqueKeys: true, stringKeys: true, logLevel: 'error', prettyErrors: false,
  })
  if (doc.errors.length || doc.warnings.length) fail('INVALID_METADATA', '无效的 YAML 描述文件。')
  const stack: { value: unknown; depth: number }[] = [{ value: doc.contents, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++nodes > limits.maxManifestNodes || depth > limits.maxManifestDepth) {
      fail('LIMIT', 'YAML 超过结构预算。')
    }
    if (isAlias(value)) fail('INVALID_METADATA', 'YAML 不允许别名。')
    if (isNode(value) && value.tag
      && !/^tag:yaml.org,2002:(?:map|seq|str|int|float|bool|null)$/u.test(value.tag)) {
      fail('INVALID_METADATA', 'YAML 不允许自定义标签。')
    }
    if (isMap(value) || isSeq(value)) {
      if (isSeq(value) && value.items.length > Math.max(20, limits.maxItems)) {
        fail('LIMIT', 'YAML 数组超过限制。')
      }
      for (const child of value.items) stack.push({ value: child, depth: depth + 1 })
    } else if (isPair(value)) {
      stack.push({ value: value.key, depth }, { value: value.value, depth })
    }
  }
  return doc.toJS({ maxAliasCount: 0 }) as unknown
}

function record(value: unknown, keys: Set<string>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('INVALID_METADATA', '描述文件字段必须是对象。')
  }
  const result = value as Record<string, unknown>
  for (const key of Object.keys(result)) {
    if (!keys.has(key)) fail('INVALID_METADATA', '描述文件包含未知字段。')
  }
  return result
}

function text(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max || !wellFormed(value)) {
    fail('INVALID_METADATA', '描述文件文本字段无效或过长。')
  }
  return value
}

function itemRef(value: Record<string, unknown>, manifest: ContentRef): ContentRef {
  const cid = text(value.cid, 256)
  const path = text(value.path, 4096)
  return resolveManifestRef({ ...(cid === undefined ? {} : { cid }), ...(path === undefined ? {} : { path }) }, manifest)
}

function normalize(value: unknown, ref: ContentRef, limits: ResourceLimits): GalleryResult {
  checkTree(value, limits)
  const root = record(value, rootKeys)
  if (root.version !== 1) fail('INVALID_METADATA', '仅支持版本 1 的图库描述文件。', ref)
  if (!Array.isArray(root.items)) fail('INVALID_METADATA', '描述文件必须包含 items 数组。', ref)
  if (root.items.length > Math.min(2000, limits.maxItems)) fail('LIMIT', '描述文件项目数量超出限制。', ref)
  const items: GalleryItem[] = root.items.map((raw: unknown, index: number) => {
    const item = record(raw, itemKeys)
    const content = itemRef(item, ref)
    if (item.type !== undefined && item.type !== 'image' && item.type !== 'video') {
      fail('INVALID_METADATA', '条目类型必须是 image 或 video。', ref)
    }
    if ((item.width === undefined) !== (item.height === undefined)) {
      fail('INVALID_METADATA', '条目尺寸必须同时包含宽度与高度。', ref)
    }
    for (const dimension of [item.width, item.height]) {
      if (dimension !== undefined && (typeof dimension !== 'number' || !Number.isInteger(dimension)
        || dimension <= 0 || dimension > 16384)) fail('INVALID_METADATA', '条目尺寸无效。', ref)
    }
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 20)) {
      fail('INVALID_METADATA', '条目标签超出限制。', ref)
    }
    const tags = (item.tags as unknown[] | undefined)?.map((tag) => {
      const result = text(tag, 64)
      if (result === undefined) fail('INVALID_METADATA', '标签必须是字符串。', ref)
      return result
    }) ?? []
    return {
      id: stableItemId(ref, index, content), ref: content,
      title: text(item.title, 200) ?? content.path.at(-1) ?? content.cid,
      alt: text(item.alt, 1000) ?? '', tags,
      kind: item.type as 'image' | 'video' | undefined ?? 'unknown', sourceLabel: canonicalRef(ref),
      ...(item.width === undefined ? {} : { width: item.width as number, height: item.height as number }),
      ...(item.thumbnail === undefined ? {} : { thumbnail: itemRef(record(item.thumbnail, refKeys), ref) }),
    }
  })
  return { title: text(root.title, 200) ?? 'IPFS 图库', description: text(root.description, 4000) ?? '', items, warnings: [], partial: false }
}

export function parseManifest(bytes: Uint8Array, ref: ContentRef, limits: ResourceLimits): GalleryResult {
  if (bytes.byteLength > Math.min(1024 * 1024, limits.maxManifestBytes)) fail('LIMIT', '描述文件超过字节限制。', ref)
  let decoded: string
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    return fail('INVALID_METADATA', '描述文件必须使用 UTF-8。', ref)
  }
  const extension = ref.path.at(-1)?.split('.').at(-1)?.toLowerCase()
  const formats: Format[] = extension === 'json' ? ['json']
    : extension === 'yaml' || extension === 'yml' ? ['yaml']
    : extension === 'toml' ? ['toml'] : ['json', 'toml', 'yaml']
  let limitError: GalleryDomainError | undefined
  for (const format of formats) {
    try {
      const value: unknown = format === 'json' ? JSON.parse(decoded)
        : format === 'yaml' ? parseYaml(decoded, limits)
        : parseToml(decoded, { unsafeKeyBehaviour: 'throw', maxDepth: limits.maxManifestDepth })
      return normalize(value, ref, limits)
    } catch (error) {
      if (error instanceof GalleryDomainError && error.error.code === 'LIMIT') limitError = error
      if (format === 'toml' && error instanceof TomlError && error.message.includes('excessively nested structures')) {
        limitError = new GalleryDomainError({ code: 'LIMIT', message: 'TOML 超过结构深度预算。', retryable: false, ref })
      }
    }
  }
  if (limitError) throw limitError
  return fail('INVALID_METADATA', '描述文件不符合版本 1 的安全格式。', ref)
}
