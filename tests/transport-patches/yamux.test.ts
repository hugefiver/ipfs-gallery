import { yamux, type YamuxMuxerInit } from '@libp2p/yamux'
import { afterEach, describe, expect, it, vi } from 'vitest'

const INITIAL_WINDOW = 256 * 1024
const CAP = 1024 * 1024
const DATA = 0
const WINDOW_UPDATE = 1
const PING = 2
const GO_AWAY = 3
const SYN = 1
const ACK = 2
const FIN = 4
const RST = 8
type Transport = Parameters<ReturnType<ReturnType<typeof yamux>>['createStreamMuxer']>[0]
type Bytes = Parameters<Transport['send']>[0]
type Muxer = ReturnType<ReturnType<ReturnType<typeof yamux>>['createStreamMuxer']>

const log = Object.assign(() => {}, {
  trace: () => {},
  error: () => {},
  newScope: () => log,
})

function bytes(data: Bytes): Uint8Array {
  return data instanceof Uint8Array ? data : data.subarray()
}

function join(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function header(type: number, stream: number, length: number, flag = 0): Uint8Array {
  const output = new Uint8Array(12)
  const view = new DataView(output.buffer)
  output[1] = type
  view.setUint16(2, flag)
  view.setUint32(4, stream)
  view.setUint32(8, length)
  return output
}

function payload(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 251)
}

class ControlledTransport extends EventTarget implements Pick<Transport, 'direction' | 'send' | 'abort' | 'readableEnded'> {
  direction: 'inbound' | 'outbound' = 'inbound'
  log = log
  sent: Uint8Array[] = []
  errors: Error[] = []
  closed = false
  peer?: ControlledTransport

  get readableEnded(): boolean {
    return this.closed
  }

  send(data: Bytes): boolean {
    this.sent.push(bytes(data).slice())
    if (this.peer != null) {
      const peer = this.peer
      queueMicrotask(() => {
        if (!peer.closed) peer.receive(data)
      })
    }
    return true
  }

  receive(data: Bytes): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }

  abort(error: Error): void {
    this.errors.push(error)
    this.finishClose()
  }

  finishClose(): void {
    if (this.closed) return
    this.closed = true
    this.dispatchEvent(new Event('end'))
    this.dispatchEvent(new Event('close'))
  }
}

const muxers: Muxer[] = []

afterEach(() => {
  for (const muxer of muxers.splice(0)) muxer.abort(new Error('Test cleanup'))
})

function create(init: YamuxMuxerInit = {}, transport = new ControlledTransport()) {
  const muxer = yamux({ enableKeepAlive: false, ...init })().createStreamMuxer(transport as unknown as Transport)
  muxers.push(muxer)
  const messages: Array<{ stream: number, data: Bytes }> = []
  muxer.addEventListener('stream', event => {
    event.detail.addEventListener('message', message => {
      messages.push({ stream: event.detail.streamId, data: message.data })
    })
  })
  return { muxer, transport, messages }
}

function options(window = INITIAL_WINDOW): YamuxMuxerInit {
  return {
    maxIncomingFrameDataLength: CAP,
    streamOptions: { initialStreamWindowSize: window, maxStreamWindowSize: CAP },
  }
}

// Inspect retained storage, not source text or a heap/GC timing heuristic.
function retained(muxer: Muxer) {
  return Reflect.get(muxer, 'decoder') as {
    buffer: Uint8Array
    bufferedLength: number
    header?: { length: number }
  }
}

function expectCleared(muxer: Muxer): void {
  expect(retained(muxer).bufferedLength).toBe(0)
  expect(retained(muxer).buffer.buffer.byteLength).toBe(12)
  expect(retained(muxer).header).toBeUndefined()
}

describe('Yamux incoming Data frame limits through the package factory', () => {
  it.each([CAP + 1, 0xffffffff])('rejects a header declaring %i bytes without a body and aborts the transport', length => {
    const { muxer, transport, messages } = create(options())
    expect(transport.readableEnded).toBe(false)
    transport.receive(header(DATA, 1, length, SYN))
    expect(transport.errors.map(error => error.name)).toEqual(['InvalidFrameError'])
    expect(transport.closed).toBe(true)
    expect(transport.readableEnded).toBe(true)
    expect(muxer.status).toBe('closed')
    expect(messages).toHaveLength(0)
    expect(transport.sent.some(data => data[1] === GO_AWAY && new DataView(data.buffer, data.byteOffset).getUint32(8) === 1)).toBe(true)
    expectCleared(muxer)
    for (let i = 0; i < 100; i++) transport.receive(new Uint8Array(1024))
    expectCleared(muxer)
    expect(messages).toHaveLength(0)
  })

  it.each(Array.from({ length: 11 }, (_, index) => index + 1))('rejects as soon as split header %i/12 completes', split => {
    const { muxer, transport } = create(options())
    const frame = header(DATA, 1, 0xffffffff, SYN)
    transport.receive(frame.subarray(0, split))
    expect(transport.errors).toHaveLength(0)
    expect(retained(muxer).bufferedLength).toBe(split)
    expect(retained(muxer).buffer.buffer).not.toBe(frame.buffer)
    transport.receive(frame.subarray(split))
    expect(transport.errors.map(error => error.name)).toEqual(['InvalidFrameError'])
    expectCleared(muxer)
  })

  it('does not inspect or copy the oversized body of a coalesced malicious chunk', () => {
    const { muxer, transport } = create(options())
    const input = new Uint8Array(2 * CAP)
    input.set(header(DATA, 1, 0xffffffff, SYN))
    const reads = vi.spyOn(input, 'subarray')
    transport.receive(input)
    expect(reads.mock.calls).toEqual([[0, 12]])
    expect(transport.errors[0]?.name).toBe('InvalidFrameError')
    expectCleared(muxer)
  })

  it('uses a finite default cap based on the effective maximum receive window', () => {
    const small = create({ streamOptions: { maxStreamWindowSize: INITIAL_WINDOW } })
    small.transport.receive(header(DATA, 1, INITIAL_WINDOW + 1, SYN))
    expect(small.transport.errors[0]?.name).toBe('InvalidFrameError')
    const normal = create()
    normal.transport.receive(header(DATA, 1, 16 * CAP + 1, SYN))
    expect(normal.transport.errors[0]?.name).toBe('InvalidFrameError')
  })

  it.each([
    { streamOptions: { initialStreamWindowSize: INITIAL_WINDOW - 1 } },
    { streamOptions: { initialStreamWindowSize: 16 * CAP + 1 } },
    { streamOptions: { maxStreamWindowSize: INITIAL_WINDOW - 1 } },
    { streamOptions: { initialStreamWindowSize: CAP, maxStreamWindowSize: INITIAL_WINDOW } },
    { streamOptions: { maxStreamWindowSize: 0x100000000 } },
    { streamOptions: { initialStreamWindowSize: INITIAL_WINDOW + 0.5 } },
    { streamOptions: { maxStreamWindowSize: CAP + 0.5 } },
    { maxIncomingFrameDataLength: CAP + 0.5, streamOptions: { maxStreamWindowSize: CAP } },
    { maxIncomingFrameDataLength: CAP },
    { maxIncomingFrameDataLength: CAP - 1, streamOptions: { maxStreamWindowSize: CAP } },
    ...[NaN, Infinity, -Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
      { maxIncomingFrameDataLength: value },
      { streamOptions: { initialStreamWindowSize: value } },
      { streamOptions: { maxStreamWindowSize: value } },
    ]),
  ])('validates resolved window and cap configuration %j', init => {
    expect(() => create(init)).toThrow(expect.objectContaining({ name: 'InvalidParametersError' }))
  })

  it('accepts safe explicit windows and a cap above the effective maximum window', () => {
    const { transport } = create({ ...options(), maxIncomingFrameDataLength: 2 * CAP })
    transport.receive(header(DATA, 1, CAP + 1, SYN))
    expect(transport.errors).toHaveLength(0)
    const maxWireWindow = create({ streamOptions: { maxStreamWindowSize: 0xffffffff } })
    maxWireWindow.transport.receive(header(PING, 0, 0xffffffff, SYN))
    expect(maxWireWindow.transport.errors).toHaveLength(0)
  })

  it('decodes multiple cap-sized frames and streams from one input larger than the cap', () => {
    const { muxer, transport, messages } = create(options(CAP))
    const body = payload(CAP)
    const input = join(header(DATA, 1, CAP, SYN), body, header(DATA, 3, CAP, SYN), body, header(DATA, 1, CAP), body)
    transport.receive(input)
    expect(transport.errors).toHaveLength(0)
    expect(messages.map(message => message.stream)).toEqual([1, 3, 1])
    for (const message of messages) {
      expect(Buffer.from(bytes(message.data)).equals(Buffer.from(body))).toBe(true)
      for (const chunk of message.data instanceof Uint8Array ? [message.data] : message.data) {
        expect(chunk.buffer.byteLength).toBeLessThanOrEqual(CAP)
        expect(chunk.buffer).not.toBe(input.buffer)
      }
    }
    expect(transport.sent.filter(data => data[1] === WINDOW_UPDATE)).toHaveLength(3)
    expectCleared(muxer)
  })

  it('retains only owned bounded storage across fragmented bodies and a tiny coalesced tail', () => {
    const { muxer, transport, messages } = create(options(CAP))
    const body = payload(CAP)
    const next = header(DATA, 1, CAP)
    const input = join(header(DATA, 1, CAP, SYN), body, header(DATA, 1, CAP), body, next.subarray(0, 5))
    transport.receive(input)
    expect(retained(muxer).bufferedLength).toBe(5)
    expect(retained(muxer).buffer.buffer.byteLength).toBe(12)
    expect(retained(muxer).buffer.buffer).not.toBe(input.buffer)
    transport.receive(next.subarray(5))
    for (let offset = 0; offset < body.byteLength; offset += 997) {
      transport.receive(body.subarray(offset, offset + 997))
      expect(retained(muxer).bufferedLength).toBeLessThanOrEqual(CAP)
      expect(retained(muxer).buffer.buffer.byteLength).toBeLessThanOrEqual(CAP)
      expect(retained(muxer).buffer.buffer).not.toBe(body.buffer)
    }
    expect(messages).toHaveLength(3)
    expect(Buffer.from(bytes(messages[2]!.data)).equals(Buffer.from(body))).toBe(true)
    expect(transport.errors).toHaveLength(0)
    expectCleared(muxer)
  })

  it('still rejects Data exceeding the actual remaining per-stream receive window', () => {
    const { muxer, transport, messages } = create(options())
    transport.receive(join(header(DATA, 1, INITIAL_WINDOW + 1, SYN), new Uint8Array(INITIAL_WINDOW + 1)))
    expect(transport.errors[0]?.name).toBe('ReceiveWindowExceededError')
    expect(messages).toHaveLength(0)
    expectCleared(muxer)
  })

  it('preserves zero-length Data, FIN/RST, window deltas, ping IDs and GoAway reasons', () => {
    const { muxer, transport } = create(options())
    transport.receive(join(header(DATA, 1, 0, SYN), header(WINDOW_UPDATE, 1, 0xffffffff)))
    const stream = muxer.streams[0]!
    expect(stream.maxMessageSize).toBe(INITIAL_WINDOW + 0xffffffff - 12)
    transport.receive(header(PING, 0, 0xffffffff, SYN))
    expect(transport.sent.some(data => data[1] === PING && data[3] === ACK && new DataView(data.buffer, data.byteOffset).getUint32(8) === 0xffffffff)).toBe(true)
    transport.receive(header(DATA, 1, 0, FIN))
    expect(stream.remoteWriteStatus).toBe('closed')
    transport.receive(header(WINDOW_UPDATE, 1, 0, RST))
    expect(stream.status).toBe('reset')
    transport.receive(header(GO_AWAY, 0, 0xffffffff))
    expect(muxer.status).toBe('closed')
    expect(transport.errors).toHaveLength(0)
    expectCleared(muxer)
  })

  it.each(['abort', 'transport-close', 'close'] as const)('releases an incomplete body on %s', async action => {
    const { muxer, transport } = create(options())
    transport.receive(join(header(DATA, 1, CAP, SYN), new Uint8Array(23)))
    expect(retained(muxer).bufferedLength).toBe(23)
    if (action === 'abort') muxer.abort(new Error('Stopped'))
    if (action === 'transport-close') transport.finishClose()
    if (action === 'close') await muxer.close()
    expectCleared(muxer)
  })

  it('clears invalid-version headers and frame-consumer protocol errors', () => {
    const invalidVersion = create(options())
    const bad = header(DATA, 1, 0, SYN)
    bad[0] = 1
    invalidVersion.transport.receive(bad)
    expect(invalidVersion.transport.errors[0]?.name).toBe('InvalidFrameError')
    expectCleared(invalidVersion.muxer)
    const invalidType = create(options())
    invalidType.transport.receive(header(255, 1, 0xffffffff))
    expect(invalidType.transport.errors[0]?.name).toBe('InvalidFrameError')
    expectCleared(invalidType.muxer)
  })

  it('transfers a 2 MiB block and a sub-4 MiB encoded message using standard frames and window replenishment', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const left = new ControlledTransport()
    left.direction = 'outbound'
    const right = new ControlledTransport()
    left.peer = right
    right.peer = left
    const sender = create(options(), left)
    const receiver = create(options(), right)
    await sender.muxer.ping()
    await receiver.muxer.ping()
    const first = await sender.muxer.createStream()
    const second = await sender.muxer.createStream()
    const block = payload(2 * CAP)
    const encoded = join(new Uint8Array([0x80, 0x80, 0xc0, 0x01]), payload(3 * CAP))
    first.send(block)
    second.send(encoded)
    const closed = sender.muxer.close()
    const received = (id: number) => join(...receiver.messages.filter(message => message.stream === id).map(message => bytes(message.data)))
    await vi.waitFor(() => {
      expect(receiver.messages.filter(message => message.stream === first.streamId).reduce((sum, message) => sum + message.data.byteLength, 0)).toBe(block.byteLength)
      expect(receiver.messages.filter(message => message.stream === second.streamId).reduce((sum, message) => sum + message.data.byteLength, 0)).toBe(encoded.byteLength)
    })
    expect(Buffer.from(received(first.streamId)).equals(Buffer.from(block))).toBe(true)
    expect(Buffer.from(received(second.streamId)).equals(Buffer.from(encoded))).toBe(true)
    expect(left.sent.filter(data => data[1] === DATA).length).toBeGreaterThan(2)
    const dataLengths = left.sent.filter(data => data[1] === DATA).map(data => new DataView(data.buffer, data.byteOffset).getUint32(8))
    expect(Math.max(...dataLengths)).toBeGreaterThan(INITIAL_WINDOW)
    expect(Math.max(...dataLengths)).toBeLessThanOrEqual(CAP)
    expect(right.sent.filter(data => data[1] === WINDOW_UPDATE).length).toBeGreaterThan(2)
    expect(left.errors).toHaveLength(0)
    expect(right.errors).toHaveLength(0)
    expectCleared(receiver.muxer)
    await closed
  })
})
