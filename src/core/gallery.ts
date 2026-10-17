import type { ContentRef, GalleryError, GalleryInput, GalleryItem, GalleryResult } from '../shared/contracts'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { sniffMedia } from './headers'
import { InputBudgetExceededError, isInputBudgetExceeded } from './input-budget'
import { parseManifest } from './manifest'
import { canonicalRef, fail, stableItemId, validateSegment } from './paths'
import { normalizeContentRef } from './query'
import { checkSignal, readBounded, rethrowCancellation } from './read'
import type { ContentListingEntry, ContentReader, ContentStat, DiscoveryOptions, GalleryProgress } from './types'

const manifestNames = ['gallery.json', 'gallery.yaml', 'gallery.yml', 'gallery.toml']
const PREFIX_BYTES = 16 * 1024
const mediaExtension = /\.(?:jpe?g|png|gif|webp|avif|mp4|webm)$/iu
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

export async function discoverGallery(
  input: GalleryInput,
  reader: ContentReader,
  options: DiscoveryOptions,
): Promise<GalleryResult> {
  const { signal, limits } = options
  let entries = 0, outputBytes = 0, accepted = 0, lastProgress = -Infinity
  const warnings: GalleryError[] = []
  let partial = false, directoryBudgetReached = false, inputBudgetReached = false
  function rethrowInterruption(error: unknown): void {
    rethrowCancellation(error, signal)
    if (isInputBudgetExceeded(error)) throw error
  }
  function progress(phase: GalleryProgress['phase'], completed: number, total?: number): void {
    checkSignal(signal)
    const now = Date.now()
    if (now - lastProgress < limits.progressIntervalMs) return
    lastProgress = now
    options.onProgress?.({ phase, completed, ...(total === undefined ? {} : { total }) })
  }
  function warn(code: GalleryError['code'], message: string, ref: ContentRef, incomplete = false): void {
    warnings.push({ code, message, ref, retryable: false })
    partial ||= incomplete
  }
  async function bytes(ref: ContentRef, stat: ContentStat, maxBytes: number, prefix = false): Promise<Uint8Array> {
    const remaining = limits.maxDiscoveryInputBytes - outputBytes
    if (remaining <= 0) throw new InputBudgetExceededError('图库读取总预算已用尽。', ref)
    if (prefix && stat.size !== undefined && remaining < Number(stat.size < BigInt(maxBytes) ? stat.size : BigInt(maxBytes))) {
      fail('LIMIT', '剩余读取预算不足以识别文件。', ref)
    }
    const cap = Math.min(maxBytes, remaining)
    const size = prefix && stat.size !== undefined ? (stat.size < BigInt(cap) ? stat.size : BigInt(cap)) : stat.size
    const value = await readBounded(reader, ref, {
      signal, maxBytes: cap, ...(prefix ? { offset: 0, length: cap } : {}),
    }, {
      size,
      maxRetainedBytes: Math.max(0, limits.maxAssemblyBytes - cap),
      onChunk: (byteLength) => {
        outputBytes += byteLength
        if (outputBytes > limits.maxDiscoveryInputBytes) throw new InputBudgetExceededError('图库读取总预算已用尽。', ref)
      },
    })
    if (prefix && cap < maxBytes && stat.size === undefined && value.byteLength === cap) {
      throw new InputBudgetExceededError('图库读取总预算已用尽。', ref)
    }
    return value
  }
  async function manifest(ref: ContentRef, stat?: ContentStat): Promise<GalleryResult> {
    progress('metadata', 0)
    const info = stat ?? await reader.stat(ref, signal)
    checkSignal(signal)
    if (info.kind !== 'file') fail('INVALID_METADATA', '描述文件必须是普通文件，不能是目录或符号链接。', ref)
    return parseManifest(await bytes(ref, info, Math.min(limits.maxManifestBytes, 1024 * 1024)), ref, limits)
  }
  async function* list(ref: ContentRef): AsyncIterable<ContentListingEntry> {
    if (directoryBudgetReached) return
    for await (const entry of reader.ls(ref, signal)) {
      checkSignal(signal)
      if (entries >= limits.maxDirectoryEntries) {
        directoryBudgetReached = true
        warn('LIMIT', '目录条目数量达到上限，结果不完整。', ref, true)
        break
      }
      entries++
      progress('listing', entries)
      yield entry
    }
    checkSignal(signal)
  }
  function candidate(source: ContentRef, ref: ContentRef, path: string, kind: 'image' | 'video'): GalleryItem {
    return {
      id: stableItemId(source, path, ref), ref,
      title: path ? path.split('/').at(-1)! : ref.path.at(-1) ?? ref.cid, alt: '', tags: [], kind,
      sourceLabel: `${canonicalRef(source)}${path ? `/${path}` : ''}`,
    }
  }
  async function scan(root: ContentRef): Promise<GalleryResult> {
    const found: { path: string; item: GalleryItem }[] = []
    const alreadyAccepted = accepted
    let itemLimitReported = false
    async function walk(ref: ContentRef, path: string, depth: number, ancestors: Set<string>): Promise<void> {
      checkSignal(signal)
      if (depth > limits.maxDirectoryDepth) {
        warn('LIMIT', '目录递归深度达到上限。', ref, true)
        return
      }
      if (ancestors.has(ref.cid)) {
        warn('UNSUPPORTED', '跳过循环目录链接。', ref, true)
        return
      }
      const nextAncestors = new Set(ancestors).add(ref.cid)
      try {
        for await (const entry of list(ref)) {
          checkSignal(signal)
          if ('error' in entry) {
            rethrowCancellation(new GalleryDomainError(entry.error), signal)
            warnings.push({ ...entry.error, ref: entry.ref }); partial = true
            continue
          }
          validateSegment(entry.name)
          if (alreadyAccepted + found.length >= limits.maxItems) {
            if (!itemLimitReported) { warn('LIMIT', '媒体项目数量达到上限。', root, true); itemLimitReported = true }
            break
          }
          const childPath = path ? `${path}/${entry.name}` : entry.name
          const childRef = normalizeContentRef(canonicalRef(entry.ref))
          if (entry.kind === 'symlink') {
            warn('UNSUPPORTED', '未跟随符号链接。', childRef)
            continue
          }
          if (entry.kind === 'directory') {
            await walk(childRef, childPath, depth + 1, nextAncestors)
            continue
          }
          try {
            const prefix = await bytes(childRef, entry, PREFIX_BYTES, true)
            const type = sniffMedia(prefix)
            if (!type) {
              if (mediaExtension.test(entry.name)) warn('UNSUPPORTED', '文件扩展名与支持的媒体头不匹配。', childRef)
              continue
            }
            if (entry.size !== undefined && entry.size > BigInt(limits.maxAssetBytes)) {
              warn('LIMIT', '媒体文件超过单资源限制。', childRef, true)
              continue
            }
            found.push({ path: childPath, item: candidate(root, childRef, childPath, type.kind) })
          } catch (error) {
            rethrowInterruption(error)
            warnings.push({ ...toGalleryError(error), ref: childRef }); partial = true
          }
        }
      } catch (error) {
        rethrowInterruption(error)
        warnings.push({ ...toGalleryError(error), ref }); partial = true
      }
    }
    try { await walk(root, '', 0, new Set()) } catch (error) {
      rethrowCancellation(error, signal)
      if (!isInputBudgetExceeded(error)) throw error
      inputBudgetReached = true
      warnings.push({ ...toGalleryError(error), ref: root }); partial = true
    }
    found.sort((a, b) => compare(a.path, b.path))
    return { title: root.path.at(-1) ?? 'IPFS 图库', description: '', items: found.map(({ item }) => item), warnings: [], partial: false }
  }
  async function resolve(root: ContentRef, browse: boolean): Promise<GalleryResult> {
    progress('resolving', 0)
    const stat = await reader.stat(root, signal)
    checkSignal(signal)
    if (stat.kind === 'symlink') fail('UNSUPPORTED', '不能打开符号链接。', root)
    if (stat.kind === 'directory') {
      if (!browse) {
        for (const name of manifestNames) {
          const ref = { cid: root.cid, path: [...root.path, name] }
          let candidateStat: ContentStat
          try { candidateStat = await reader.stat(ref, signal) } catch (error) {
            rethrowInterruption(error)
            const failure = toGalleryError(error)
            // A gateway 404 means unavailable content, not proof that the directory name is absent.
            if (failure.code === 'NOT_FOUND' && failure.gateway === undefined) continue
            throw error
          }
          // Existence, not successful parsing, establishes the sole authoritative candidate.
          return manifest(ref, candidateStat)
        }
      }
      return scan(root)
    }
    const prefix = await bytes(root, stat, PREFIX_BYTES, true)
    const type = sniffMedia(prefix)
    if (type) {
      if (stat.size !== undefined && stat.size > BigInt(limits.maxAssetBytes)) fail('LIMIT', '媒体文件超过单资源限制。', root)
      return { title: root.path.at(-1) ?? 'IPFS 图库', description: '', items: [candidate(root, root, '', type.kind)], warnings: [], partial: false }
    }
    if (stat.size === undefined || stat.size <= BigInt(limits.maxManifestBytes)) {
      try {
        return parseManifest(await bytes(root, stat, Math.min(limits.maxManifestBytes, 1024 * 1024)), root, limits)
      } catch (error) {
        rethrowInterruption(error)
        if (toGalleryError(error).code !== 'INVALID_METADATA') throw error
      }
    }
    return fail('UNSUPPORTED', '此文件不是受支持的媒体或图库描述文件。', root)
  }
  try {
    checkSignal(signal)
    if (input.source.kind === 'manifest') {
      const value = await manifest(normalizeContentRef(canonicalRef(input.source.ref)))
      checkSignal(signal)
      return value
    }
    const source = input.source
    const rootList = source.kind === 'unixfs' ? [source.ref] : source.refs
    const roots: ContentRef[] = [], seen = new Set<string>()
    for (const root of rootList) {
      const key = canonicalRef(root)
      if (!seen.has(key)) { roots.push(normalizeContentRef(key)); seen.add(key) }
    }
    if (roots.length > limits.maxRoots) fail('LIMIT', '根来源数量超出限制。')
    const result: GalleryResult = { title: 'IPFS 图库', description: '', items: [], warnings, partial: false }
    for (const root of roots) {
      checkSignal(signal)
      if (inputBudgetReached) break
      if (accepted >= limits.maxItems) { warn('LIMIT', '媒体项目数量达到上限。', root, true); break }
      try {
        const value = await resolve(root, source.browse)
        if (roots.length === 1) { result.title = value.title; result.description = value.description }
        const available = limits.maxItems - accepted
        if (value.items.length > available) warn('LIMIT', '合并图库项目数量达到上限。', root, true)
        const items = value.items.slice(0, available)
        result.items.push(...items); accepted += items.length
        warnings.push(...value.warnings); partial ||= value.partial
      } catch (error) {
        rethrowCancellation(error, signal)
        if (isInputBudgetExceeded(error)) inputBudgetReached = true
        if (source.kind === 'unixfs') throw error
        warnings.push({ ...toGalleryError(error), ref: root }); partial = true
      }
    }
    checkSignal(signal)
    result.partial = partial
    return result
  } catch (error) {
    rethrowCancellation(error, signal)
    throw error instanceof GalleryDomainError ? error : new GalleryDomainError(toGalleryError(error))
  }
}
