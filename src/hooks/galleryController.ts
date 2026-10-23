import type { GalleryClient, GalleryError, GalleryResult, GatewayStat, ParsedLocation, WorkerResponse } from '../shared/contracts'
import { DEFAULT_GATEWAYS } from '../shared/gateways'
import { DEFAULT_LIMITS } from '../shared/limits'
import { toGalleryError } from '../shared/errors'
import { AssetService } from './assetService'

type Progress = Extract<WorkerResponse, { type: 'progress' }>
export interface GallerySnapshot {
  sessionId: string
  status: 'empty' | 'loading' | 'ready' | 'error' | 'cancelled'
  result?: GalleryResult
  error?: GalleryError
  progress?: Progress
  gateways: GatewayStat[]
}

export class GalleryController {
  readonly assets: AssetService
  private serial = 0
  private prefix = crypto.randomUUID()
  private requestId = ''
  private key = ''
  private listeners = new Set<(snapshot: GallerySnapshot) => void>()
  private unsubscribe: () => void
  private closed = false
  snapshot: GallerySnapshot = { sessionId: '', status: 'empty', gateways: [] }

  constructor(private client: GalleryClient) {
    this.assets = new AssetService(client, () => this.nextId())
    this.unsubscribe = client.subscribe(event => {
      if (this.closed || event.sessionId !== this.snapshot.sessionId || (event.requestId !== this.requestId && !this.assets.isOutstanding(event.requestId))) return
      if (event.type === 'telemetry') this.update({ ...this.snapshot, gateways: event.gateways })
      else if (event.requestId === this.requestId && this.snapshot.status === 'loading') this.update({ ...this.snapshot, progress: event })
    })
  }

  private nextId(): string {
    const id = `${this.prefix}:${++this.serial}`
    return id
  }
  subscribe(listener: (snapshot: GallerySnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => { this.listeners.delete(listener) }
  }
  private update(value: GallerySnapshot): void { this.snapshot = value; for (const listener of this.listeners) listener(value) }

  start(location: ParsedLocation, force = false): void {
    const key = JSON.stringify([location.input ?? null, location.gateways])
    if (!force && key === this.key) return
    this.key = key
    this.cancelCurrent()
    const sessionId = `${this.prefix}:session:${++this.serial}`
    this.assets.setSession(location.input ? sessionId : '')
    this.update({ sessionId, status: location.input ? 'loading' : 'empty', gateways: [] })
    if (!location.input) return
    const requestId = this.nextId()
    this.requestId = requestId
    void this.client.discover({ type: 'discover', sessionId, requestId, input: location.input,
      config: { gateways: location.gateways.length ? location.gateways : [...DEFAULT_GATEWAYS], limits: { ...DEFAULT_LIMITS } } }).then(result => {
      if (!this.closed && this.snapshot.sessionId === sessionId && this.requestId === requestId) this.update({ sessionId, status: 'ready', result, gateways: this.snapshot.gateways })
    }).catch(error => {
      if (!this.closed && this.snapshot.sessionId === sessionId && this.requestId === requestId) this.update({ sessionId, status: 'error', error: toGalleryError(error), gateways: this.snapshot.gateways })
    })
  }

  inputError(error: unknown): void {
    this.key = ''
    this.cancelCurrent()
    this.assets.setSession('')
    this.update({ sessionId: '', status: 'error', error: toGalleryError(error), gateways: [] })
  }
  private cancelCurrent(): void {
    if (this.snapshot.sessionId) void this.client.releaseSession({ type: 'release-session',
      sessionId: this.snapshot.sessionId, requestId: this.nextId() }).catch(() => {})
    this.requestId = ''
  }
  cancel(): void {
    this.cancelCurrent()
    this.assets.setSession('')
    this.update({ sessionId: this.snapshot.sessionId, status: 'cancelled', gateways: this.snapshot.gateways })
  }
  dispose(): void {
    this.closed = true
    this.unsubscribe()
    this.assets.dispose()
    this.listeners.clear()
    void this.client.dispose({ type: 'dispose', sessionId: this.snapshot.sessionId || `${this.prefix}:empty`, requestId: this.nextId() }).catch(() => {})
  }
}
