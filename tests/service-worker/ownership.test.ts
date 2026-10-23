import { afterEach, expect, it, vi } from 'vitest'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import { WindowBlockSource, type WindowSourceEnvironment } from '../../src/service-worker/window-source'
import { WindowOwnership, serviceMessage } from '../../src/service-worker/ownership'
import { BOUNDS, SCRIPT, VERSION } from '../../src/service-worker/protocol'
import { attachWindowBlockBridge, BRIDGE_OPEN } from '../../src/worker/block-bridge'
import { PortRpc } from '../../src/service-worker/rpc'
import { block, client, config, deferred, scope, source } from './helpers'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})

function harness(get: ReturnType<typeof source>['get'], options: { drop?: string[]; stallOpen?: boolean; boot?: string } = {}) {
  const validation = deferred<typeof client>()
  let currentType = ''
  const createSource = vi.fn(() => source(get))
  const runtime = createServiceWorkerRuntime({ scope, boot: options.boot ?? 'global-boot-one', createSource,
    clients: { get: async id => currentType === 'open' && options.stallOpen
      ? validation.promise : { ...client, id } } })
  cleanup.push(() => runtime.dispose())
  const messages: Array<Record<string, unknown>> = []
  const controller = { scriptURL: new URL(SCRIPT, scope).href,
    postMessage(value: Record<string, unknown>, ports: MessagePort[]) {
      messages.push(value); currentType = value.type as string
      const port = ports[0]!
      if (value.type === 'open') {
        const commands = new Map<number, string>()
        port.addEventListener('message', event => { commands.set(event.data.sequence, event.data.type) })
        const send = port.postMessage.bind(port)
        port.postMessage = (response, transfer) => {
          const kind = response.sequence === 0 ? 'open' : commands.get(response.sequence)
          if (options.drop?.includes(kind!)) return
          send(response, transfer as Transferable[])
        }
        void runtime.open(value, client, port)
      } else void runtime.manage(value, client, port)
    } } as unknown as ServiceWorker
  const container = new EventTarget() as EventTarget & { controller: ServiceWorker; register(): Promise<unknown> }
  container.controller = controller; container.register = async () => ({})
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = new Request(input, init)
    const response = runtime.handleFetch(request, client.id)!
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      void response.then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort))
    })
  })
  const env: WindowSourceEnvironment = { base: new URL(scope), serviceWorker: container as unknown as ServiceWorkerContainer,
    fetch, channel: () => new MessageChannel() }
  return { runtime, controller, env, messages, createSource, validation, container }
}

async function recoverWhenDrained(owner: WindowOwnership, runtime: ReturnType<typeof createServiceWorkerRuntime>) {
  // Each call is an explicit attempt, not a polling implementation or a test retry.
  const first = owner.recover().catch(error => error)
  await first
  await vi.waitFor(() => expect(runtime.usage().bindings).toBe(0))
  if (owner.quarantined) await owner.recover()
}

it.each(['open', 'prepare-block'])('retains pre-ACK ownership after a lost %s ACK and recovers through the saved owner credentials', async lost => {
  const { cid, bytes } = await block()
  vi.useFakeTimers()
  const host = harness(async () => bytes, { drop: [lost] })
  const owner = new WindowOwnership()
  const source = new WindowBlockSource('session', config, host.env, owner)
  cleanup.push(() => source.dispose())
  const result = source.get(1, cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(host.runtime.usage()[lost === 'open' ? 'bindings' : 'consumers']).toBe(1))
  let settled = false
  const barrier = source.settled().then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(BOUNDS.handshakeMs + 1)
  expect(await result).toMatchObject({ error: { code: 'TIMEOUT' } })
  expect(owner.quarantined).toBe(true)
  expect(settled).toBe(false)
  expect(host.env.fetch).not.toHaveBeenCalled()
  vi.useRealTimers()
  await recoverWhenDrained(owner, host.runtime)
  await barrier
  expect(settled).toBe(true)
  expect(owner.usage()).toEqual({ debts: 0, quarantined: false })
  const open = host.messages.find(message => message.type === 'open')!
  const management = host.messages.find(message => message.type === 'reconcile')!
  expect(management).toMatchObject({ ownerId: open.ownerId, attempt: open.attempt, secret: open.secret, boot: open.boot })
})

it('holds relay reservations beyond cancel/port deadlines, then releases exactly once after management drain proof', async () => {
  const { cid, bytes } = await block()
  vi.useFakeTimers()
  const gate = deferred<Uint8Array>()
  const host = harness(async () => gate.promise, { drop: ['cancel-block', 'discard'] })
  cleanup.push(() => gate.resolve(bytes))
  const owner = new WindowOwnership()
  const relay = { count: 0, bytes: 0 }
  const { port1, port2 } = new MessageChannel()
  const close = attachWindowBlockBridge({ type: BRIDGE_OPEN, v: VERSION, sessionId: 'session', config, roots: [], policy: BUILD_POLICY }, port2,
    () => host.env, () => {}, relay, owner)
  const rpc = new PortRpc(port1)
  cleanup.push(() => { close(); rpc.close() })
  const result = rpc.request({ type: 'get', sessionId: 'session', blockRequestId: 1, cid }).catch(error => error)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  const cancel = rpc.request({ type: 'cancel', sessionId: 'session', blockRequestId: 1 }, 100_000).catch(error => error)
  expect(await result).toMatchObject({ error: { code: 'CANCELLED' } })
  expect(relay.count).toBe(1)
  await vi.advanceTimersByTimeAsync(BOUNDS.handshakeMs + 1)
  expect(owner.quarantined).toBe(true)
  expect(relay.count).toBe(1)
  expect(host.runtime.usage().flights).toBe(1)
  vi.useRealTimers()
  await expect(owner.recover()).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  expect(host.messages.filter(message => message.type === 'reconcile')).toHaveLength(1)
  close() // Dedicated generation teardown does not clear the Window debt or relay reservation.
  expect(relay.count).toBe(1)
  gate.resolve(bytes)
  await vi.waitFor(() => expect(host.runtime.usage().bindings).toBe(0))
  expect(relay.count).toBe(1)
  await owner.recover()
  await vi.waitFor(() => expect(relay).toEqual({ count: 0, bytes: 0 }))
  await owner.recover()
  expect(relay).toEqual({ count: 0, bytes: 0 })
  rpc.close(); await cancel
  const fresh = new WindowBlockSource('fresh', config, host.env, owner)
  cleanup.push(() => fresh.dispose())
  expect(new Uint8Array(await fresh.get(1, cid, new AbortController().signal))).toEqual(bytes)
  await fresh.acknowledge(1)
})

it('fences a pending open before async validation and rejects late admission without creating a source', async () => {
  const host = harness(async () => new Uint8Array(), { stallOpen: true })
  cleanup.push(() => host.validation.resolve(client))
  const credentials = { ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 1, boot: host.runtime.epoch }
  const opening = serviceMessage(host.controller, { type: 'open', sessionId: 'session', config, roots: [], ...credentials, policy: BUILD_POLICY }, () => new MessageChannel()).catch(error => error)
  await vi.waitFor(() => expect(host.messages.some(value => value.type === 'open')).toBe(true))
  const first = await serviceMessage(host.controller, { type: 'reconcile', ...credentials }, () => new MessageChannel())
  expect(first).toMatchObject({ state: 'draining' })
  host.validation.resolve(client)
  expect(await opening).toMatchObject({ error: { code: 'CANCELLED' } })
  expect(host.createSource).not.toHaveBeenCalled()
  expect(await serviceMessage(host.controller, { type: 'reconcile', ...credentials }, () => new MessageChannel()))
    .toMatchObject({ state: 'settled' })
  await expect(serviceMessage(host.controller, { type: 'open', sessionId: 'late', config, roots: [], ...credentials, policy: BUILD_POLICY }, () => new MessageChannel()))
    .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
  expect(host.createSource).not.toHaveBeenCalled()
})

it('does not release a source barrier when real cleanup finished but the cancel ACK was lost', async () => {
  const { cid, bytes } = await block()
  vi.useFakeTimers()
  const gate = deferred<Uint8Array>()
  const host = harness(async () => gate.promise, { drop: ['cancel-block', 'discard'] })
  cleanup.push(() => gate.resolve(bytes))
  const owner = new WindowOwnership()
  const source = new WindowBlockSource('session', config, host.env, owner)
  cleanup.push(() => source.dispose())
  const result = source.get(1, cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  let settled = false
  const barrier = source.settled().then(() => { settled = true })
  const cancel = source.cancel(1).catch(error => error)
  gate.resolve(bytes)
  await result
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(0))
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(BOUNDS.handshakeMs + 1)
  expect(await cancel).toMatchObject({ error: { code: 'TIMEOUT' } })
  expect(owner.quarantined).toBe(true)
  expect(settled).toBe(false)
  vi.useRealTimers()
  await recoverWhenDrained(owner, host.runtime)
  await barrier
  expect(settled).toBe(true)
})

it('preserves and fences an open still awaiting validation when its Window source is disposed', async () => {
  const { cid, bytes } = await block()
  const host = harness(async () => bytes, { stallOpen: true })
  cleanup.push(() => host.validation.resolve(client))
  const owner = new WindowOwnership()
  const source = new WindowBlockSource('session', config, host.env, owner)
  const result = source.get(1, cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(host.messages.some(message => message.type === 'open')).toBe(true))
  const barrier = source.settled()
  source.dispose()
  expect(owner.quarantined).toBe(true)
  await expect(owner.recover()).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  host.validation.resolve(client)
  expect(await result).toMatchObject({ error: { code: 'CANCELLED' } })
  await owner.recover()
  await barrier
  expect(host.createSource).not.toHaveBeenCalled()
  expect(host.env.fetch).not.toHaveBeenCalled()
})

it('does not use another controller/new epoch to retire old still-live work', async () => {
  const { cid, bytes } = await block()
  const gate = deferred<Uint8Array>()
  const old = harness(async () => gate.promise)
  cleanup.push(() => gate.resolve(bytes))
  const replacement = harness(async () => bytes, { boot: 'global-boot-two' })
  const owner = new WindowOwnership()
  const source = new WindowBlockSource('session', config, old.env, owner)
  cleanup.push(() => source.dispose())
  const result = source.get(1, cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(old.runtime.usage().flights).toBe(1))
  old.container.controller = replacement.controller
  old.container.dispatchEvent(new Event('controllerchange'))
  expect(await result).toMatchObject({ error: { code: 'CANCELLED' } })
  await expect(owner.recover()).rejects.toMatchObject({ error: { code: 'NETWORK' } })
  expect(replacement.messages.filter(value => value.type === 'reconcile')).toHaveLength(0)
  expect(old.runtime.usage().flights).toBe(1)
  expect(owner.quarantined).toBe(true)
  gate.resolve(bytes)
  await vi.waitFor(() => expect(old.runtime.usage().bindings).toBe(0))
  if (owner.quarantined) await owner.recover()
  expect(owner.quarantined).toBe(false)
})

it('rejects cross-Window recovery credentials and never treats an unknown owner as settlement proof', async () => {
  const { cid, bytes } = await block()
  const gate = deferred<Uint8Array>()
  const host = harness(async () => gate.promise)
  cleanup.push(() => gate.resolve(bytes))
  const source = new WindowBlockSource('A', config, host.env)
  cleanup.push(() => source.dispose())
  const result = source.get(1, cid, new AbortController().signal)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  const secondClient = { ...client, id: 'B' }
  const secondController = { scriptURL: new URL(SCRIPT, scope).href,
    postMessage(value: { type: string }, ports: MessagePort[]) {
      if (value.type === 'open') void host.runtime.open(value, secondClient, ports[0]!)
      else void host.runtime.manage(value, secondClient, ports[0]!)
    } } as unknown as ServiceWorker
  const secondContainer = new EventTarget() as EventTarget & { controller: ServiceWorker; register(): Promise<unknown> }
  secondContainer.controller = secondController; secondContainer.register = async () => ({})
  const second = new WindowBlockSource('B', config, { ...host.env,
    serviceWorker: secondContainer as unknown as ServiceWorkerContainer,
    fetch: async (input, init) => host.runtime.handleFetch(new Request(input, init), secondClient.id)! })
  cleanup.push(() => second.dispose())
  const otherResult = second.get(1, cid, new AbortController().signal)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(2))
  const open = host.messages.find(message => message.type === 'open')!
  const manage = async (value: unknown, owner = client) => {
    const { port1, port2 } = new MessageChannel()
    const answer = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
    await host.runtime.manage(value, owner, port2)
    const response = (await answer).data; port1.close(); return response
  }
  const credentials = { v: VERSION, type: 'reconcile', ownerId: open.ownerId, attempt: open.attempt, secret: open.secret, boot: open.boot }
  expect(await manage(credentials, { ...client, id: 'B' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(host.runtime.usage().flights).toBe(2)
  expect(await manage({ ...credentials, ownerId: crypto.randomUUID(), secret: crypto.randomUUID() }))
    .toMatchObject({ ok: true, value: { state: 'unknown' } })
  gate.resolve(bytes)
  expect(new Uint8Array(await result)).toEqual(bytes)
  expect(new Uint8Array(await otherResult)).toEqual(bytes)
  await source.acknowledge(1)
  await second.acknowledge(1)
})

it('keeps owner fences across idle time and refuses excess owners without constructing content sources', async () => {
  const host = harness(async () => new Uint8Array())
  const credentials = Array.from({ length: BOUNDS.owners }, () => ({ ownerId: crypto.randomUUID(), secret: crypto.randomUUID(),
    attempt: 1, boot: host.runtime.epoch }))
  for (const identity of credentials) {
    expect(await serviceMessage(host.controller, { type: 'reconcile', ...identity }, () => new MessageChannel()))
      .toMatchObject({ state: 'unknown' })
  }
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(BOUNDS.idleMs * 2)
  vi.useRealTimers()
  await expect(serviceMessage(host.controller, { type: 'open', sessionId: 'late', config, roots: [], ...credentials[0], policy: BUILD_POLICY }, () => new MessageChannel()))
    .rejects.toMatchObject({ error: { code: 'CANCELLED' } })
  await expect(serviceMessage(host.controller, { type: 'reconcile', ownerId: crypto.randomUUID(), secret: crypto.randomUUID(),
    attempt: 1, boot: host.runtime.epoch }, () => new MessageChannel())).rejects.toMatchObject({ error: { code: 'LIMIT' } })
  expect(host.createSource).not.toHaveBeenCalled()
  expect(host.runtime.usage().owners).toBe(BOUNDS.owners)
})

it('takes settlement snapshots without including requests registered in the future', async () => {
  const first = await block('first')
  const second = await block('second')
  const gate = deferred<Uint8Array>()
  const host = harness(async cid => cid === first.cid ? first.bytes : gate.promise)
  cleanup.push(() => gate.resolve(second.bytes))
  const source = new WindowBlockSource('session', config, host.env)
  cleanup.push(() => source.dispose())
  await source.get(1, first.cid, new AbortController().signal)
  const snapshot = source.settled()
  let futureDone = false
  const future = source.get(2, second.cid, new AbortController().signal).then(value => { futureDone = true; return value })
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  await source.acknowledge(1)
  await snapshot
  expect(futureDone).toBe(false)
  gate.resolve(second.bytes)
  expect(new Uint8Array(await future)).toEqual(second.bytes)
  await source.acknowledge(2)
  await source.settled()
})

it('does not let an older drain completion certify a newer revocation high-water mark', async () => {
  const a = await block('A')
  const b = await block('B')
  const first = deferred<Uint8Array>()
  const second = deferred<Uint8Array>()
  const host = harness(async cid => cid === a.cid ? first.promise : second.promise)
  cleanup.push(() => { first.resolve(a.bytes); second.resolve(b.bytes) })
  const owner = new WindowOwnership()
  const sourceA = new WindowBlockSource('A', config, host.env, owner)
  const sourceB = new WindowBlockSource('B', config, host.env, owner)
  cleanup.push(() => { sourceA.dispose(); sourceB.dispose() })
  const resultA = sourceA.get(1, a.cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  const resultB = sourceB.get(1, b.cid, new AbortController().signal).catch(error => error)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(2))
  const opens = host.messages.filter(value => value.type === 'open')
  owner.retire()
  const reconcile = (open: Record<string, unknown>) => serviceMessage(host.controller, { type: 'reconcile',
    ownerId: open.ownerId, secret: open.secret, attempt: open.attempt, boot: open.boot }, () => new MessageChannel())
  expect(await reconcile(opens[0]!)).toMatchObject({ state: 'draining' })
  expect(await reconcile(opens[1]!)).toMatchObject({ state: 'draining' })
  first.resolve(a.bytes)
  await resultA
  await vi.waitFor(() => expect(host.runtime.usage().bindings).toBe(1))
  expect(await reconcile(opens[1]!)).toMatchObject({ state: 'draining' })
  second.resolve(b.bytes)
  await resultB
  await vi.waitFor(() => expect(host.runtime.usage().bindings).toBe(0))
  expect(await reconcile(opens[1]!)).toMatchObject({ state: 'settled' })
  await owner.recover()
  await Promise.all([sourceA.settled(), sourceB.settled()])
})

it('reuses one stable owner across source sessions without exhausting live-owner admission', async () => {
  const { cid, bytes } = await block()
  const host = harness(async () => bytes)
  const owner = new WindowOwnership()
  for (let session = 0; session <= BOUNDS.owners; session++) {
    const source = new WindowBlockSource(`session-${session}`, config, host.env, owner)
    cleanup.push(() => source.dispose())
    expect(new Uint8Array(await source.get(1, cid, new AbortController().signal))).toEqual(bytes)
    await source.acknowledge(1)
    source.dispose()
    await vi.waitFor(() => expect(owner.usage()).toEqual({ debts: 0, quarantined: false }))
  }
  const opens = host.messages.filter(value => value.type === 'open')
  expect(new Set(opens.map(value => value.ownerId)).size).toBe(1)
  expect(opens.at(-1)!.attempt).toBeGreaterThan(opens[0]!.attempt as number)
  expect(host.runtime.usage()).toMatchObject({ owners: 1, bindings: 0 })
})

it('does not quarantine a known rejected open when live-owner admission is full', async () => {
  const { cid, bytes } = await block()
  const host = harness(async () => bytes)
  for (let index = 0; index < BOUNDS.owners; index++) await serviceMessage(host.controller, { type: 'reconcile',
    ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 1, boot: host.runtime.epoch }, () => new MessageChannel())
  const owner = new WindowOwnership()
  const source = new WindowBlockSource('session', config, host.env, owner)
  cleanup.push(() => source.dispose())
  await expect(source.get(1, cid, new AbortController().signal)).rejects.toMatchObject({ error: { code: 'LIMIT' } })
  await source.settled()
  expect(owner.usage()).toEqual({ debts: 0, quarantined: false })
  expect(host.createSource).not.toHaveBeenCalled()
})

it('does not certify an existing active attempt as settled when a duplicate open is rejected', async () => {
  const { cid, bytes } = await block()
  const gate = deferred<Uint8Array>()
  const host = harness(async () => gate.promise)
  cleanup.push(() => gate.resolve(bytes))
  const source = new WindowBlockSource('session', config, host.env)
  cleanup.push(() => source.dispose())
  const result = source.get(1, cid, new AbortController().signal)
  await vi.waitFor(() => expect(host.runtime.usage().flights).toBe(1))
  const open = host.messages.find(value => value.type === 'open')!
  const { port1, port2 } = new MessageChannel()
  const response = new Promise<MessageEvent>(resolve => { port1.onmessage = resolve; port1.start() })
  await host.runtime.open(open, client, port2)
  const rejected = (await response).data
  port1.close()
  expect(rejected).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  expect(Object.hasOwn(rejected, 'admission')).toBe(false)
  expect(host.runtime.usage().flights).toBe(1)
  gate.resolve(bytes)
  expect(new Uint8Array(await result)).toEqual(bytes)
  await source.acknowledge(1)
})
