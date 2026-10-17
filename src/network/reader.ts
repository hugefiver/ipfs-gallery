import { exporter, NotFoundError, NoResolverError, NotUnixFSError, UnderReadError, OverReadError, InvalidParametersError } from 'ipfs-unixfs-exporter'
import type { ReadableStorage, UnixFSEntry } from 'ipfs-unixfs-exporter'
import type { ContentReader, ContentStat } from '../core/types'
import { InputBudgetExceededError, isInputBudgetExceeded } from '../core/input-budget'
import { rethrowCancellation } from '../core/read'
import type { ContentRef } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { checkSignal, networkError } from './errors'
import { hasUnsafePathCharacters } from './path-safety'
import type { VerifiedBlockSource } from './types'
import { parseBlockCid } from './verify'

function statEntry(entry: UnixFSEntry): ContentStat {
  if (entry.type === 'directory') return { kind: 'directory' }
  if (entry.type === 'file') {
    if (entry.unixfs.type === 'symlink') return { kind: 'symlink' }
    if (entry.unixfs.type !== 'file' && entry.unixfs.type !== 'raw') throw networkError('UNSUPPORTED', '不支持此 UnixFS 节点类型。')
    return { kind: 'file', size: entry.size }
  }
  if (entry.type === 'raw') return { kind: 'file', size: BigInt(entry.node.byteLength) }
  throw networkError('UNSUPPORTED', '不是支持的 UnixFS 文件或目录。')
}

function readerError(error: unknown, signal: AbortSignal): GalleryDomainError {
  checkSignal(signal)
  rethrowCancellation(error, signal)
  if (error instanceof GalleryDomainError) return error
  if (error instanceof NotFoundError) return networkError('NOT_FOUND', 'IPFS 路径不存在。')
  if (error instanceof NoResolverError || error instanceof NotUnixFSError) return networkError('UNSUPPORTED', '内容不是支持的 UnixFS 数据。')
  if (error instanceof UnderReadError || error instanceof OverReadError) return networkError('INTEGRITY', 'UnixFS 文件数据与长度不一致。')
  if (error instanceof InvalidParametersError) return networkError('INVALID_INPUT', '文件读取范围无效。')
  return networkError('UNSUPPORTED', '无法解释此 UnixFS 数据。')
}

export function createContentReader(source: VerifiedBlockSource, options: { maxInputBytes: number }): ContentReader {
  const maxInputBytes = options.maxInputBytes
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) throw networkError('INVALID_INPUT', '解析输入上限无效。')
  let inputBytes = 0

  function operation(signal: AbortSignal) {
    checkSignal(signal)
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const storage: ReadableStorage = {
      async *get(cid, getOptions) {
        const blockSignal = getOptions?.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, getOptions.signal])
        checkSignal(blockSignal)
        if (inputBytes > maxInputBytes) throw new InputBudgetExceededError('已验证解析输入超过上限。')
        parseBlockCid(cid.toString(), maxInputBytes)
        const block = await source.get(cid.toString(), blockSignal)
        checkSignal(blockSignal)
        inputBytes += block.byteLength
        if (inputBytes > maxInputBytes) throw new InputBudgetExceededError('已验证解析输入超过上限。')
        yield block
      },
    }
    return {
      signal: controller.signal,
      storage,
      close() {
        signal.removeEventListener('abort', onAbort)
        controller.abort(networkError('CANCELLED', '读取操作已结束。'))
      },
    }
  }

  async function resolve(ref: ContentRef, op: ReturnType<typeof operation>): Promise<UnixFSEntry> {
    const cid = parseBlockCid(ref.cid, maxInputBytes).toV1()
    if (ref.path.length > 64 || ref.path.join('/').length > 4096 || ref.path.some((part) =>
      !part || part.length > 255 || part === '.' || part === '..' || hasUnsafePathCharacters(part),
    )) throw networkError('INVALID_INPUT', 'IPFS 路径无效。')
    const path = ref.path.length ? `${cid}/${ref.path.join('/')}` : cid.toString()
    const entry = await exporter(path, op.storage, { signal: op.signal })
    if (ref.path.length && entry.path !== path) throw networkError('NOT_FOUND', 'IPFS 路径不存在。')
    return entry
  }

  return {
    async stat(ref, signal) {
      const op = operation(signal)
      try { return statEntry(await resolve(ref, op)) } catch (error) { throw readerError(error, signal) } finally { op.close() }
    },
    async *ls(ref, signal) {
      const op = operation(signal)
      try {
        const directory = await resolve(ref, op)
        if (directory.type !== 'directory') throw networkError('UNSUPPORTED', '内容不是目录。')
        for await (const child of directory.entries({ signal: op.signal, blockReadConcurrency: 1 })) {
          checkSignal(op.signal)
          if (!child.name || child.name.length > 255 || child.name === '.' || child.name === '..' || hasUnsafePathCharacters(child.name)) {
            throw networkError('UNSUPPORTED', 'UnixFS 目录包含无效名称。')
          }
          const ref = { cid: child.cid.toV1().toString(), path: [] }
          let stat: ContentStat
          try {
            stat = statEntry(await resolve(ref, op))
          } catch (error) {
            rethrowCancellation(error, signal)
            if (isInputBudgetExceeded(error)) throw error
            yield { name: child.name, ref, error: readerError(error, signal).error }
            continue
          }
          yield { name: child.name, ref, ...stat }
        }
      } catch (error) { throw readerError(error, signal) } finally { op.close() }
    },
    async *read(ref, readOptions) {
      const { signal, maxBytes, offset = 0, length } = readOptions
      for (const value of [maxBytes, offset, ...(length === undefined ? [] : [length])]) {
        if (!Number.isSafeInteger(value) || value < 0) throw networkError('INVALID_INPUT', '文件读取范围无效。')
      }
      const op = operation(signal)
      try {
        const entry = await resolve(ref, op)
        const stat = statEntry(entry)
        if (stat.kind !== 'file' || entry.type === 'directory' || entry.type === 'object' || entry.type === 'identity') {
          throw networkError('UNSUPPORTED', '内容不是可读取的普通文件。')
        }
        const size = stat.size ?? 0n
        const available = size > BigInt(offset) ? size - BigInt(offset) : 0n
        const requested = length === undefined || BigInt(length) > available ? available : BigInt(length)
        if (requested > BigInt(maxBytes)) throw networkError('LIMIT', '文件读取超过输出字节上限。')
        if (requested === 0n) return
        let outputBytes = 0
        for await (const chunk of entry.content({ signal: op.signal, offset, length: Number(requested), blockReadConcurrency: 1 })) {
          checkSignal(op.signal)
          outputBytes += chunk.byteLength
          if (outputBytes > maxBytes || BigInt(outputBytes) > requested) throw networkError('LIMIT', '文件读取超过输出字节上限。')
          yield chunk
        }
        if (BigInt(outputBytes) !== requested) throw networkError('INTEGRITY', 'UnixFS 文件数据与长度不一致。')
      } catch (error) { throw readerError(error, signal) } finally { op.close() }
    },
  }
}
