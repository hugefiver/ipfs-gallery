import { expect, it } from 'vitest'
import { PortRpc } from '../../src/service-worker/rpc'
import { VERSION } from '../../src/service-worker/protocol'

it('rejects the matched request and all remaining requests when an error payload is malformed', async () => {
  const { port1, port2 } = new MessageChannel()
  const rpc = new PortRpc(port1)
  let first: unknown
  let second: unknown
  const one = rpc.request({ type: 'first' }).catch(error => { first = error; return error })
  const two = rpc.request({ type: 'second' }).catch(error => { second = error; return error })
  try {
    port2.postMessage({ v: VERSION, sequence: 1, ok: false, error: { code: 'NETWORK', retryable: true } })
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(first).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(second).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  } finally { rpc.close(); port2.close(); await two }
  if (first) await one
})

it('rejects an unexpected transferred port instead of accepting a private delivery reply', async () => {
  const { port1, port2 } = new MessageChannel()
  const extra = new MessageChannel()
  const rpc = new PortRpc(port1)
  const request = rpc.request({ type: 'read-block' })
  try {
    port2.postMessage({ v: VERSION, sequence: 1, ok: true, value: null }, [extra.port2])
    await expect(request).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
  } finally { rpc.close(); port2.close(); extra.port1.close() }
})
