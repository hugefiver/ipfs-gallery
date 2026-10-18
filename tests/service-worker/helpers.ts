import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { BUILD_POLICY } from '../../src/shared/build-policy'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import type { SessionConfig } from '../../src/shared/contracts'
import type { VerifiedBlockSource } from '../../src/network/types'
import { BLOCK_PATH, HEADERS, VERSION } from '../../src/service-worker/protocol'
import { PortRpc } from '../../src/service-worker/rpc'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'

export const config: SessionConfig = { gateways: DEFAULT_GATEWAYS.slice(0, 2), limits: { ...DEFAULT_LIMITS } }
export const scope = 'https://gallery.example/gallery/'
export const client = { id: 'actual-window', type: 'window', url: scope }
const ownerIds = new WeakMap<object, Map<string, { ownerId: string; secret: string; attempt: number }>>()
export async function block(text = 'verified fixture bytes') {
  const bytes = new TextEncoder().encode(text)
  return { bytes, cid: CID.createV1(0x55, await sha256.digest(bytes)).toString() }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function binding(runtime: ReturnType<typeof createServiceWorkerRuntime>,
  owner = client, settings = config) {
  const { port1, port2 } = new MessageChannel()
  const response = new Promise<Record<string, unknown>>(resolve => { port1.onmessage = event => resolve(event.data); port1.start() })
  let identities = ownerIds.get(runtime)
  if (!identities) { identities = new Map(); ownerIds.set(runtime, identities) }
  let ownership = identities.get(owner.id)
  if (!ownership) { ownership = { ownerId: crypto.randomUUID(), secret: crypto.randomUUID(), attempt: 0 }; identities.set(owner.id, ownership) }
  ownership.attempt++
  await runtime.open({ v: VERSION, type: 'open', sessionId: 'session', config: settings,
     ...ownership, boot: runtime.epoch, policy: BUILD_POLICY }, owner, port2)
  const envelope = await response
  if (!envelope.ok) { port1.close(); throw envelope.error }
  const identity = envelope.value as { sessionId: string; bindingId: string; epoch: string; capability: string }
  const rpc = new PortRpc(port1)
  const control = (type: string, fields = {}) => rpc.request({ type, sessionId: identity.sessionId,
    bindingId: identity.bindingId, epoch: identity.epoch, ...fields })
  async function prepare(cid: string, blockRequestId: number) {
    const { ticket } = await control('prepare-block', { cid, blockRequestId }) as { ticket: string }
    const headers = new Headers({ [HEADERS.version]: String(VERSION), [HEADERS.bindingId]: identity.bindingId,
      [HEADERS.epoch]: identity.epoch, [HEADERS.capability]: identity.capability,
      [HEADERS.blockRequestId]: String(blockRequestId), [HEADERS.ticket]: ticket })
    return new Request(new URL(`${BLOCK_PATH}${cid}`, scope), { headers })
  }
  async function read(blockRequestId: number): Promise<Uint8Array> {
    const value = await control('read-block', { blockRequestId }) as { bytes: ArrayBuffer }
    return new Uint8Array(value.bytes)
  }
  return { identity, control, prepare, read, rpc }
}
export function source(get: VerifiedBlockSource['get']): VerifiedBlockSource {
  return { get, snapshot: () => [], dispose: () => {} }
}
