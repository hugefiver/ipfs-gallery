import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeDependencies } from '../../src/worker/runtime'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'

const capture = vi.hoisted(() => ({ dependencies: undefined as RuntimeDependencies | undefined,
  bridge: vi.fn(() => ({ get: vi.fn(), snapshot: () => [], dispose: vi.fn() })) }))
vi.mock('../../src/worker/runtime', () => ({ GalleryWorkerRuntime: class {
  constructor(dependencies: RuntimeDependencies) { capture.dependencies = dependencies }
  handleMessage = vi.fn()
} }))
vi.mock('../../src/worker/block-bridge', () => ({ createBridgedBlockSource: capture.bridge }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('wires the production Dedicated Worker source to the private Window bridge with its session identity', async () => {
  vi.stubGlobal('addEventListener', vi.fn())
  await import('../../src/worker/gallery.worker')
  const config = { gateways: [...DEFAULT_GATEWAYS], limits: { ...DEFAULT_LIMITS } }
  const source = capture.dependencies!.createBroker(config, 'actual-session', [])
  expect(capture.bridge).toHaveBeenCalledWith(config, 'actual-session', expect.any(Function), [])
  expect(source).toBe(capture.bridge.mock.results[0]!.value)
})
