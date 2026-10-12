import type {
  GalleryClient,
  GalleryError,
  GalleryResult,
  VerifiedAsset,
  WorkerRequest,
  WorkerResponse,
} from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { DEFAULT_LIMITS } from '../shared/limits'
import { MAX_PENDING_REQUESTS, MAX_REQUEST_IDS, record, validIdentity } from './protocol'

type Event = Extract<WorkerResponse, { type: 'progress' | 'telemetry' }>
type Value = GalleryResult | VerifiedAsset | null
interface Pending {
  request: WorkerRequest
  resolve: (value: Value) => void
  reject: (error: GalleryDomainError) => void
  sent: boolean
}

const cancellation = (): GalleryDomainError => new GalleryDomainError({
  code: 'CANCELLED', message: '操作已取消。', retryable: false,
})
const failure = (): GalleryDomainError => new GalleryDomainError({
  code: 'INTERNAL', message: 'Worker 通信失败，请重试。', retryable: true,
})
const invalid = (): GalleryDomainError => new GalleryDomainError({
  code: 'INVALID_INPUT', message: '请求标识或会话无效。', retryable: false,
})
const limit = (): GalleryDomainError => new GalleryDomainError({
  code: 'LIMIT', message: '待处理请求达到上限。', retryable: false,
})

/** Resolving an asset precedes releasing its slot, so synchronous consumers run before the next send. */
export function createGalleryClient(workerFactory: () => Worker = () => new Worker(
  new URL('./gallery.worker.ts', import.meta.url), { type: 'module' },
)): GalleryClient {
  let worker: Worker | undefined
  let cleanup: (() => void) | undefined
  let activeSession: string | undefined
  let closed = false
  let sentAssets = 0
  let pumpScheduled = false
  const pending = new Map<string, Pending>()
  const seen = new Set<string>()
  const queue: Pending[] = []
  const listeners = new Set<(event: Event) => void>()

  function terminate(): void {
    cleanup?.()
    cleanup = undefined
    worker?.terminate()
    worker = undefined
  }

  function settleAll(error: GalleryDomainError): void {
    for (const task of pending.values()) task.reject(error)
    pending.clear()
    queue.length = 0
    // Held successful results still release their own slot in the next microtask.
    sentAssets = 0
  }

  function crashed(): void {
    terminate()
    activeSession = undefined
    settleAll(failure())
  }

  function send(task: Pending): void {
    task.sent = true
    if (task.request.type === 'asset') sentAssets++
    try {
      getWorker().postMessage(task.request)
    } catch {
      crashed()
    }
  }

  function schedulePump(): void {
    if (pumpScheduled) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }

  function pump(): void {
    while (!closed && sentAssets < DEFAULT_LIMITS.maxAssetConcurrency && queue.length > 0) {
      const task = queue.shift()!
      if (!pending.has(task.request.requestId)) continue
      if (task.request.sessionId !== activeSession) {
        pending.delete(task.request.requestId)
        task.reject(cancellation())
      } else {
        send(task)
      }
    }
  }

  function releaseAsset(task: Pending, source: Worker): void {
    if (!task.sent || task.request.type !== 'asset') return
    queueMicrotask(() => {
      // A crash may have reset the counter and installed a different worker.
      if (worker === source) sentAssets--
      schedulePump()
    })
  }

  function message(source: Worker, data: unknown): void {
    if (source !== worker || !record(data) || !validIdentity(data.sessionId)
      || !validIdentity(data.requestId)) return
    const task = pending.get(data.requestId)
    if (!task?.sent || task.request.sessionId !== data.sessionId) return
    if (data.type === 'progress' || data.type === 'telemetry') {
      if (data.sessionId !== activeSession || (task.request.type !== 'discover' && task.request.type !== 'asset')) return
      for (const listener of listeners) listener(data as unknown as Event)
      return
    }
    if (data.type !== 'result' && data.type !== 'error') return
    if (data.type === 'result' && data.op !== task.request.type) return
    pending.delete(data.requestId)
    if (data.type === 'error') {
      const error = record(data.error) && typeof data.error.code === 'string'
        && typeof data.error.message === 'string' && typeof data.error.retryable === 'boolean'
        ? new GalleryDomainError(data.error as unknown as GalleryError) : failure()
      task.reject(error)
    } else if ((task.request.type === 'discover' || task.request.type === 'asset')
      && data.sessionId !== activeSession) {
      task.reject(cancellation())
    } else {
      task.resolve(data.value as Value)
    }
    releaseAsset(task, source)
    if (task.request.type === 'dispose') {
      settleAll(cancellation())
      terminate()
      listeners.clear()
    }
  }

  function getWorker(): Worker {
    if (worker) return worker
    const created = workerFactory()
    worker = created
    const onMessage = (event: MessageEvent<unknown>): void => message(created, event.data)
    const onFailure = (): void => { if (worker === created) crashed() }
    created.addEventListener('message', onMessage)
    created.addEventListener('error', onFailure)
    created.addEventListener('messageerror', onFailure)
    cleanup = () => {
      created.removeEventListener('message', onMessage)
      created.removeEventListener('error', onFailure)
      created.removeEventListener('messageerror', onFailure)
    }
    return created
  }

  function atCapacity(type: WorkerRequest['type']): boolean {
    const cap = MAX_PENDING_REQUESTS + (type === 'dispose' ? 9 : type === 'cancel' ? 8 : 0)
    return pending.size >= cap || (seen.size >= MAX_REQUEST_IDS && type !== 'dispose')
  }

  function register(request: WorkerRequest): Promise<Value> {
    if (closed) return Promise.reject(cancellation())
    if (!validIdentity(request.sessionId) || !validIdentity(request.requestId)
      || seen.has(request.requestId)) return Promise.reject(invalid())
    if (atCapacity(request.type)) return Promise.reject(limit())
    seen.add(request.requestId)
    return new Promise((resolve, reject) => {
      const task: Pending = { request, resolve, reject, sent: false }
      pending.set(request.requestId, task)
      if (request.type === 'dispose') closed = true
      if (request.type === 'asset') {
        if (activeSession !== request.sessionId) {
          pending.delete(request.requestId)
          reject(invalid())
          return
        }
        queue.push(task)
        pump()
      } else {
        send(task)
      }
    })
  }

  function cancelQueued(sessionId: string, targetRequestId?: string): void {
    for (let index = queue.length - 1; index >= 0; index--) {
      const task = queue[index]!
      if (task.request.sessionId !== sessionId
        || (targetRequestId !== undefined && task.request.requestId !== targetRequestId)) continue
      queue.splice(index, 1)
      pending.delete(task.request.requestId)
      task.reject(cancellation())
    }
  }

  return {
    discover(request) {
      if (closed || !validIdentity(request.sessionId) || !validIdentity(request.requestId)
        || seen.has(request.requestId)) return Promise.reject(closed ? cancellation() : invalid())
      if (atCapacity(request.type)) return Promise.reject(limit())
      if (activeSession !== undefined) cancelQueued(activeSession)
      activeSession = request.sessionId
      return register(request) as Promise<GalleryResult>
    },
    loadAsset(request) {
      return register(request) as Promise<VerifiedAsset>
    },
    cancel(request) {
      if (closed || !validIdentity(request.sessionId) || !validIdentity(request.requestId)
        || !validIdentity(request.targetRequestId) || request.targetRequestId === request.requestId
        || seen.has(request.requestId)) return Promise.reject(closed ? cancellation() : invalid())
      if (atCapacity(request.type)) return Promise.reject(limit())
      cancelQueued(request.sessionId, request.targetRequestId)
      return register(request).then(() => undefined)
    },
    dispose(request) {
      if (closed) return Promise.resolve()
      if (!validIdentity(request.sessionId) || !validIdentity(request.requestId)
        || seen.has(request.requestId)) return Promise.reject(invalid())
      const promise = register(request)
      if (!pending.has(request.requestId)) return promise.then(() => undefined)
      for (const task of [...queue]) cancelQueued(task.request.sessionId, task.request.requestId)
      return promise.then(() => undefined)
    },
    subscribe(listener) {
      if (!closed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
