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
  const limits = { ...config.limits, maxBlockBytes: Math.min(config.limits.maxBlockBytes, 4 * 1024 * 1024), maxBlockCacheBytes: 0,
    maxBlockConcurrency: Math.min(config.limits.maxBlockConcurrency, 6), maxGatewayConcurrency: Math.min(config.limits.maxGatewayConcurrency, 2) }
  const fallback = createGatewayBroker({ gateways: [...config.gateways], limits }, {
    fetch: options.fetch, now: () => Date.now(), random: Math.random, settleOnAbort: true,
  })
  const transport = options.transport ?? createDirectTransport(options.policy)
  const active = new Set<AbortController>()
  const pending = new Set<Promise<void>>()
  let disposed = false
  let cleanupFailure: DirectCleanupError | undefined

  async function direct(cid: CID, signal: AbortSignal): Promise<Uint8Array> {
    const providers = await findProviders(cid, signal, { fetch: options.fetch, endpoint: options.router, policy: options.policy })
    let failure: GalleryDomainError | undefined
    for (const kind of ['wss', 'https'] as const) {
      for (const provider of providers) for (const address of provider.addresses) {
        if (address.kind !== kind) continue
        try {
          checkSignal(signal)
          const bytes = kind === 'wss'
            ? await transport.retrieve(cid, provider, address.address, signal)
            : await fetchBounded(options.fetch, `${address.url}/ipfs/${cid.toV1()}?format=raw`, 'application/vnd.ipld.raw, application/octet-stream', limits.maxBlockBytes, signal)
          // A transport's interoperability cap is a candidate failure, not a
          // request-admission LIMIT; an HTTPS candidate may serve larger blocks.
          if (bytes.byteLength > limits.maxBlockBytes) throw networkError('NETWORK', '候选块超过上限。')
          await verifyBlock(cid, bytes, limits.maxBlockBytes)
          checkSignal(signal)
          return bytes
        } catch (value) {
          if (value instanceof DirectCleanupError) throw value
          const error = signal.aborted ? cancellationError(signal.reason) : domainError(value)
          if (terminal(error)) throw error
          failure = important(failure, error)
          if (signal.aborted) throw failure
        }
      }
    }
    throw failure ?? networkError('NOT_FOUND', '没有可用 Provider。')
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
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      if (active.size >= limits.maxBlockConcurrency) throw networkError('LIMIT', 'Binding 块读取容量不足。')
      const controller = new AbortController()
      const forward = () => controller.abort(cancellationError(signal.reason))
      signal.addEventListener('abort', forward, { once: true })
      active.add(controller)
      const timer = setTimeout(() => controller.abort(networkError('TIMEOUT', '块读取总期限已到。')), limits.blockTimeoutMs)
      const directController = new AbortController()
      const directSignal = AbortSignal.any([controller.signal, directController.signal])
      const directTimer = setTimeout(() => directController.abort(networkError('TIMEOUT', 'Provider 阶段期限已到。')), Math.min(10000, limits.blockTimeoutMs))
      let failure: GalleryDomainError | undefined
      const remember = (bytes: Uint8Array) => {
        checkSignal(controller.signal)
        if (cleanupFailure) throw cleanupFailure
        if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
        cache.set(key, bytes)
        return bytes
      }
      try {
        checkSignal(signal)
        try { return remember(await direct(cid, directSignal)) } catch (value) {
          if (value instanceof DirectCleanupError) throw value
          checkSignal(controller.signal)
          failure = domainError(value)
          if (terminal(failure)) throw failure
        } finally { clearTimeout(directTimer) }
        // direct() must be fully settled before the gateway phase is admitted.
        checkSignal(controller.signal)
        try {
          const bytes = await fallback.get(key, controller.signal)
          const origin = brokerConfiguredGatewayEvidence(fallback, key, bytes)
          if (origin) {
            checkSignal(controller.signal)
            if (cleanupFailure) throw cleanupFailure
            if (disposed) throw networkError('CANCELLED', '块读取器已释放。')
            evidence.set(bytes, origin)
            return bytes
          }
          return remember(bytes)
        } catch (value) {
          if (value instanceof DirectCleanupError) throw value
          checkSignal(controller.signal)
          const error = domainError(value)
          if (terminal(error)) throw error
          throw important(failure, error)
        }
      } catch (error) {
        if (error instanceof DirectCleanupError) {
          cleanupFailure ??= error
          controller.abort(error)
          cache.clear()
          throw error
        }
        if (controller.signal.aborted) throw cancellationError(controller.signal.reason)
        throw error
      } finally {
        clearTimeout(timer)
        clearTimeout(directTimer)
        signal.removeEventListener('abort', forward)
        active.delete(controller)
      }
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
    snapshot: () => fallback.snapshot(),
    dispose() {
      if (disposed) return
      disposed = true
      gatewayResults.delete(source)
      cache.clear()
      for (const controller of active) controller.abort(networkError('CANCELLED', '块读取器已释放。'))
      transport.dispose()
      fallback.dispose()
    },
  }
  gatewayResults.set(source, evidence)
  return source
}
