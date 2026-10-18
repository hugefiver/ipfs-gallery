import { afterEach, expect, it, vi } from 'vitest'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { createServiceWorkerRuntime, type WindowIdentity } from '../../src/service-worker/runtime'
import { BOUNDS, VERSION } from '../../src/service-worker/protocol'
import { binding, block, client, config, deferred, scope, source } from './helpers'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function message(runtime: ReturnType<typeof createServiceWorkerRuntime>, value: Record<string, unknown>, sender: WindowIdentity) {
  const { port1, port2 } = new MessageChannel()
  const response = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
  const body = { ...value, v: VERSION, ...(value.type === 'open' ? { policy: BUILD_POLICY } : {}) }
  if (value.type === 'open') await runtime.open(body, sender, port2)
  else await runtime.manage(body, sender, port2)
  const result = (await response).data
  port1.close()
  return result
}

it.each(['destroyed', 'outside-scope'])('reclaims only cleaned owners of an actually %s WindowClient while retaining live fences', async state => {
  const clients = new Map<string, WindowIdentity>()
  const createSource = vi.fn(() => source(async () => new Uint8Array()))
  const runtime = createServiceWorkerRuntime({ scope, boot: 'retirement-boot', clients: { get: async id => clients.get(id) }, createSource })
  cleanup.push(() => runtime.dispose())
  const owners = Array.from({ length: BOUNDS.owners }, (_, index) => ({ sender: { ...client, id: `window-${index}` },
    ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 1, boot: runtime.epoch }))
  for (const owner of owners) {
    clients.set(owner.sender.id, owner.sender)
    const { sender, ...credentials } = owner
    expect(await message(runtime, { type: 'reconcile', ...credentials }, sender)).toMatchObject({ ok: true })
  }
  const departed = owners[0]!
  if (state === 'destroyed') clients.delete(departed.sender.id)
  else clients.set(departed.sender.id, { ...departed.sender, url: 'https://gallery.example/sibling/' })
  const newcomer = { ...client, id: 'new-window' }
  clients.set(newcomer.id, newcomer)
  expect(await message(runtime, { type: 'identify' }, newcomer)).toMatchObject({ ok: true })
  expect(runtime.usage().owners).toBe(BOUNDS.owners - 1)
  const connected = await binding(runtime, newcomer)
  cleanup.push(() => connected.rpc.close())
  const { sender, ...credentials } = owners[1]!
  expect(await message(runtime, { type: 'open', sessionId: 'late', config, ...credentials }, sender))
    .toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  expect(createSource).toHaveBeenCalledTimes(1)
  expect(runtime.usage().owners).toBe(BOUNDS.owners)
})

it('keeps a departed owner charged until its actual network cleanup settles', async () => {
  const { cid, bytes } = await block()
  const clients = new Map<string, WindowIdentity>([[client.id, client]])
  const gate = deferred<Uint8Array>()
  let signal: AbortSignal | undefined
  const runtime = createServiceWorkerRuntime({ scope, boot: 'retirement-boot', clients: { get: async id => clients.get(id) },
    createSource: () => source(async (_cid, current) => { signal = current; return gate.promise }) })
  cleanup.push(() => runtime.dispose()); cleanup.push(() => gate.resolve(bytes))
  const owner = await binding(runtime)
  cleanup.push(() => owner.rpc.close())
  const response = runtime.handleFetch(await owner.prepare(cid, 1), client.id)!
  await vi.waitFor(() => expect(runtime.usage().flights).toBe(1))
  clients.delete(client.id)
  const newcomer = { ...client, id: 'new-window' }
  clients.set(newcomer.id, newcomer)
  await message(runtime, { type: 'identify' }, newcomer)
  expect(signal!.aborted).toBe(true)
  expect(runtime.usage()).toMatchObject({ owners: 1, bindings: 1, flights: 1 })
  gate.resolve(bytes)
  expect((await response).status).toBe(410)
  await vi.waitFor(() => expect(runtime.usage()).toMatchObject({ owners: 0, bindings: 0, flights: 0 }))
})

it('prevents an asynchronously validating open from reviving a departed owner', async () => {
  const clients = new Map<string, WindowIdentity>([[client.id, client]])
  const validation = deferred<WindowIdentity>()
  let defer = true
  const createSource = vi.fn(() => source(async () => new Uint8Array()))
  const runtime = createServiceWorkerRuntime({ scope, boot: 'retirement-boot', createSource,
    clients: { get: async id => {
      if (id === client.id && defer) { defer = false; return validation.promise }
      return clients.get(id)
    } } })
  cleanup.push(() => runtime.dispose()); cleanup.push(() => validation.resolve(client))
  const pending = message(runtime, { type: 'open', sessionId: 'old', config,
    ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 1, boot: runtime.epoch }, client)
  clients.delete(client.id)
  const newcomer = { ...client, id: 'new-window' }
  clients.set(newcomer.id, newcomer)
  await message(runtime, { type: 'identify' }, newcomer)
  expect(runtime.usage().owners).toBe(1)
  validation.resolve(client)
  expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  await vi.waitFor(() => expect(runtime.usage().owners).toBe(0))
  expect(createSource).not.toHaveBeenCalled()
})
