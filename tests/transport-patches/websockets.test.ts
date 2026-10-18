import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import type { StreamCloseEvent } from '@libp2p/interface'
import { webSockets } from '@libp2p/websockets'
import type { WebSocketsInit, WebSocketMultiaddrConnection } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type WebSocketTransport = ReturnType<ReturnType<typeof webSockets>>
type DialTransportOptions = Parameters<WebSocketTransport['dial']>[1]
type Connection = Awaited<ReturnType<WebSocketTransport['dial']>>
type MultiaddrConnection = Parameters<DialTransportOptions['upgrader']['upgradeOutbound']>[0]
type ComponentLogger = Parameters<ReturnType<typeof webSockets>>[0]['logger']

// close() follows the browser's close-code restriction and deliberately does not
// finish the close handshake until finishClose() is called by the test.
class NativeCodeWebSocket extends EventTarget {
  static instances: NativeCodeWebSocket[] = []
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  close = vi.fn((code?: number) => {
    if (code != null && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('Invalid close code', 'InvalidAccessError')
    }
    if (this.readyState < 2) this.readyState = 2
  })
  send = vi.fn()

  constructor(readonly url: string) {
    super()
    NativeCodeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  finishClose(wasClean = true) {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code: wasClean ? 1000 : 1006, reason: '', wasClean }))
  }

  message(data: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
}

function createdSocket(index = 0) {
  const socket = NativeCodeWebSocket.instances.at(index)
  assert.ok(socket, `Expected a constructed WebSocket at index ${index}`)
  return socket
}

const address = multiaddr('/dns4/example.com/tcp/443/tls/ws')
const log = Object.assign(vi.fn(), { trace: vi.fn(), error: vi.fn(), enabled: false })
const logger = { forComponent: () => log } as unknown as ComponentLogger

function transport(init: WebSocketsInit = {}) {
  return webSockets(init)({ logger, events: new EventTarget() } as Parameters<ReturnType<typeof webSockets>>[0]) as WebSocketTransport & {
    _connect: (ma: typeof address, options: DialTransportOptions) => Promise<WebSocket>
  }
}

function options(
  signal = new AbortController().signal,
  upgradeOutbound: (connection: MultiaddrConnection, options: DialTransportOptions) => Promise<Connection> = vi.fn(async () => ({} as Connection)),
) {
  return { signal, upgrader: { upgradeOutbound } } as unknown as DialTransportOptions
}

function observe<T>(promise: Promise<T>) {
  const done = vi.fn()
  void promise.then(done, done)
  return done
}

async function turn() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function connected(init: WebSocketsInit = {}) {
  let maConn!: WebSocketMultiaddrConnection
  const dial = transport(init).dial(address, options(undefined, vi.fn(async (connection: MultiaddrConnection) => {
    maConn = connection as WebSocketMultiaddrConnection
    return {} as Connection
  })))
  const socket = createdSocket(-1)
  socket.open()
  await dial
  return { socket, maConn }
}

beforeEach(() => {
  NativeCodeWebSocket.instances = []
  vi.stubGlobal('WebSocket', NativeCodeWebSocket)
})

afterEach(() => {
  for (const socket of NativeCodeWebSocket.instances) socket.finishClose()
  vi.unstubAllGlobals()
})

describe('installed WebSocket transport resource ownership', () => {
  it('creates no socket for a pre-aborted dial', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(transport()._connect(address, options(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
    expect(NativeCodeWebSocket.instances).toHaveLength(0)
  })

  it.each(['abort', 'error', 'close'] as const)('settles handshake %s only after real socket exit and removes listeners', async failure => {
    const controller = new AbortController()
    const result = transport()._connect(address, options(controller.signal))
    const done = observe(result)
    const socket = createdSocket()
    const error = new Event('error')
    if (failure === 'abort') controller.abort()
    else if (failure === 'error') socket.dispatchEvent(error)
    else socket.finishClose(false)
    await turn()
    if (failure !== 'close') {
      expect(socket.close).toHaveBeenCalledOnce()
      expect(done).not.toHaveBeenCalled()
      socket.finishClose(false)
    }
    await expect(result).rejects.toBeDefined()
    if (failure === 'error') await expect(result).rejects.toBe(error)
    if (failure === 'abort') await expect(result).rejects.toMatchObject({ name: 'ConnectionFailedError' })
    for (const type of ['open', 'error', 'close']) expect(getEventListeners(socket, type)).toHaveLength(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('does not reactivate a handshake on a late open event during abort cleanup', async () => {
    const controller = new AbortController()
    const upgrader = vi.fn(async () => ({} as Connection))
    const result = transport().dial(address, options(controller.signal, upgrader))
    const done = observe(result)
    const socket = createdSocket()
    controller.abort()
    await turn()
    socket.dispatchEvent(new Event('open'))
    await turn()
    expect(upgrader).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(2)
    socket.finishClose()
    await expect(result).rejects.toMatchObject({ name: 'ConnectionFailedError' })
  })

  it('cleans up a throwing progress callback and preserves its error', async () => {
    const error = new Error('progress failed')
    const result = transport()._connect(address, {
      ...options(), onProgress: () => { throw error },
    })
    const done = observe(result)
    const socket = createdSocket()
    await turn()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    socket.finishClose()
    await expect(result).rejects.toBe(error)
    for (const type of ['open', 'error', 'close']) expect(getEventListeners(socket, type)).toHaveLength(0)
  })

  it('does not return a socket that closes just after open', async () => {
    const result = transport()._connect(address, options())
    observe(result)
    const socket = createdSocket()
    socket.open()
    socket.finishClose(false)
    await expect(result).rejects.toMatchObject({ name: 'ConnectionFailedError' })
  })

  it('retains handshake ownership if the close call itself throws', async () => {
    const controller = new AbortController()
    const result = transport()._connect(address, options(controller.signal))
    const done = observe(result)
    const socket = createdSocket()
    socket.close.mockImplementation(() => { throw new Error('close failed') })
    controller.abort()
    await turn()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    socket.finishClose(false)
    await expect(result).rejects.toMatchObject({ name: 'ConnectionFailedError' })
  })

  it('does not deliver an open socket when abort happens in the same turn', async () => {
    const controller = new AbortController()
    const result = transport()._connect(address, options(controller.signal))
    const done = observe(result)
    const socket = createdSocket()
    socket.open()
    controller.abort()
    await turn()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    socket.finishClose()
    await expect(result).rejects.toMatchObject({ name: 'ConnectionFailedError' })
  })

  it('does not hand a cancelled socket to the upgrader across the _connect await boundary', async () => {
    const controller = new AbortController()
    const upgrader = vi.fn(async () => ({} as Connection))
    const instance = transport()
    const connect = instance._connect.bind(instance)
    instance._connect = async (...args) => {
      const socket = await connect(...args)
      controller.abort()
      return socket
    }
    const result = instance.dial(address, options(controller.signal, upgrader))
    const done = observe(result)
    const socket = createdSocket()
    socket.open()
    await turn()
    expect(upgrader).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    socket.finishClose()
    await expect(result).rejects.toBeDefined()
  })

  it('keeps a successful socket open and waits for upgrade failure cleanup', async () => {
    const error = new Error('upgrade failed')
    const upgrader = vi.fn(async () => { throw error })
    let owned!: WebSocketMultiaddrConnection
    const result = transport({ onConnection: (connection: WebSocketMultiaddrConnection) => { owned = connection } }).dial(address, options(undefined, upgrader))
    const done = observe(result)
    const socket = createdSocket()
    socket.open()
    await turn()
    expect(upgrader).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    const exited = observe(owned.closed)
    await turn()
    expect(exited).not.toHaveBeenCalled()
    socket.finishClose()
    await expect(result).rejects.toBe(error)
    await owned.closed
  })

  it.each([true, false])('delivers the local abort error only after native close (clean=%s)', async wasClean => {
    const { socket, maConn } = await connected()
    expect(socket.close).not.toHaveBeenCalled()
    const error = new Error('protocol rejected')
    const terminal = vi.fn<(event: StreamCloseEvent) => void>()
    maConn.addEventListener('close', terminal)
    maConn.abort(error)
    expect(maConn.status).toBe('aborted')
    expect(() => maConn.send(new Uint8Array([1]))).toThrow()
    expect(terminal).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledWith()
    expect(socket.readyState).toBe(2)
    const exited = observe(maConn.closed)
    const closing = maConn.close({ signal: AbortSignal.abort() })
    const done = observe(closing)
    await turn()
    expect(exited).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()
    socket.finishClose(wasClean)
    await closing
    await maConn.closed
    expect(terminal).toHaveBeenCalledOnce()
    const call = terminal.mock.calls[0]
    assert.ok(call)
    expect(call[0].error).toBe(error)
    expect(call[0].local).toBe(true)
    expect(getEventListeners(socket, 'message')).toHaveLength(0)
    expect(getEventListeners(socket, 'close')).toHaveLength(0)
  })

  it('waits for physical close after an invalid binary message', async () => {
    const { socket, maConn } = await connected()
    const exited = observe(maConn.closed)
    const terminal = vi.fn<(event: StreamCloseEvent) => void>()
    maConn.addEventListener('close', terminal)
    socket.message({ invalid: true })
    await turn()
    expect(maConn.status).toBe('aborted')
    expect(socket.readyState).toBe(2)
    expect(exited).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()
    socket.finishClose(false)
    await maConn.closed
    expect(terminal).toHaveBeenCalledOnce()
    const call = terminal.mock.calls[0]
    assert.ok(call)
    expect(call[0].error).toBeInstanceOf(Error)
  })

  it('observes unclean remote socket exit without initiating another close', async () => {
    const { socket, maConn } = await connected()
    socket.finishClose(false)
    await maConn.closed
    expect(maConn.status).toBe('reset')
    expect(socket.close).not.toHaveBeenCalled()
    expect(getEventListeners(socket, 'message')).toHaveLength(0)
  })

  it('aborts a cancelled drain but does not settle close before physical exit', async () => {
    vi.useFakeTimers()
    try {
      const { socket, maConn } = await connected({ maxBufferedAmount: 1, bufferedAmountPollInterval: 10 })
      socket.bufferedAmount = 2
      maConn.send(new Uint8Array([1, 2]))
      const controller = new AbortController()
      const closing = maConn.close({ signal: controller.signal })
      const done = observe(closing)
      const terminal = vi.fn()
      maConn.addEventListener('close', terminal)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.close).toHaveBeenCalledWith()
      expect(socket.readyState).toBe(2)
      expect(done).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()
      socket.finishClose()
      await expect(closing).rejects.toBeDefined()
      await maConn.closed
      expect(terminal).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains a pre-aborted graceful close until native exit', async () => {
    const { socket, maConn } = await connected()
    const closing = maConn.close({ signal: AbortSignal.abort() })
    const done = observe(closing)
    const terminal = vi.fn()
    maConn.addEventListener('close', terminal)
    await turn()
    expect(socket.readyState).toBe(2)
    expect(done).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()
    socket.finishClose()
    await expect(closing).rejects.toMatchObject({ name: 'AbortError' })
    await maConn.closed
    expect(terminal).toHaveBeenCalledOnce()
  })

  it('waits for buffered data to drain and then for the actual close handshake', async () => {
    vi.useFakeTimers()
    try {
      const { socket, maConn } = await connected({ maxBufferedAmount: 1, bufferedAmountPollInterval: 10 })
      socket.bufferedAmount = 2
      maConn.send(new Uint8Array([1, 2]))
      const closing = maConn.close()
      const done = observe(closing)
      await vi.advanceTimersByTimeAsync(10)
      expect(socket.close).not.toHaveBeenCalled()
      socket.bufferedAmount = 0
      await vi.advanceTimersByTimeAsync(10)
      expect(socket.close).toHaveBeenCalledOnce()
      expect(done).not.toHaveBeenCalled()
      socket.finishClose()
      await closing
      await maConn.closed
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
