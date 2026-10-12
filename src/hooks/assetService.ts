import type { ContentRef, GalleryClient, GalleryError, VerifiedAsset } from '../shared/contracts'
import { DEFAULT_LIMITS } from '../shared/limits'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { contentAddress } from '../app/format'

export interface AssetLease {
  readonly active: boolean
  url: string
  mime: string
  kind: VerifiedAsset['kind']
  byteLength: number
  width?: number
  height?: number
  release(): void
}
export interface AssetTicket { promise: Promise<AssetLease>; cancel(): void }
export interface MainAssetState { asset?: AssetLease; error?: GalleryError }
export interface MainAssetSnapshot {
  signature: string
  states: ReadonlyMap<string, MainAssetState>
  settled: boolean
  byteLength: number
}
type Entry = Omit<AssetLease, 'release' | 'active'> & { active: boolean; refs: number; used: number }
type Consumer = { resolve: (lease: AssetLease) => void; reject: (error: unknown) => void }
type Job = { key: string; ref: ContentRef; sessionId: string; requestId: string; priority: number; started: boolean; abandoned: boolean; consumers: Set<Consumer> }

const cancelled = () => new GalleryDomainError({ code: 'CANCELLED', message: '媒体读取已取消。', retryable: true })

/** One pool persists across session changes: cancellation never frees an outstanding slot early. */
export class AssetService {
  private sessionId = ''
  private cache = new Map<string, Entry>()
  private jobs = new Map<string, Job>()
  private outstanding = 0
  private bytes = 0
  private clock = 0
  private closed = false
  private previewTickets = new Set<AssetTicket>()

  constructor(private client: GalleryClient, private nextId: () => string) {}

  isOutstanding(requestId: string): boolean {
    return [...this.jobs.values()].some(job => job.started && !job.abandoned && job.requestId === requestId)
  }

  setSession(sessionId: string): void {
    this.releasePreviews()
    this.sessionId = sessionId
    for (const job of this.jobs.values()) this.abandon(job)
    this.jobs.clear()
    for (const entry of this.cache.values()) { entry.active = false; URL.revokeObjectURL(entry.url) }
    this.cache.clear()
    this.bytes = 0
  }

  acquire(ref: ContentRef, priority = 1): AssetTicket {
    const key = `${this.sessionId}:${contentAddress(ref)}`
    let lease: AssetLease | undefined
    let consumer: Consumer | undefined
    let cancelledTicket = false
    const cached = this.cache.get(key)
    const promise = new Promise<AssetLease>((resolve, reject) => {
      if (this.closed || !this.sessionId) { reject(cancelled()); return }
      if (cached) { lease = this.retain(cached); resolve(lease); return }
      consumer = { resolve: value => { lease = value; resolve(value) }, reject }
      let job = this.jobs.get(key)
      if (!job) {
        job = { key, ref, sessionId: this.sessionId, requestId: this.nextId(), priority, started: false, abandoned: false, consumers: new Set() }
        this.jobs.set(key, job)
      }
      job.priority = Math.min(job.priority, priority)
      job.consumers.add(consumer)
      this.pump()
    })
    const ticket: AssetTicket = { promise, cancel: () => {
      if (cancelledTicket) return
      cancelledTicket = true
      this.previewTickets.delete(ticket)
      lease?.release()
      if (consumer) {
        const job = this.jobs.get(key)
        if (job?.consumers.delete(consumer)) {
          consumer.reject(cancelled())
          if (!job.consumers.size) { this.abandon(job); this.jobs.delete(key) }
        }
      }
    } }
    if (priority > 0) this.previewTickets.add(ticket)
    void promise.catch(() => this.previewTickets.delete(ticket))
    return ticket
  }

  releasePreviews(): void {
    for (const ticket of this.previewTickets) ticket.cancel()
    this.previewTickets.clear()
  }

  private retain(entry: Entry): AssetLease {
    entry.refs++
    entry.used = ++this.clock
    let released = false
    return { get active() { return !released && entry.active }, url: entry.url, mime: entry.mime, kind: entry.kind, byteLength: entry.byteLength,
      ...(entry.width === undefined ? {} : { width: entry.width }), ...(entry.height === undefined ? {} : { height: entry.height }),
      release: () => { if (!released) { released = true; entry.refs--; entry.used = ++this.clock } },
    }
  }

  private abandon(job: Job): void {
    if (job.abandoned) return
    job.abandoned = true
    for (const consumer of job.consumers) consumer.reject(cancelled())
    job.consumers.clear()
    if (job.started) void this.client.cancel({ type: 'cancel', sessionId: job.sessionId, requestId: this.nextId(), targetRequestId: job.requestId }).catch(() => {})
  }

  private reserve(size: number, priority: number): void {
    if (priority === 0 && this.bytes + size > DEFAULT_LIMITS.maxBlobCacheBytes) this.releasePreviews()
    for (const [key, entry] of [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used)) {
      if (this.bytes + size <= DEFAULT_LIMITS.maxBlobCacheBytes) break
      if (entry.refs) continue
      this.cache.delete(key)
      this.bytes -= entry.byteLength
      entry.active = false
      URL.revokeObjectURL(entry.url)
    }
    if (size > DEFAULT_LIMITS.maxAssetBytes || this.bytes + size > DEFAULT_LIMITS.maxBlobCacheBytes) {
      throw new GalleryDomainError({ code: 'LIMIT', message: '当前已打开的媒体占满缓存，请关闭查看器或滚动离开其它影像后重试。', retryable: true })
    }
  }

  private pump(): void {
    if (this.closed) return
    while (this.outstanding < DEFAULT_LIMITS.maxAssetConcurrency) {
      const job = [...this.jobs.values()].filter(value => !value.started && !value.abandoned).sort((a, b) => a.priority - b.priority)[0]
      if (!job) return
      job.started = true
      this.outstanding++
      void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const asset = await this.client.loadAsset({ type: 'asset', sessionId: job.sessionId, requestId: job.requestId, ref: job.ref })
      if (this.closed || job.abandoned || job.sessionId !== this.sessionId || !job.consumers.size) return
      if (asset.bytes.byteLength !== asset.byteLength) throw new GalleryDomainError({ code: 'INTERNAL', message: '媒体字节长度不一致。', retryable: true })
      this.reserve(asset.byteLength, job.priority)
      if (job.abandoned || !job.consumers.size) return
      const entry: Entry = { active: true, url: URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime })), mime: asset.mime,
        kind: asset.kind, byteLength: asset.byteLength, refs: 0, used: ++this.clock,
        ...(asset.width === undefined ? {} : { width: asset.width }), ...(asset.height === undefined ? {} : { height: asset.height }) }
      this.cache.set(job.key, entry)
      this.bytes += entry.byteLength
      for (const consumer of job.consumers) consumer.resolve(this.retain(entry))
      job.consumers.clear()
    } catch (error) {
      const domain: GalleryError = toGalleryError(error)
      for (const consumer of job.consumers) consumer.reject(new GalleryDomainError(domain))
      job.consumers.clear()
    } finally {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
      this.outstanding--
      this.pump()
    }
  }

  dispose(): void { this.closed = true; this.setSession('') }
}

export class MainAssetSet {
  private records = new Map<string, { ticket: AssetTicket; state: MainAssetState; settled: boolean }>()
  private signature = ''
  private closed = false

  constructor(private service: AssetService, private publish: (snapshot: MainAssetSnapshot) => void) {}

  update(refs: readonly ContentRef[]): void {
    const signature = JSON.stringify(refs.map(contentAddress))
    if (this.closed || signature === this.signature) return
    this.service.releasePreviews()
    this.signature = signature
    const retained = new Set(refs.map(contentAddress))
    for (const [key, record] of this.records) {
      if (!retained.has(key)) { record.ticket.cancel(); this.records.delete(key) }
    }
    for (const ref of refs) if (!this.records.has(contentAddress(ref))) this.load(ref)
    this.emit()
  }

  retry(ref: ContentRef): void {
    if (this.closed || !this.records.has(contentAddress(ref))) return
    this.service.releasePreviews()
    this.records.get(contentAddress(ref))!.ticket.cancel()
    this.load(ref)
    this.emit()
  }

  private load(ref: ContentRef): void {
    const key = contentAddress(ref)
    const record = { ticket: this.service.acquire(ref, 0), state: {} as MainAssetState, settled: false }
    this.records.set(key, record)
    void record.ticket.promise.then(asset => { record.state = { asset } }, error => { record.state = { error: toGalleryError(error) } }).then(() => {
      record.settled = true
      if (!this.closed && this.records.get(key) === record) this.emit()
    })
  }

  private emit(): void {
    const states = new Map([...this.records].map(([key, record]) => [key, record.state]))
    this.publish({ signature: this.signature, states, settled: [...this.records.values()].every(record => record.settled),
      byteLength: [...states.values()].reduce((sum, state) => sum + (state.asset?.byteLength ?? 0), 0) })
  }

  dispose(): void {
    this.closed = true
    for (const record of this.records.values()) record.ticket.cancel()
    this.records.clear()
  }
}
