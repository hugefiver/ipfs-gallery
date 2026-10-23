import { networkError } from './errors'

/** Shared across every binding's transport; admission never creates a waiting queue. */
export class DirectBudget {
  private dials = 0
  private connections = 0
  private peers = 0
  private metadataEntries = 0
  private metadataBytes = 0
  private idle = 0

  retainIdle(): (() => void) | undefined {
    if (this.idle >= 3) return
    this.idle++
    let released = false
    return () => { if (!released) { released = true; this.idle-- } }
  }

  acquire(kind: 'dial' | 'connection' | 'peer'): () => void {
    const key = kind === 'dial' ? 'dials' : kind === 'connection' ? 'connections' : 'peers'
    const cap = kind === 'dial' ? 2 : kind === 'connection' ? 6 : 32
    if (this[key] >= cap) throw networkError('LIMIT', '全局传输资源不足。')
    this[key]++
    let released = false
    return () => { if (!released) { released = true; this[key]-- } }
  }

  resizeMetadata(entryDelta: number, byteDelta: number): void {
    if (this.metadataEntries + entryDelta > 128 || this.metadataBytes + byteDelta > 1024 * 1024) throw networkError('LIMIT', 'Peer 元数据预算不足。')
    this.metadataEntries += entryDelta
    this.metadataBytes += byteDelta
  }

  snapshot() { return { dials: this.dials, connections: this.connections, peers: this.peers, metadataEntries: this.metadataEntries, metadataBytes: this.metadataBytes } }
}

export const directBudget = new DirectBudget()
