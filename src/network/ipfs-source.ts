import type { CID } from 'multiformats/cid'
import type { SessionConfig } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { brokerConfiguredGatewayEvidence, createGatewayBroker, type ConfiguredGatewayEvidence } from './broker'
import { VerifiedBlockCache } from './cache'
import { fetchBounded } from './direct-http'
import { createDirectTransport, DirectCleanupError, type DirectTransport } from './direct-transport'
import { cancellationError, checkSignal, networkError } from './errors'
import { publicProviderAddress, type ProviderAddressPolicy } from './provider-policy'
import { DELEGATED_ROUTER, findProviders } from './provider-routing'
import type { VerifiedBlockSource } from './types'
import { parseBlockCid, verifyBlock } from './verify'
import { MAINTENANCE_BLOCK_BYTES, SourceScheduler, sourceBudget, type Candidate } from './source-scheduler'

export interface IpfsSourceOptions {
  fetch: typeof globalThis.fetch
  router: string
  policy: ProviderAddressPolicy
  transport?: DirectTransport
}

const domainError = (value: unknown) => value instanceof GalleryDomainError ? value : networkError('NETWORK', 'Provider 读取失败。')
function important(first: GalleryDomainError | undefined, second: GalleryDomainError): GalleryDomainError {
  return first?.error.code === 'INTEGRITY' ? first : second
}
const terminal = (error: GalleryDomainError) => ['CANCELLED', 'INVALID_INPUT', 'LIMIT'].includes(error.error.code)
function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return
  const trimmed = value.trim()
  const delay = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 120_000) : undefined
}
class MaintenanceOversize extends Error {}
const gatewayResults = new WeakMap<VerifiedBlockSource, WeakMap<Uint8Array, ConfiguredGatewayEvidence>>()

/** Compile-time gateway exception admission: source identity, canonical CID and the exact returned object must match. */
export function configuredGatewayEvidence(source: VerifiedBlockSource, canonicalCid: string,
  exactBytes: Uint8Array): ConfiguredGatewayEvidence | undefined {
  const evidence = gatewayResults.get(source)?.get(exactBytes)
  return evidence?.canonicalCid === canonicalCid && evidence.byteLength === exactBytes.byteLength ? evidence : undefined
}

/** Production policy has no message, query, preference or environment override. */
export function createIpfsBlockSource(config: SessionConfig): VerifiedBlockSource {
  return createIpfsBlockSourceWithOptions(config, { fetch: globalThis.fetch.bind(globalThis), router: DELEGATED_ROUTER, policy: publicProviderAddress })
}

/** Explicit construction seam for isolated fixture entries, never user configuration. */
export function createIpfsBlockSourceWithOptions(config: SessionConfig, options: IpfsSourceOptions): VerifiedBlockSource & { settled(): Promise<void> } {
  const evidence = new WeakMap<Uint8Array, ConfiguredGatewayEvidence>()
  if (!Number.isSafeInteger(config.limits.maxBlockCacheBytes) || config.limits.maxBlockCacheBytes < 0) throw networkError('INVALID_INPUT', '缓存上限无效。')
  const cache = new VerifiedBlockCache(config.limits.maxBlockCacheBytes)
  const limits = { ...config.limits, blockTimeoutMs: Math.min(config.limits.blockTimeoutMs, 120_000),
    gatewayTimeoutMs: Math.min(config.limits.gatewayTimeoutMs, 30_000), maxBlockBytes: Math.min(config.limits.maxBlockBytes, 4 * 1024 * 1024), maxBlockCacheBytes: 0,
    maxBlockConcurrency: Math.min(config.limits.maxBlockConcurrency, 6), maxGatewayConcurrency: Math.min(config.limits.maxGatewayConcurrency, 2) }
  const fallback = createGatewayBroker({ gateways: [...config.gateways], limits }, {
    fetch: options.fetch, now: () => Date.now(), random: Math.random, settleOnAbort: true,
  })
  const transport = options.transport ?? createDirectTransport(options.policy)
  const active = new Set<AbortController>()
  const pending = new Set<Promise<void>>()
  let disposed = false
  let cleanupFailure: DirectCleanupError | undefined

  const scheduler = new SourceScheduler([...config.gateways])
  const shutdown = new AbortController()
  const maintenance = new Set<Promise<void>>()
  const routes = new Map<string, { due: number; interval: number }>()
  const recent = new Set<string>()
  const maintenanceCids = new Map<string, boolean>()
  let rootCursor = 0
  let recentCursor = 0
  let maintenanceTurn = 0
  let healthTurn = 0

  function rememberMaintenanceCid(key: string, verified: boolean): void {
    const strict = (maintenanceCids.get(key) ?? false) || verified
    maintenanceCids.delete(key)
    maintenanceCids.set(key, strict)
    if (maintenanceCids.size > 32) maintenanceCids.delete(maintenanceCids.keys().next().value!)
  }

  async function route(cid: CID, signal: AbortSignal, background: boolean): Promise<void> {
    const key = cid.toV1().toString()
    const previous = routes.get(key)
    if (previous && previous.due > Date.now()) return
    const release = sourceBudget.route(background)
    if (!release) return
    const state = previous ?? { due: 0, interval: 15_000 }
    routes.delete(key); routes.set(key, state)
    if (routes.size > 132) routes.delete(routes.keys().next().value!)
    state.due = Date.now() + 15_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', 'Provider 发现期限已到。')), Math.min(30_000, limits.blockTimeoutMs))
    let clean = true
    try {
      const providers = await findProviders(cid, AbortSignal.any([signal, shutdown.signal, controller.signal]),
        { fetch: options.fetch, endpoint: options.router, policy: options.policy })
      state.interval = scheduler.providers(providers, key) || !providers.length ? 15_000 : Math.min(300_000, state.interval * 1.5)
    } catch (error) {
      state.interval = Math.max(15_000, state.interval / 2)
      if (error instanceof DirectCleanupError) { clean = false; cleanupFailure ??= error; throw error }
    } finally {
      clearTimeout(timer)
      state.due = Date.now() + state.interval
      if (clean) release()
    }
  }

  async function attempt(cid: CID, candidate: Candidate, signal: AbortSignal): Promise<Uint8Array> {
    if (candidate.gateway) return fallback.getFrom(candidate.gateway, cid.toV1().toString(), signal)
    const address = candidate.address!
    const bytes = address.kind === 'wss'
      ? await transport.retrieve(cid, candidate.provider!, address.address, signal)
      : await fetchBounded(options.fetch, `${address.url}/ipfs/${cid.toV1()}?format=raw`,
        'application/vnd.ipld.raw, application/octet-stream', limits.maxBlockBytes, signal)
    if (bytes.byteLength > limits.maxBlockBytes) throw networkError('NETWORK', '候选块超过上限。')
    await verifyBlock(cid, bytes, limits.maxBlockBytes)
    return bytes
  }

  async function probe(cid: CID, signal: AbortSignal): Promise<boolean> {
    checkSignal(signal)
    checkSignal(shutdown.signal)
    const key = cid.toV1().toString()
    const candidate = scheduler.health(key)
    if (!candidate) return false
    const release = sourceBudget.probe()
    if (!release) return false
    candidate.inFlight++
    const penalty = candidate.penalty
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', '健康采样期限已到。')),
      Math.min(30_000, limits.gatewayTimeoutMs))
    const operationSignal = AbortSignal.any([signal, shutdown.signal, controller.signal])
    let clean = true
    let retryMs: number | undefined
    const probeFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await options.fetch(input, init)
      if (response.status === 429 || response.status === 503) retryMs = retryAfter(response.headers.get('retry-after'), Date.now())
      return response
    }
    try {
      const url = candidate.gateway ?? candidate.address!.url
      const bytes = await fetchBounded(probeFetch, `${url}/ipfs/${cid.toV1()}?format=raw`,
        'application/vnd.ipld.raw, application/octet-stream', MAINTENANCE_BLOCK_BYTES, operationSignal,
        undefined, () => new MaintenanceOversize())
      await verifyBlock(cid, bytes, MAINTENANCE_BLOCK_BYTES)
      checkSignal(operationSignal)
      scheduler.success(candidate, Date.now() - started, penalty)
      scheduler.checked(candidate)
      if (!candidate.gateway) scheduler.confirm(candidate, key)
    } catch (value) {
      if (value instanceof DirectCleanupError) {
        clean = false
        cleanupFailure ??= value
        throw value
      }
      if (value instanceof MaintenanceOversize) scheduler.checked(candidate, 60_000)
      else {
        const error = operationSignal.aborted ? cancellationError(operationSignal.reason) : domainError(value)
        scheduler.failure(candidate, error.error, Date.now() - started)
        scheduler.checked(candidate)
        if (retryMs !== undefined) {
          candidate.cooldown = Math.max(candidate.cooldown, Date.now() + retryMs)
          candidate.healthDue = Math.max(candidate.healthDue, candidate.cooldown)
        }
      }
    } finally {
      clearTimeout(timer)
      if (clean) { candidate.inFlight--; release() }
    }
    return true
  }

  async function load(value: string, signal: AbortSignal): Promise<Uint8Array> {
      checkSignal(signal)
      if (cleanupFailure) throw cleanupFailure
      if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
      const cid = parseBlockCid(value, limits.maxBlockBytes)
      const key = cid.toV1().toString()
      if (cid.multihash.code === 0) {
        const bytes = cid.multihash.digest.slice()
        await verifyBlock(cid, bytes, limits.maxBlockBytes)
        checkSignal(signal)
        if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
        return bytes
      }
      recent.delete(key); recent.add(key)
      if (recent.size > 32) recent.delete(recent.values().next().value!)
      const cached = cache.get(key)
      if (cached !== undefined) {
        if (cached.byteLength <= MAINTENANCE_BLOCK_BYTES) rememberMaintenanceCid(key, true)
        return cached
      }
      if (active.size >= limits.maxBlockConcurrency) throw networkError('LIMIT', 'Binding 块读取容量不足。')
      const controller = new AbortController()
      const forward = () => controller.abort(cancellationError(signal.reason))
      signal.addEventListener('abort', forward, { once: true })
      active.add(controller)
      const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', '块读取总期限已到。')), limits.blockTimeoutMs)
      const attempts = new Map<string, Promise<void>>()
      const attempted = new Map<string, number>()
      const missing = new Set<string>()
      let winner: Uint8Array | undefined
      let failure: GalleryDomainError | undefined
      let fatal: unknown
      let nextHedge = Infinity
      let wake = () => {}
      const changed = () => wake()
      const unsubscribe = sourceBudget.subscribe(changed)
      controller.signal.addEventListener('abort', changed)
      const routing = route(cid, controller.signal, false).catch(error => { fatal = error }).finally(changed)
      let routingDone = false
      void routing.then(() => { routingDone = true; changed() })
      let releaseWaiting: (() => void) | undefined = sourceBudget.waiting()
      const launch = (candidate: Candidate, release: () => void) => {
        releaseWaiting?.(); releaseWaiting = undefined
        candidate.inFlight++
        attempted.set(candidate.key, Date.now())
        const penalty = candidate.penalty
        const started = Date.now()
        nextHedge = started + scheduler.soft(candidate)
        const attemptController = new AbortController()
        const attemptTimer = setTimeout(() => attemptController.abort(networkError('TIMEOUT', '候选读取期限已到。')), Math.min(30_000, limits.gatewayTimeoutMs))
        const attemptSignal = AbortSignal.any([controller.signal, attemptController.signal])
        let clean = true
        const task = attempt(cid, candidate, attemptSignal).then(bytes => {
          checkSignal(attemptSignal)
          scheduler.success(candidate, Date.now() - started, penalty)
          scheduler.confirm(candidate, key)
          winner ??= bytes
          controller.abort(networkError('CANCELLED', '备选请求已完成。'))
        }).catch(value => {
          if (value instanceof DirectCleanupError) { clean = false; cleanupFailure ??= value; fatal = value; controller.abort(value); return }
          const error = attemptSignal.aborted ? cancellationError(attemptSignal.reason) : domainError(value)
          scheduler.failure(candidate, error.error, Date.now() - started)
          if (candidate.gateway && error.error.code !== 'CANCELLED') {
            const cooldown = fallback.snapshot().find(gateway => gateway.url === candidate.gateway)?.cooldownUntil
            candidate.cooldown = Math.max(candidate.cooldown, cooldown ?? 0)
          }
          if (!controller.signal.aborted) {
            failure = important(failure, error)
            if (error.error.code === 'NOT_FOUND') missing.add(candidate.key)
            else if (terminal(error)) { fatal = error; controller.abort(error) }
          }
        }).finally(() => {
          clearTimeout(attemptTimer)
          if (clean) { candidate.inFlight--; release() }
          attempts.delete(candidate.key); changed()
        })
        attempts.set(candidate.key, task)
      }
      let outcome: { bytes: Uint8Array } | { error: unknown }
      try {
        while (!winner && !fatal) {
          checkSignal(controller.signal)
          const excluded = new Set([...missing, ...attempts.keys()])
          for (const [candidate, at] of attempted) if (Date.now() - at < 1000) excluded.add(candidate)
          const candidate = scheduler.choose(excluded, limits.maxGatewayConcurrency, key)
          if (candidate && attempts.size < Math.min(2, limits.maxBlockConcurrency) &&
            (!attempts.size || Date.now() >= nextHedge)) {
            const release = sourceBudget.attempt(limits.maxBlockBytes * 2, attempts.size > 0)
            if (release) { launch(candidate, release); continue }
          }
          if (!attempts.size && routingDone && [...scheduler.candidates.keys()].every(candidate => missing.has(candidate))) break
          if (!attempts.size && !releaseWaiting) releaseWaiting = sourceBudget.waiting()
          const now = Date.now()
          const deadlines = [...scheduler.candidates.values()].flatMap(candidate => [candidate.cooldown,
            (attempted.get(candidate.key) ?? -Infinity) + 1000])
          if (attempts.size === 1) deadlines.push(nextHedge)
          const next = Math.min(...deadlines.filter(time => time > now))
          await new Promise<void>(resolve => {
            const timer = Number.isFinite(next) ? setTimeout(done, next - now) : undefined
            function done() { clearTimeout(timer); wake = () => {}; resolve() }
            wake = done
          })
        }
        if (fatal) throw fatal
        if (!winner) throw failure ?? networkError('NOT_FOUND', '没有可用来源。')
        outcome = { bytes: winner }
      } catch (error) {
        outcome = { error: cleanupFailure ?? (controller.signal.aborted && !winner
          ? failure?.error.code === 'INTEGRITY' ? failure : cancellationError(controller.signal.reason) : error) }
      } finally {
        controller.abort(networkError('CANCELLED', '请求结束。'))
        releaseWaiting?.(); unsubscribe()
        controller.signal.removeEventListener('abort', changed)
        await Promise.all([...attempts.values(), routing])
        clearTimeout(timer)
        signal.removeEventListener('abort', forward)
        active.delete(controller)
      }
      if (cleanupFailure) throw cleanupFailure
      if ('error' in outcome) throw outcome.error
      checkSignal(signal)
      if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
      const origin = brokerConfiguredGatewayEvidence(fallback, key, outcome.bytes)
      if (outcome.bytes.byteLength <= MAINTENANCE_BLOCK_BYTES) rememberMaintenanceCid(key, origin === undefined)
      if (origin) evidence.set(outcome.bytes, origin)
      else cache.set(key, outcome.bytes)
      return outcome.bytes
  }

  const source: VerifiedBlockSource & { settled(): Promise<void> } = {
    get(value, signal) {
      const result = load(value, signal)
      const cleanup = result.then(() => {}, error => { if (error instanceof DirectCleanupError) throw error })
      pending.add(cleanup)
      void cleanup.then(() => pending.delete(cleanup), () => pending.delete(cleanup))
      return result
    },
    async settled() {
      const outcomes = await Promise.allSettled([...pending, transport.settled?.()])
      if (cleanupFailure) throw cleanupFailure
      const failure = outcomes.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
    async drained() {
      await source.settled()
      const outcomes = await Promise.allSettled([...maintenance, transport.drained?.() ?? transport.settled?.()])
      if (cleanupFailure) throw cleanupFailure
      const failure = outcomes.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
    maintain(roots, signal) {
      if (disposed || cleanupFailure || (!roots.length && !recent.size) || active.size || maintenance.size) return Promise.resolve()
      const useRecent = recent.size > 0 && (!roots.length || ++maintenanceTurn % 2 === 0)
      const available = useRecent ? [...recent] : roots
      const verified = available.filter(cid => maintenanceCids.get(cid) === true)
      const observed = available.filter(cid => maintenanceCids.get(cid) === false)
      const known = [...verified, ...observed]
      const pool = known.length ? known : available
      const index = useRecent ? recentCursor++ : rootCursor++
      const cid = parseBlockCid(pool[index % pool.length]!, limits.maxBlockBytes)
      if (cid.multihash.code === 0) return Promise.resolve()
      scheduler.prune()
      const key = cid.toV1().toString()
      const healthFirst = maintenanceCids.has(key) && ++healthTurn % 2 === 0
      const task = (async () => {
        if (healthFirst) {
          const [sampled] = await Promise.all([probe(cid, signal), transport.maintain?.()])
          if (sampled || signal.aborted) return
          await route(cid, signal, true)
          return
        }
        await Promise.all([route(cid, signal, true), transport.maintain?.()])
        if (!signal.aborted && maintenanceCids.has(key)) await probe(cid, signal)
      })().catch(error => {
        if (error instanceof DirectCleanupError) { cleanupFailure ??= error; throw error }
        if (!signal.aborted) throw error
      })
      maintenance.add(task)
      void task.then(() => maintenance.delete(task), () => maintenance.delete(task))
      return task
    },
    snapshot: () => [...scheduler.candidates.values()].filter(candidate => candidate.gateway).map(candidate => ({
      url: candidate.gateway!, state: candidate.cooldown > Date.now() ? 'cooldown' : 'healthy',
      inFlight: candidate.inFlight, successes: candidate.totalSuccesses, failures: candidate.totalFailures,
      ewmaMs: candidate.latency, ...(candidate.cooldown ? { cooldownUntil: candidate.cooldown } : {}),
    })),
    dispose() {
      if (disposed) return
      disposed = true
      shutdown.abort(networkError('CANCELLED', '来源维护已释放。'))
      gatewayResults.delete(source)
      cache.clear()
      maintenanceCids.clear(); recent.clear(); routes.clear()
      for (const controller of active) controller.abort(networkError('CANCELLED', '块读取器已释放。'))
      transport.dispose()
      fallback.dispose()
    },
  }
  gatewayResults.set(source, evidence)
  return source
}
