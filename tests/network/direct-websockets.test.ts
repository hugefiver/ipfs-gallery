import { multiaddr } from '@multiformats/multiaddr'
import type { WebSocketMultiaddrConnection } from '@libp2p/websockets'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directBudget } from '../../src/network/direct-budget'
import { createBudgetedWebSockets } from '../../src/network/direct-websockets'

class ControlledSocket extends EventTarget {
  static instances: ControlledSocket[] = []
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  close = vi.fn(() => { this.readyState = 2 })
  send = vi.fn()
  constructor(readonly url: string) { super(); ControlledSocket.instances.push(this) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  exit() {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '', wasClean: true }))
  }
}

const address = multiaddr('/dns4/provider.ipfs.tech/tcp/443/tls/ws')
const closures = new Set<Promise<void>>()
const log = Object.assign(vi.fn(), { trace: vi.fn(), error: vi.fn(), enabled: false })
const factory = createBudgetedWebSockets(() => true, () => {}, closures)
type Options = Parameters<ReturnType<typeof factory>['dial']>[1]
type Connection = Awaited<ReturnType<ReturnType<typeof factory>['dial']>>
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function observe(promise: Promise<unknown>) { const done = vi.fn(); void promise.then(done, done); return done }
function transport() {
  return factory({ logger: { forComponent: () => log }, events: new EventTarget() } as unknown as Parameters<typeof factory>[0])
}
function options(upgradeOutbound: Options['upgrader']['upgradeOutbound'], signal = new AbortController().signal): Options {
  return { signal, upgrader: { upgradeOutbound } } as Options
}

beforeEach(() => { ControlledSocket.instances = []; vi.stubGlobal('WebSocket', ControlledSocket) })
afterEach(async () => {
  for (const socket of ControlledSocket.instances) socket.exit()
  await Promise.all(closures)
  vi.unstubAllGlobals()
  expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0 })
})

describe('patched raw closed network ownership', () => {
  it('retains a connection after logical abort until raw.closed proves native exit', async () => {
    let raw!: WebSocketMultiaddrConnection
    const operation = transport().dial(address, options(async connection => {
      raw = connection as WebSocketMultiaddrConnection
      return {} as Connection
    }))
    await turn()
    ControlledSocket.instances[0]!.open()
    await operation
    expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 1 })
    const barrier = observe(Promise.all(closures))
    raw.abort(new Error('cancel'))
    await turn()
    expect(raw.status).toBe('aborted')
    expect(directBudget.snapshot().connections).toBe(1)
    expect(barrier).not.toHaveBeenCalled()
    ControlledSocket.instances[0]!.exit()
    await Promise.all(closures)
    expect(directBudget.snapshot().connections).toBe(0)
  })

  it.each(['handshake abort', 'upgrade failure'] as const)('holds dial and connection reservations through %s cleanup', async failure => {
    const controller = new AbortController()
    const operation = transport().dial(address, options(async () => { throw new Error('upgrade rejected') }, controller.signal))
    const done = observe(operation)
    await turn()
    const socket = ControlledSocket.instances[0]!
    if (failure === 'handshake abort') controller.abort()
    else socket.open()
    await turn()
    expect(socket.close).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    expect(directBudget.snapshot()).toMatchObject({ dials: 1, connections: 1 })
    socket.exit()
    await expect(operation).rejects.toBeDefined()
    expect(directBudget.snapshot()).toMatchObject({ dials: 0, connections: 0 })
  })

  it('retains ownership when close throws instead of treating logical abort as cleanup', async () => {
    let raw!: WebSocketMultiaddrConnection
    const operation = transport().dial(address, options(async connection => {
      raw = connection as WebSocketMultiaddrConnection
      return {} as Connection
    }))
    await turn()
    const socket = ControlledSocket.instances[0]!
    socket.open()
    await operation
    socket.close.mockImplementation(() => { throw new Error('close failed') })
    raw.abort(new Error('stop'))
    const barrier = observe(Promise.all(closures))
    await turn()
    expect(barrier).not.toHaveBeenCalled()
    expect(directBudget.snapshot().connections).toBe(1)
    socket.exit()
    await Promise.all(closures)
  })
})
