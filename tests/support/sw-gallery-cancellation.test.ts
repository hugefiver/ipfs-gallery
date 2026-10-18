import { expect, it } from 'vitest'
import { WindowBlockSource } from '../../src/service-worker/window-source'
import { WindowOwnership } from '../../src/service-worker/ownership'
import { environment } from '../service-worker/bridge-fixture'
import { block, config, deferred } from '../service-worker/helpers'

it('settles a pending cancellation when the same binding close proves all remote work drained', async () => {
  const cleanups: Array<() => void | Promise<void>> = []
  const started = deferred<void>()
  const cleanup = deferred<void>()
  const fixture = environment(cleanups, (_cid, signal) => {
    started.resolve()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, true, () => cleanup.promise)
  let heldCancel = false
  let sentClose = false
  fixture.env.channel = () => {
    const channel = new MessageChannel()
    const commands = new Map<number, string>()
    channel.port2.addEventListener('message', event => {
      const message = event.data as { sequence: number; type: string }
      commands.set(message.sequence, message.type)
    })
    const post = channel.port2.postMessage.bind(channel.port2)
    channel.port2.postMessage = (value: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
      const response = value as { sequence: number; ok: boolean }
      if (commands.get(response.sequence) === 'cancel-block') {
        // Close may acknowledge its drain before the cancellation response reaches the retired port.
        heldCancel = true
        return
      }
      if (commands.get(response.sequence) === 'close' && response.ok) sentClose = true
      if (Array.isArray(options)) post(value, options)
      else post(value, options)
    }
    return channel
  }
  const ownership = new WindowOwnership()
  const source = new WindowBlockSource('cancelled-session', config, fixture.env, ownership)
  const read = source.get(1, (await block()).cid, new AbortController().signal).catch(error => error)
  try {
    await started.promise
    const cancellation = source.cancel(1).then(() => undefined, error => error)
    source.dispose()
    cleanup.resolve()
    expect(await read).toMatchObject({ error: { code: 'CANCELLED' } })
    await source.settled()
    expect(heldCancel).toBe(true)
    expect(sentClose).toBe(true)
    expect(ownership.usage()).toEqual({ debts: 0, quarantined: false })
    expect(await cancellation).toBeUndefined()
    expect(fixture.runtime().usage()).toMatchObject({ bindings: 0, consumers: 0, flights: 0 })
  } finally {
    cleanup.resolve()
    source.dispose()
    for (const close of cleanups.reverse()) await close()
  }
})
