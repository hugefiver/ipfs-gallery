import { afterEach, expect, it, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { RuntimeDependencies } from '../../src/worker/runtime'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

const runtime = vi.hoisted(() => ({ dependencies: undefined as RuntimeDependencies | undefined }))
vi.mock('../../src/worker/runtime', () => ({
  GalleryWorkerRuntime: class {
    constructor(dependencies: RuntimeDependencies) { runtime.dependencies = dependencies }
    handleMessage = vi.fn()
  },
}))

afterEach(() => {
  runtime.dependencies = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

it('honors HTTP-date Retry-After in the production entry broker wiring', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'))
  vi.spyOn(performance, 'now').mockReturnValue(5000)
  const bytes = new TextEncoder().encode('production entry verified block')
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
  const retryAfter = new Date(Date.now() + 30_000).toUTCString()
  let attempts = 0
  const fetch = vi.fn<typeof globalThis.fetch>(async () => ++attempts === 1
    ? new Response(null, { status: 503, headers: { 'Retry-After': retryAfter } })
    : new Response(bytes.slice().buffer))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('addEventListener', vi.fn())
  // The spy observes the injected clock while calling the real broker constructor.
  const brokerModule = await import('../../src/network/broker')
  const createBroker = vi.spyOn(brokerModule, 'createGatewayBroker')
  await import('../../src/worker/gallery.worker')
  if (runtime.dependencies === undefined) throw new Error('Production entry did not create a runtime')
  const gateways = DEFAULT_GATEWAYS.slice(0, 2)
  const source = runtime.dependencies.createBroker({ gateways, limits: { ...DEFAULT_LIMITS } })
  try {
    expect(await source.get(cid, new AbortController().signal)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.map(([input]) => new URL(input.toString()).origin)).toEqual(gateways)
    const stats = source.snapshot()
    expect(stats[0]).toMatchObject({ state: 'cooldown', failures: 1 })
    expect(stats[1]).toMatchObject({ state: 'healthy', successes: 1 })
    const dependencies = createBroker.mock.calls[0]![1]
    const remainingMs = stats[0]!.cooldownUntil! - dependencies.now()
    expect(remainingMs).toBeGreaterThanOrEqual(29_000)
    expect(remainingMs).toBeLessThanOrEqual(31_000)
  } finally {
    source.dispose()
  }
})
