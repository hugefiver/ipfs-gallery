import type { CID } from 'multiformats/cid'
import type { GatewayStat, SessionConfig } from '../shared/contracts'
import { BUILD_POLICY } from '../shared/build-policy'
import { GalleryDomainError } from '../shared/errors'
import { VerifiedBlockCache } from './cache'
import { DirectCleanupError } from './direct-errors'
import { cancelResponseBody as cancelBody, createReaderCancellation } from './direct-reader'
import { abortable, cancellationError, checkSignal, networkError } from './errors'
import { normalizeGateway } from './gateways'
import type { BrokerDependencies, VerifiedBlockSource } from './types'
import { parseBlockCid, verifyBlock } from './verify'
import { SourceScheduler } from './source-scheduler'

export { normalizeGateway } from './gateways'

interface Gateway extends GatewayStat { consecutiveFailures: number; penaltyVersion: number }
interface Flight {
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<BlockResult>
}
interface BlockResult { bytes: Uint8Array; gateway?: string }
export interface ConfiguredGatewayEvidence { readonly canonicalCid: string; readonly gateway: string; readonly byteLength: number }
const gatewayResults = new WeakMap<VerifiedBlockSource, WeakMap<Uint8Array, ConfiguredGatewayEvidence>>()

/** Read-only evidence for compile-time non-strict configured-gateway results; copies and other sources have none. */
export function brokerConfiguredGatewayEvidence(source: VerifiedBlockSource, canonicalCid: string,
  exactBytes: Uint8Array): ConfiguredGatewayEvidence | undefined {
  const evidence = gatewayResults.get(source)?.get(exactBytes)
  return evidence?.canonicalCid === canonicalCid && evidence.byteLength === exactBytes.byteLength ? evidence : undefined
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 120_000) : undefined
}

async function readBlock(response: Response, maxBytes: number, signal: AbortSignal, settleOnAbort = false): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (settleOnAbort && declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    await cancelBody(response)
    throw networkError('NETWORK', '原始块长度无效。')
  }
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    if (settleOnAbort) await cancelBody(response)
    else void response.body?.cancel().catch(() => {})
    throw networkError('LIMIT', '原始块超过字节上限。')
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const cancelReader = settleOnAbort ? createReaderCancellation(reader) : () => reader.cancel()
  let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024))
  let total = 0
  let complete = false
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    cancellation ??= cancelReader()
    void cancellation.catch(() => {})
    return cancellation
  }
  const onAbort = () => { void cancel() }
  if (settleOnAbort) signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      checkSignal(signal)
      const read = reader.read()
      const { value, done } = await (settleOnAbort ? read : abortable(read, signal))
      checkSignal(signal)
      if (done) { complete = true; break }
      total += value.byteLength
      if (total > maxBytes) throw networkError('LIMIT', '原始块超过字节上限。')
      if (total > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(total, buffer.byteLength * 2)))
        grown.set(buffer)
        buffer = grown
      }
      buffer.set(value, total - value.byteLength)
    }
    if (settleOnAbort && declared !== null && Number(declared) !== total) throw networkError('NETWORK', '原始块长度不匹配。')
    return buffer.slice(0, total)
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      if (!complete) {
        if (settleOnAbort) await cancel()
        else void cancel()
      }
      if (cancellation && settleOnAbort) await cancellation
    } finally { reader.releaseLock() }
  }
}

export interface GatewayBroker extends VerifiedBlockSource {
  getFrom(gateway: string, cid: string, signal: AbortSignal): Promise<Uint8Array>
}

export function createGatewayBroker(config: SessionConfig, dependencies: BrokerDependencies): GatewayBroker {
  const evidence = new WeakMap<Uint8Array, ConfiguredGatewayEvidence>()
  const fetchBlock = dependencies.fetch
  const limits = { ...config.limits }
  for (const key of ['maxGateways', 'maxBlockBytes', 'maxBlockConcurrency', 'maxGatewayConcurrency', 'gatewayTimeoutMs', 'blockTimeoutMs'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw networkError('INVALID_INPUT', '块读取上限无效。')
  }
  if (!Number.isSafeInteger(limits.maxBlockCacheBytes) || limits.maxBlockCacheBytes < 0) throw networkError('INVALID_INPUT', '缓存上限无效。')
  const urls = [...new Set(config.gateways.map(normalizeGateway))]
  if (!urls.length || urls.length > limits.maxGateways) throw networkError('INVALID_INPUT', '启用网关数量无效。')
  const gateways: Gateway[] = urls.map((url) => ({
    url, state: 'healthy', inFlight: 0, successes: 0, failures: 0, consecutiveFailures: 0, penaltyVersion: 0,
  }))
  const cache = new VerifiedBlockCache(limits.maxBlockCacheBytes)
  const flights = new Map<string, Flight>()
  const waiters = new Set<() => void>()
  let active = 0
  const scheduler = new SourceScheduler(urls, dependencies.now)
  let disposed = false
  let cleanupFailure: DirectCleanupError | undefined

  function notify(): void { for (const wake of [...waiters]) wake() }

  function wait(signal: AbortSignal, delay?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve() }
      const onAbort = () => {
        cleanup()
        try { checkSignal(signal) } catch (error) { reject(error) }
      }
      const timer = delay === undefined ? undefined : setTimeout(finish, Math.max(1, delay))
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        waiters.delete(finish)
        signal.removeEventListener('abort', onAbort)
      }
      waiters.add(finish)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  async function acquire(tried: Set<Gateway>, signal: AbortSignal): Promise<Gateway> {
    while (true) {
      checkSignal(signal)
      const now = dependencies.now()
      const remaining = gateways.filter((gateway) => !tried.has(gateway))
      const eligible = remaining.filter((gateway) => {
        if (gateway.state === 'probing') return false
        if (gateway.state === 'cooldown') return gateway.inFlight === 0 && (gateway.cooldownUntil ?? 0) <= now
        return gateway.inFlight < limits.maxGatewayConcurrency
      })
      if (active < limits.maxBlockConcurrency && eligible.length) {
        const excluded = new Set(gateways.filter(gateway => !eligible.includes(gateway)).map(gateway => `gateway:${gateway.url}`))
        const candidate = scheduler.choose(excluded, limits.maxGatewayConcurrency)
        const chosen = eligible.find(gateway => gateway.url === candidate?.gateway) ?? eligible[0]!
        if (chosen.state === 'cooldown') chosen.state = 'probing'
        active++
        chosen.inFlight++
        return chosen
      }
      const nextRecovery = active < limits.maxBlockConcurrency
        ? remaining.filter((gateway) => gateway.state === 'cooldown' && gateway.inFlight === 0 && (gateway.cooldownUntil ?? 0) > now)
            .map((gateway) => (gateway.cooldownUntil ?? now) - now)
        : []
      await wait(signal, nextRecovery.length ? Math.min(...nextRecovery) : undefined)
    }
  }

  function penalize(gateway: Gateway, error: GalleryDomainError, retryMs?: number): void {
    if (error.error.code === 'CANCELLED') {
      if (gateway.state === 'probing') gateway.state = 'cooldown'
      return
    }
    gateway.failures++
    if (error.error.code === 'NOT_FOUND') {
      if (gateway.state === 'probing') { gateway.state = 'healthy'; delete gateway.cooldownUntil }
      return
    }
    gateway.consecutiveFailures++
    gateway.penaltyVersion++
    const jitter = 1 + Math.max(0, Math.min(1, dependencies.random())) * 0.25
    const backoff = Math.min(60_000, 2000 * 2 ** Math.min(5, gateway.consecutiveFailures - 1) * jitter)
    const duration = error.error.code === 'INTEGRITY' ? Math.max(60_000, retryMs ?? 0) : Math.max(backoff, retryMs ?? 0)
    gateway.state = 'cooldown'
    gateway.cooldownUntil = Math.max(gateway.cooldownUntil ?? 0, dependencies.now() + duration)
  }

  async function attempt(cid: CID, gateway: Gateway, signal: AbortSignal): Promise<BlockResult> {
    const started = dependencies.now()
    const penaltyVersion = gateway.penaltyVersion
    const candidate = scheduler.candidates.get(`gateway:${gateway.url}`)!
    const samplePenalty = candidate.penalty
    candidate.inFlight++
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', '网关读取超时。', gateway.url)), limits.gatewayTimeoutMs)
    let retryMs: number | undefined
    try {
      if (signal.aborted) forwardAbort()
      checkSignal(controller.signal)
      const fetching = fetchBlock(`${gateway.url}/ipfs/${cid.toV1().toString()}?format=raw`, {
        method: 'GET', headers: { Accept: 'application/vnd.ipld.raw' }, signal: controller.signal,
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
      })
      const response = await (dependencies.settleOnAbort ? fetching : abortable(fetching, controller.signal))
      if (controller.signal.aborted) {
        if (dependencies.settleOnAbort) await cancelBody(response)
        else await response.body?.cancel()
        checkSignal(controller.signal)
      }
      let unsafeHeaders = false
      if (dependencies.settleOnAbort) {
        let headerBytes = 0
        let headerCount = 0
        for (const [name, value] of response.headers) {
          headerBytes += name.length + value.length
          if (++headerCount > 64 || headerBytes > 16 * 1024) { unsafeHeaders = true; break }
        }
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (type && !['application/vnd.ipld.raw', 'application/octet-stream'].includes(type)) unsafeHeaders = true
      }
      if (response.redirected || !response.ok || unsafeHeaders || response.type === 'opaque' || response.type === 'opaqueredirect') {
        if (dependencies.settleOnAbort) await cancelBody(response)
        else void response.body?.cancel().catch(() => {})
        if (response.status === 429 || response.status === 503) retryMs = retryAfter(response.headers.get('retry-after'), dependencies.now())
        throw networkError(response.status === 404 ? 'NOT_FOUND' : 'NETWORK', '网关未能返回原始块。', gateway.url)
      }
      const bytes = await readBlock(response, limits.maxBlockBytes, controller.signal, dependencies.settleOnAbort)
      if (BUILD_POLICY.trustless) {
        const verifying = verifyBlock(cid, bytes, limits.maxBlockBytes)
        await (dependencies.settleOnAbort ? verifying : abortable(verifying, controller.signal))
      }
      checkSignal(controller.signal)
      const elapsed = Math.max(1, dependencies.now() - started)
      scheduler.success(candidate, elapsed, samplePenalty)
      gateway.ewmaMs = gateway.ewmaMs === undefined ? elapsed : gateway.ewmaMs * 0.75 + elapsed * 0.25
      gateway.successes++
      if (gateway.penaltyVersion === penaltyVersion) {
        gateway.consecutiveFailures = 0
        gateway.state = 'healthy'
        delete gateway.cooldownUntil
      }
      return { bytes, ...(!BUILD_POLICY.trustless ? { gateway: gateway.url } : {}) }
    } catch (value) {
      if (value instanceof DirectCleanupError) {
        cleanupFailure ??= value
        controller.abort(value)
        cache.clear()
        throw value
      }
      const error = controller.signal.aborted
        ? cancellationError(controller.signal.reason, gateway.url)
        : value instanceof GalleryDomainError ? new GalleryDomainError({ ...value.error, gateway: gateway.url }) : networkError('NETWORK', '网关读取失败。', gateway.url)
      scheduler.failure(candidate, error.error, dependencies.now() - started)
      penalize(gateway, error, retryMs)
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
      candidate.inFlight--
      gateway.inFlight--
      active--
      notify()
    }
  }

  async function load(cid: CID, signal: AbortSignal): Promise<BlockResult> {
    if (cid.multihash.code === 0) {
      const bytes = cid.multihash.digest.slice()
      await abortable(verifyBlock(cid, bytes, limits.maxBlockBytes), signal)
      return { bytes }
    }
    const tried = new Set<Gateway>()
    let failure: GalleryDomainError | undefined
    const priority = { INTEGRITY: 5, LIMIT: 4, TIMEOUT: 3, NETWORK: 2, NOT_FOUND: 1 }
    while (tried.size < gateways.length) {
      const gateway = await acquire(tried, signal)
      tried.add(gateway)
      try { return await attempt(cid, gateway, signal) } catch (value) {
        if (value instanceof DirectCleanupError) throw value
        checkSignal(signal)
        const error = value as GalleryDomainError
        const rank = (code: string) => priority[code as keyof typeof priority] ?? 0
        if (failure === undefined || rank(error.error.code) > rank(failure.error.code)) failure = error
      }
    }
    throw failure ?? networkError('NETWORK', '没有可用网关。')
  }

  function newFlight(cid: CID, key: string): Flight {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', '块读取总期限已到。')), limits.blockTimeoutMs)
    const flight: Flight = { controller, consumers: new Set(), promise: Promise.resolve({ bytes: new Uint8Array() }) }
    flight.promise = load(cid, controller.signal).then((result) => {
      checkSignal(controller.signal)
      if (result.gateway === undefined) cache.set(key, result.bytes)
      return result
    }).finally(() => {
      clearTimeout(timer)
      if (flights.get(key) === flight) flights.delete(key)
    })
    flights.set(key, flight)
    return flight
  }

  const source: GatewayBroker = {
    async getFrom(url, value, signal) {
      checkSignal(signal)
      if (cleanupFailure) throw cleanupFailure
      if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
      const gateway = gateways.find(candidate => candidate.url === url)
      if (!gateway) throw networkError('INVALID_INPUT', '网关不属于当前配置。')
      if (active >= limits.maxBlockConcurrency || gateway.inFlight >= limits.maxGatewayConcurrency) throw networkError('LIMIT', '网关容量不足。')
      const cid = parseBlockCid(value, limits.maxBlockBytes)
      active++; gateway.inFlight++
      const result = await attempt(cid, gateway, signal)
      if (result.gateway !== undefined) evidence.set(result.bytes, Object.freeze({ canonicalCid: cid.toV1().toString(),
        gateway: result.gateway, byteLength: result.bytes.byteLength }))
      return result.bytes
    },
    async get(value, signal) {
      checkSignal(signal)
      if (cleanupFailure) throw cleanupFailure
      if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
      const cid = parseBlockCid(value, limits.maxBlockBytes)
      const key = cid.toV1().toString()
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const flight = flights.get(key) ?? newFlight(cid, key)
      const consumer = Symbol()
      flight.consumers.add(consumer)
      try {
        const result = await abortable(flight.promise, signal)
        checkSignal(signal)
        const bytes = result.bytes.slice()
        if (result.gateway !== undefined) evidence.set(bytes, Object.freeze({ canonicalCid: key,
          gateway: result.gateway, byteLength: bytes.byteLength }))
        return bytes
      } finally {
        flight.consumers.delete(consumer)
        if (flight.consumers.size === 0) {
          flight.controller.abort(networkError('CANCELLED', '所有块读取消费者均已取消。'))
          if (dependencies.settleOnAbort) await flight.promise.catch((error: unknown) => { if (error instanceof DirectCleanupError) throw error })
          else if (flights.get(key) === flight) flights.delete(key)
        }
      }
    },
    snapshot() {
      return gateways.map((gateway) => ({
        url: gateway.url, state: gateway.state, inFlight: gateway.inFlight,
        successes: gateway.successes, failures: gateway.failures,
        ...(gateway.ewmaMs === undefined ? {} : { ewmaMs: gateway.ewmaMs }),
        ...(gateway.cooldownUntil === undefined ? {} : { cooldownUntil: gateway.cooldownUntil }),
      }))
    },
    dispose() {
      if (disposed) return
      disposed = true
      gatewayResults.delete(source)
      for (const flight of flights.values()) flight.controller.abort(networkError('CANCELLED', '块读取器已释放。'))
      if (!dependencies.settleOnAbort) flights.clear()
      cache.clear()
      notify()
    },
  }
  gatewayResults.set(source, evidence)
  return source
}
