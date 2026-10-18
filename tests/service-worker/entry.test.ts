import { expect, it, vi } from 'vitest'
import { installServiceWorker } from '../../src/service-worker/entry'
import { BLOCK_PATH, VERSION } from '../../src/service-worker/protocol'
import { binding, block, client, config, scope, source } from './helpers'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'

it.each(['https://gallery.example/', scope])('installs actual scope-relative SW event handlers without intercepting navigation: %s', async base => {
  const handlers = new Map<string, (event: never) => void>()
  const claim = vi.fn(async () => {})
  const createSource = vi.fn(() => source(async () => new Uint8Array()))
  const sw = { registration: { scope: base }, clients: { claim, get: async () => ({ ...client, url: base }) },
    addEventListener: (type: string, handler: (event: never) => void) => handlers.set(type, handler) }
  installServiceWorker(createSource, sw as unknown as ServiceWorkerGlobalScope)
  expect(createSource).not.toHaveBeenCalled()
  const waitUntil = vi.fn()
  handlers.get('activate')!({ waitUntil } as never)
  expect(claim).toHaveBeenCalledTimes(1)
  const respondWith = vi.fn()
  handlers.get('fetch')!({ request: new Request(base), clientId: client.id, respondWith } as never)
  expect(respondWith).not.toHaveBeenCalled()
  handlers.get('fetch')!({ request: new Request(new URL(`${BLOCK_PATH}${(await block()).cid}`, base)),
    clientId: client.id, respondWith } as never)
  expect(respondWith).toHaveBeenCalledTimes(1)
  expect((await respondWith.mock.calls[0]![0]).status).toBe(409)
})

it('expires tickets/results on subsequent events and reclaims idle bindings without a background network poll', async () => {
  let now = 0
  const get = vi.fn(async () => (await block()).bytes)
  const dispose = vi.fn()
  const runtime = createServiceWorkerRuntime({ scope, boot: 'test-boot', now: () => now, clients: { get: async () => client },
    createSource: () => ({ get, dispose, snapshot: () => [] }) })
  const owner = await binding(runtime)
  try {
    const { cid } = await block()
    const request = await owner.prepare(cid, 1)
    now = 5001
    expect((await runtime.handleFetch(request, client.id)!).status).toBe(400)
    expect(get).not.toHaveBeenCalled()
    expect(runtime.usage().consumers).toBe(0)
    now = 6001
    const response = await runtime.handleFetch(await owner.prepare(cid, 2), client.id)!
    expect(response.ok).toBe(true)
    now += 10_001
    await owner.control('snapshot')
    expect(runtime.usage().consumers).toBe(0)
    now += 60_001
    await expect(owner.control('snapshot')).rejects.toMatchObject({ error: { code: 'NETWORK' } })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(runtime.usage().bindings).toBe(0)
  } finally { owner.rpc.close(); await runtime.dispose() }
})

it('bounds binding/cache admission and rejects invalid config without constructing sources', async () => {
  const createSource = vi.fn(() => source(async () => new Uint8Array()))
  const runtime = createServiceWorkerRuntime({ scope, boot: 'test-boot', clients: { get: async () => client }, createSource })
  const owners: Awaited<ReturnType<typeof binding>>[] = []
  try {
    const bad = { ...config, limits: { ...config.limits, maxBlockBytes: Infinity } }
    await expect(binding(runtime, client, bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(createSource).not.toHaveBeenCalled()
    for (let index = 0; index < 8; index++) owners.push(await binding(runtime))
    await expect(binding(runtime)).rejects.toMatchObject({ code: 'LIMIT' })
    expect(createSource).toHaveBeenCalledTimes(8)
    expect(runtime.usage().bindings).toBe(8)
  } finally { for (const owner of owners) owner.rpc.close(); await runtime.dispose() }
})

it('validates the actual MessageEvent Window source before accepting a transferred control port', async () => {
  const handlers = new Map<string, (event: never) => void>()
  const createSource = vi.fn(() => source(async () => new Uint8Array()))
  const sw = { registration: { scope }, clients: { claim: async () => {}, get: async () => client },
    addEventListener: (type: string, handler: (event: never) => void) => handlers.set(type, handler) }
  installServiceWorker(createSource, sw as unknown as ServiceWorkerGlobalScope)
  const { port1, port2 } = new MessageChannel()
  try {
    const response = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
    const waitUntil = vi.fn()
    handlers.get('message')!({ data: { type: 'open', v: VERSION, sessionId: 'session', config },
      source: { ...client, type: 'worker' }, ports: [port2], waitUntil } as never)
    await waitUntil.mock.calls[0]![0]
    expect((await response).data).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(createSource).not.toHaveBeenCalled()
  } finally { port1.close(); port2.close() }
})
