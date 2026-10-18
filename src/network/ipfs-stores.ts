import { BaseBlockstore } from 'blockstore-core'
import { BaseDatastore } from 'datastore-core'
import type { Key } from 'interface-datastore'
import type { Pair } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'
import { directBudget, type DirectBudget } from './direct-budget'
import { networkError } from './errors'

const missing = () => Object.assign(new Error('Block is not retained'), { name: 'NotFoundError' })

/** No received content is ever made available to an inbound Bitswap want. */
export class NonRetainingBlockstore extends BaseBlockstore {
  override has(): boolean { return false }
  override async put(cid: CID, input: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options?: { signal?: AbortSignal }): Promise<CID> {
    let size = 0
    const chunks = input instanceof Uint8Array ? [input] : input
    for await (const chunk of chunks) {
      options?.signal?.throwIfAborted()
      size += chunk.byteLength
      if (size > 4 * 1024 * 1024) throw networkError('LIMIT', '块存储输入超过上限。')
    }
    return cid
  }
  override get(): Generator<Uint8Array> { throw missing() }
  override delete(): void {}
  override *getAll(): Generator<Pair> {}
}

/** Ephemeral, globally byte/entry bounded peer/key metadata, not a block cache. */
export class BoundedDatastore extends BaseDatastore {
  private readonly entries = new Map<string, { key: Key; value: Uint8Array; size: number }>()
  constructor(private readonly budget: DirectBudget = directBudget) { super() }

  override put(key: Key, value: Uint8Array, options?: { signal?: AbortSignal }): Key {
    options?.signal?.throwIfAborted()
    const name = key.toString()
    const bytes = new TextEncoder().encode(name).byteLength + value.byteLength
    if (name.length > 1024 || value.byteLength > 16 * 1024) throw networkError('LIMIT', 'Peer 记录超过上限。')
    const previous = this.entries.get(name)
    this.budget.resizeMetadata(previous === undefined ? 1 : 0, bytes - (previous?.size ?? 0))
    this.entries.set(name, { key, value: value.slice(), size: bytes })
    return key
  }

  override get(key: Key, options?: { signal?: AbortSignal }): Uint8Array {
    options?.signal?.throwIfAborted()
    const entry = this.entries.get(key.toString())
    if (!entry) throw missing()
    return entry.value.slice()
  }

  override has(key: Key, options?: { signal?: AbortSignal }): boolean {
    options?.signal?.throwIfAborted()
    return this.entries.has(key.toString())
  }

  override delete(key: Key, options?: { signal?: AbortSignal }): void {
    options?.signal?.throwIfAborted()
    const previous = this.entries.get(key.toString())
    if (previous !== undefined) {
      this.entries.delete(key.toString())
      this.budget.resizeMetadata(-1, -previous.size)
    }
  }

  override *_all() { for (const entry of this.entries.values()) yield { key: entry.key, value: entry.value.slice() } }
  override *_allKeys() { for (const entry of this.entries.values()) yield entry.key }

  clear(): void {
    for (const entry of this.entries.values()) this.delete(entry.key)
  }
}
