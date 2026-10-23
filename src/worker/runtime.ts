import type {
  ContentRef,
  GalleryError,
  GalleryInput,
  GalleryResult,
  SessionConfig,
  VerifiedAsset,
  WorkerRequest,
  WorkerResponse,
} from '../shared/contracts'
import type { ContentReader, DiscoveryOptions, GalleryProgress, OperationOptions } from '../core/types'
import type { VerifiedBlockSource } from '../network/types'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { DEFAULT_LIMITS } from '../shared/limits'
import { parseBlockCid } from '../network/verify'
import { identity, MAX_PENDING_REQUESTS, MAX_REQUEST_IDS, parseRequest, type Normalizers } from './protocol'

export interface RuntimeDependencies extends Normalizers {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  createBroker(config: SessionConfig, sessionId: string, roots: string[]): VerifiedBlockSource
  createReader(source: VerifiedBlockSource, options: { maxInputBytes: number }): ContentReader
  discover(input: GalleryInput, reader: ContentReader, options: DiscoveryOptions): Promise<GalleryResult>
  /** Returns an exact-length, exclusively owned buffer, never a broker/cache buffer. */
  readAsset(ref: ContentRef, reader: ContentReader, options: OperationOptions): Promise<VerifiedAsset>
  now?: () => number
}

interface Session {
  id: string
  config: SessionConfig
  broker: VerifiedBlockSource
}

interface Operation {
  request: Extract<WorkerRequest, { type: 'discover' | 'asset' }>
  session: Session
  controller: AbortController
  terminal: boolean
  timeout: ReturnType<typeof setTimeout>
  telemetry?: ReturnType<typeof setInterval>
}

interface Reservation {
  operation: Operation
  bytes: number
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  abort: () => void
}

const cancelled = (): GalleryError => ({ code: 'CANCELLED', message: '操作已取消。', retryable: false })
const limitError = (): GalleryError => ({ code: 'LIMIT', message: 'Worker 资源预算已达到上限。', retryable: false })

/** Owns one active session; cancelled work retains its resource slots until it actually exits. */
export class GalleryWorkerRuntime {
  private readonly dependencies: RuntimeDependencies
  private readonly now: () => number
  private session?: Session
  private closed = false
  private readonly operations = new Map<string, Operation>()
  private readonly running = new Set<Operation>()
  private readonly seen = new Set<string>()
  private readonly assets: Operation[] = []
  private activeAssets = 0
  private assemblyBytes = 0
  private readonly reservations: Reservation[] = []
  private lastProgress = -Infinity
  private lastTelemetry = -Infinity

  constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies
    this.now = dependencies.now ?? (() => performance.now())
  }

  usage() { return { activeAssets: this.activeAssets, assemblyBytes: this.assemblyBytes, running: this.running.size } }

  handleMessage(value: unknown): void {
    let request: WorkerRequest
    try {
      request = parseRequest(value, this.dependencies)
    } catch (error) {
      this.dependencies.postMessage({ type: 'error', ...identity(value), error: toGalleryError(error) })
      return
    }
    if (this.closed) {
      this.reject(request, cancelled())
      return
    }
    if (this.seen.has(request.requestId)) {
      this.reject(request, { code: 'INVALID_INPUT', message: '请求标识必须唯一。', retryable: false })
      return
    }
    if (this.seen.size >= MAX_REQUEST_IDS && request.type !== 'dispose') {
      this.reject(request, limitError())
      return
    }
    this.seen.add(request.requestId)
    if (request.type === 'dispose' || request.type === 'release-session') {
      if (request.type === 'dispose') this.closed = true
      const source = this.session?.id === request.sessionId || request.type === 'dispose' ? this.session?.broker : undefined
      if (source) this.cancelSession()
      void Promise.resolve(source?.drained?.()).then(() => {
        this.dependencies.postMessage({ type: 'result', ...identity(request), op: request.type, value: null })
      }, error => this.reject(request, toGalleryError(error)))
      return
    }
    if (request.type === 'cancel') {
      const target = this.operations.get(request.targetRequestId)
      if (target?.request.sessionId === request.sessionId) {
        if (target.request.type === 'discover') this.cancelSession()
        else this.stop(target, cancelled())
      }
      this.dependencies.postMessage({ type: 'result', ...identity(request), op: 'cancel', value: null })
      return
    }
    if (request.type === 'discover') {
      this.cancelSession()
      try {
        const source = request.input.source
        const refs = source.kind === 'cids' ? source.refs : [source.ref]
        const roots = [...new Set(refs.map(ref => parseBlockCid(ref.cid, request.config.limits.maxBlockBytes))
          .filter(cid => cid.multihash.code !== 0).map(cid => cid.toV1().toString()))]
        this.session = { id: request.sessionId, config: request.config,
          broker: this.dependencies.createBroker(request.config, request.sessionId, roots) }
      } catch (error) {
        this.reject(request, toGalleryError(error))
        return
      }
    }
    const session = this.session
    if (!session || session.id !== request.sessionId) {
      this.reject(request, { code: 'INVALID_INPUT', message: '资产请求不属于活动会话。', retryable: false })
      return
    }
    if (this.running.size >= MAX_PENDING_REQUESTS) {
      this.reject(request, limitError())
      return
    }
    const controller = new AbortController()
    const timeoutMs = request.type === 'discover'
      ? session.config.limits.discoveryTimeoutMs : session.config.limits.assetTimeoutMs
    const operation: Operation = { request, session, controller, terminal: false,
      timeout: setTimeout(() => this.stop(operation, {
        code: 'TIMEOUT', message: '读取超时，请重试。', retryable: true,
      }), timeoutMs) }
    this.operations.set(request.requestId, operation)
    this.running.add(operation)
    if (request.type === 'discover') {
      void this.runDiscovery(operation)
    } else {
      this.assets.push(operation)
      this.pumpAssets()
    }
  }

  private reject(request: Pick<WorkerRequest, 'sessionId' | 'requestId'>, error: GalleryError): void {
    this.dependencies.postMessage({ type: 'error', ...identity(request), error })
  }

  private finish(operation: Operation, response: WorkerResponse, transfer?: Transferable[]): void {
    if (operation.terminal) return
    operation.terminal = true
    clearTimeout(operation.timeout)
    if (operation.telemetry !== undefined) clearInterval(operation.telemetry)
    this.operations.delete(operation.request.requestId)
    this.dependencies.postMessage(response, transfer)
  }

  private stop(operation: Operation, error: GalleryError): void {
    if (operation.terminal) return
    operation.controller.abort(new GalleryDomainError(error))
    this.finish(operation, { type: 'error', ...identity(operation.request), error })
    const queued = this.assets.indexOf(operation)
    if (queued !== -1) {
      this.assets.splice(queued, 1)
      this.running.delete(operation)
    }
  }

  private cancelSession(): void {
    for (const operation of [...this.operations.values()]) this.stop(operation, cancelled())
    this.session?.broker.dispose()
    this.session = undefined
  }

  private progress(operation: Operation, event: GalleryProgress): void {
    if (operation.terminal || this.session !== operation.session) return
    const now = this.now()
    if (now - this.lastProgress < operation.session.config.limits.progressIntervalMs) return
    this.lastProgress = now
    this.dependencies.postMessage({ type: 'progress', ...identity(operation.request), ...event })
  }

  private telemetry(operation: Operation): void {
    if (operation.terminal || this.session !== operation.session) return
    const now = this.now()
    if (now - this.lastTelemetry < operation.session.config.limits.telemetryIntervalMs) return
    this.lastTelemetry = now
    this.dependencies.postMessage({ type: 'telemetry', ...identity(operation.request),
      gateways: operation.session.broker.snapshot() })
  }

  private startTelemetry(operation: Operation): void {
    this.telemetry(operation)
    operation.telemetry = setInterval(() => this.telemetry(operation),
      operation.session.config.limits.telemetryIntervalMs)
  }

  private async runDiscovery(operation: Operation): Promise<void> {
    try {
      this.startTelemetry(operation)
      const reader = this.dependencies.createReader(operation.session.broker, {
        maxInputBytes: operation.session.config.limits.maxDiscoveryInputBytes,
      })
      const request = operation.request as Extract<WorkerRequest, { type: 'discover' }>
      const value = await this.dependencies.discover(request.input, reader, {
        signal: operation.controller.signal, limits: operation.session.config.limits,
        onProgress: (event) => this.progress(operation, event),
      })
      this.finish(operation, { type: 'result', ...identity(request), op: 'discover', value })
    } catch (error) {
      this.finish(operation, { type: 'error', ...identity(operation.request), error: toGalleryError(error) })
    } finally {
      await this.settled(operation.session.broker)
      this.running.delete(operation)
    }
  }

  private async settled(source: VerifiedBlockSource): Promise<void> {
    try { await source.settled?.() }
    // Business terminal is separate; failed cleanup cannot become available capacity.
    catch { await new Promise<void>(() => {}) }
  }

  private pumpAssets(): void {
    while (this.assets.length > 0) {
      const next = this.assets[0]!
      if (this.activeAssets >= Math.min(DEFAULT_LIMITS.maxAssetConcurrency,
        next.session.config.limits.maxAssetConcurrency)) return
      this.assets.shift()
      if (next.terminal) continue
      this.activeAssets++
      void this.runAsset(next).finally(() => {
        this.running.delete(next)
        this.activeAssets--
        this.pumpAssets()
      })
    }
  }

  private reserve(operation: Operation, bytes: number): Promise<() => void> {
    const signal = operation.controller.signal
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const reservation: Reservation = { operation, bytes, resolve, reject, abort: () => {
        const index = this.reservations.indexOf(reservation)
        if (index !== -1) this.reservations.splice(index, 1)
        reject(signal.reason)
        this.pumpReservations()
      } }
      signal.addEventListener('abort', reservation.abort, { once: true })
      this.reservations.push(reservation)
      this.pumpReservations()
    })
  }

  private pumpReservations(): void {
    while (this.reservations.length > 0) {
      const reservation = this.reservations[0]!
      const cap = Math.min(DEFAULT_LIMITS.maxAssemblyBytes,
        reservation.operation.session.config.limits.maxAssemblyBytes)
      if (this.assemblyBytes + reservation.bytes > cap) return
      this.reservations.shift()
      reservation.operation.controller.signal.removeEventListener('abort', reservation.abort)
      this.assemblyBytes += reservation.bytes
      reservation.resolve(() => {
        this.assemblyBytes -= reservation.bytes
        this.pumpReservations()
      })
    }
  }

  private async runAsset(operation: Operation): Promise<void> {
    let release: (() => void) | undefined
    try {
      this.startTelemetry(operation)
      const request = operation.request as Extract<WorkerRequest, { type: 'asset' }>
      const signal = operation.controller.signal
      const reader = this.dependencies.createReader(operation.session.broker, {
        maxInputBytes: operation.session.config.limits.maxAssetInputBytes,
      })
      const stat = await reader.stat(request.ref, signal)
      signal.throwIfAborted()
      const limits = { ...operation.session.config.limits }
      let bytes: number
      if (stat.size !== undefined) {
        if (stat.size < 0n || stat.size > BigInt(limits.maxAssetBytes)
          || stat.size > BigInt(limits.maxAssemblyBytes)) throw new GalleryDomainError(limitError())
        bytes = Number(stat.size)
      } else {
        // Unknown-size readers may retain chunks while making the final contiguous copy.
        limits.maxAssetBytes = Math.min(limits.maxAssetBytes, Math.floor(limits.maxAssemblyBytes / 2))
        bytes = limits.maxAssetBytes * 2
      }
      release = await this.reserve(operation, bytes)
      signal.throwIfAborted()
      this.progress(operation, { phase: 'media', completed: 0 })
      const cachedStatReader: ContentReader = {
        stat: (ref, statSignal) => {
          statSignal.throwIfAborted()
          return ref.cid === request.ref.cid && JSON.stringify(ref.path) === JSON.stringify(request.ref.path)
            ? Promise.resolve(stat) : reader.stat(ref, statSignal)
        },
        ls: (ref, lsSignal) => reader.ls(ref, lsSignal),
        read: (ref, options) => reader.read(ref, options),
      }
      const value = await this.dependencies.readAsset(request.ref, cachedStatReader, { signal, limits })
      signal.throwIfAborted()
      if (!(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength !== value.byteLength
        || value.byteLength > limits.maxAssetBytes || value.byteLength > bytes
        || (stat.size !== undefined && value.byteLength !== Number(stat.size))) {
        throw new GalleryDomainError({ code: 'INTERNAL', message: '媒体组装结果违反缓冲区契约。', retryable: false })
      }
      this.finish(operation, { type: 'result', ...identity(request), op: 'asset', value }, [value.bytes])
    } catch (error) {
      this.finish(operation, { type: 'error', ...identity(operation.request), error: toGalleryError(error) })
    } finally {
      await this.settled(operation.session.broker)
      release?.()
    }
  }
}
