import type { GalleryResult, VerifiedAsset, WorkerRequest, WorkerResponse } from '../../src/shared/contracts'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

export const ref = { cid: 'bafkreigh2akiscaildc45g66cl5p5j5vujhom7nl7ddt6ir7zln6ratv6i', path: [] }
export const result: GalleryResult = { title: 'Gallery', description: '', items: [], warnings: [], partial: false }
export function asset(size = 4): VerifiedAsset {
  return { bytes: new ArrayBuffer(size), byteLength: size, mime: 'image/png', kind: 'image' }
}
export function discover(requestId = 'discover', sessionId = 'session'): Extract<WorkerRequest, { type: 'discover' }> {
  return { type: 'discover', requestId, sessionId,
    input: { source: { kind: 'unixfs', ref, browse: false } },
    config: { gateways: ['https://gateway.example'], limits: { ...DEFAULT_LIMITS } } }
}
export function load(requestId: string, sessionId = 'session'): Extract<WorkerRequest, { type: 'asset' }> {
  return { type: 'asset', requestId, sessionId, ref }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export class FakeWorker {
  readonly sent: WorkerRequest[] = []
  terminated = false
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let listeners = this.listeners.get(type)
    if (!listeners) this.listeners.set(type, listeners = new Set())
    listeners.add(listener)
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(request: WorkerRequest): void { this.sent.push(structuredClone(request)) }
  terminate(): void { this.terminated = true }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      const event = { data } as MessageEvent<unknown>
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }
  respond(request: WorkerRequest, value: GalleryResult | VerifiedAsset | null = null): void {
    this.emit('message', { type: 'result', sessionId: request.sessionId,
      requestId: request.requestId, op: request.type, value })
  }
  response(message: WorkerResponse): void { this.emit('message', message) }
  asWorker(): Worker { return this as unknown as Worker }
}
