import type { GatewayStat, SessionConfig } from '../shared/contracts'
import { BUILD_POLICY } from '../shared/build-policy'
import { GalleryDomainError } from '../shared/errors'
import type { VerifiedBlockSource } from '../network/types'
import { parseBlockCid, verifyBlock } from '../network/verify'
import { BOUNDS, canonicalCid, domain, exact, galleryError, matchingBuildPolicy, noPorts, sessionConfig, stats, VERSION } from '../service-worker/protocol'
import { PortRpc, reject, reply } from '../service-worker/rpc'
import { latch, WindowOwnership } from '../service-worker/ownership'
import { applicationBase, WindowBlockSource, type WindowSourceEnvironment } from '../service-worker/window-source'
import { record, validIdentity } from './protocol'

export const BRIDGE_OPEN = 'ipfs-gallery-block-bridge'
export const BRIDGE_FAULT = 'ipfs-gallery-block-bridge-fault'
export function createBridgedBlockSource(config: SessionConfig, sessionId: string,
  post: (value: unknown, transfer: Transferable[]) => void): VerifiedBlockSource {
  let rpc: PortRpc | undefined
  let opening: Promise<PortRpc> | undefined
  let faulted = false
  const work = new Set<ReturnType<typeof latch>>()
  function fault(): void {
    if (faulted || work.size === 0) return
    faulted = true
    post({ type: BRIDGE_FAULT, v: VERSION, sessionId }, [])
  }
  function connect(): Promise<PortRpc> {
    if (faulted) return Promise.reject(domain('NETWORK'))
    if (rpc) return Promise.resolve(rpc)
    if (opening) return opening
    const { port1, port2 } = new MessageChannel()
    opening = new Promise((resolve, reject) => {
      const fail = (error: unknown) => { clearTimeout(timer); port1.close(); reject(error) }
      const timer = setTimeout(() => fail(domain('TIMEOUT')), BOUNDS.handshakeMs)
      port1.onmessageerror = () => fail(domain('NETWORK'))
      port1.onmessage = event => {
        try {
          noPorts(event)
          const value: unknown = event.data
          exact(value, record(value) && value.ok === true ? ['v', 'sequence', 'ok', 'value'] : ['v', 'sequence', 'ok', 'error'])
          if (value.v !== VERSION || value.sequence !== 0 || typeof value.ok !== 'boolean') throw domain('INVALID_INPUT')
          if (!value.ok) throw new GalleryDomainError(galleryError(value.error))
          exact(value.value, ['sessionId', 'policy'])
          if (value.value.sessionId !== sessionId) throw domain('INVALID_INPUT')
          matchingBuildPolicy(value.value.policy)
          clearTimeout(timer)
          rpc = new PortRpc(port1, fault)
          resolve(rpc)
        } catch (error) { fail(error) }
      }
      port1.start()
      try { post({ type: BRIDGE_OPEN, v: VERSION, sessionId, config, policy: BUILD_POLICY }, [port2]) }
      catch (error) { port2.close(); fail(error) }
    })
    return opening
  }
  function finish(task: ReturnType<typeof latch>): void { work.delete(task); task.resolve() }
  let nextId = 0
  let disposed = false
  let gateways: GatewayStat[] = []
  return {
    async get(text, signal) {
      signal.throwIfAborted()
      if (disposed || faulted) throw domain('CANCELLED')
      const cid = parseBlockCid(text, config.limits.maxBlockBytes)
      if (cid.multihash.code === 0) {
        const bytes = cid.multihash.digest.slice()
        await verifyBlock(cid, bytes, config.limits.maxBlockBytes)
        signal.throwIfAborted()
        return bytes
      }
      if (work.size >= BOUNDS.perBinding) throw domain('LIMIT')
      const task = latch()
      work.add(task)
      let connection: PortRpc
      try {
        connection = await connect()
        if (disposed || signal.aborted) throw domain('CANCELLED')
      } catch (error) {
        // No block demand was sent; a port announcement alone cannot admit SW work.
        finish(task)
        throw error
      }
      const fields = { sessionId, blockRequestId: ++nextId }
      let cancelling: Promise<unknown> | undefined
      function proof(type: string): Promise<unknown> {
        const result = connection.request({ type, ...fields }, config.limits.blockTimeoutMs + BOUNDS.handshakeMs)
        void result.then(() => finish(task), fault)
        return result
      }
      const abort = () => { cancelling ??= proof('cancel'); void cancelling.catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        const value = await connection.request({ type: 'get', ...fields, cid: cid.toV1().toString() },
          config.limits.blockTimeoutMs + BOUNDS.handshakeMs * 4)
        exact(value, ['sessionId', 'blockRequestId', 'cid', 'byteLength', 'bytes', 'gateways', 'policy'])
        matchingBuildPolicy(value.policy)
        if (value.sessionId !== sessionId || value.blockRequestId !== fields.blockRequestId || value.cid !== cid.toV1().toString()
          || !(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength > config.limits.maxBlockBytes
          || value.byteLength !== value.bytes.byteLength) throw domain('INTEGRITY')
        const bytes = new Uint8Array(value.bytes)
        if (BUILD_POLICY.trustless) await verifyBlock(cid, bytes, config.limits.maxBlockBytes)
        signal.throwIfAborted()
        if (disposed) throw domain('CANCELLED')
        gateways = stats(value.gateways, config)
        await proof('consume')
        return bytes
      } catch (error) {
        cancelling ??= proof('discard')
        void cancelling.catch(() => {})
        throw error
      } finally { signal.removeEventListener('abort', abort) }
    },
    settled: () => Promise.all([...work].map(task => task.promise)).then(() => {}),
    snapshot: () => gateways.map(value => ({ ...value })),
    dispose() {
      if (disposed) return
      disposed = true
      const tasks = [...work]
      const close = (connection: PortRpc) => {
        void connection.request({ type: 'close', sessionId }, config.limits.blockTimeoutMs + BOUNDS.handshakeMs)
          .then(() => { for (const task of tasks) finish(task) }, fault)
          .finally(() => connection.close()).catch(() => {})
      }
      if (rpc) close(rpc)
      // Failed initialization is reported by get and has admitted no remote work to drain.
      else if (opening) void opening.then(close, () => {})
    },
  }
}

function browserEnvironment(): WindowSourceEnvironment {
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator)) throw domain('UNSUPPORTED')
  return { base: applicationBase(), serviceWorker: navigator.serviceWorker,
    fetch: globalThis.fetch.bind(globalThis), channel: () => new MessageChannel() }
}

interface RelayTask {
  controller: AbortController; local: ReturnType<typeof latch>; remote: Promise<void>
  wake: ReturnType<typeof latch>; source?: WindowBlockSource
  timer?: ReturnType<typeof setTimeout>
}
/** Relay reservations survive private-port closure and are released only by positive remote proof. */
export function attachWindowBlockBridge(value: unknown, port: MessagePort,
  environment: () => WindowSourceEnvironment = browserEnvironment, onClose: () => void = () => {},
  relay = { count: 0, bytes: 0 }, ownership = new WindowOwnership()): () => void {
  exact(value, ['type', 'v', 'sessionId', 'config', 'policy'])
  if (value.type !== BRIDGE_OPEN || value.v !== VERSION || !validIdentity(value.sessionId)) throw domain('INVALID_INPUT')
  matchingBuildPolicy(value.policy)
  const config = sessionConfig(value.config)
  const sessionId = value.sessionId
  const tasks = new Map<number, RelayTask>()
  let source: WindowBlockSource | undefined
  let sequence = 0
  let lastBlock = 0
  let controls = 0
  let closed = false
  let idle: ReturnType<typeof setTimeout> | undefined
  let retiring: Promise<void> | undefined
  function armIdle(): void {
    clearTimeout(idle)
    if (!closed) idle = setTimeout(() => {
      if (tasks.size || controls) { armIdle(); return }
      if (!source || ownership.quarantined) return
      const old = source
      const retirement = old.retireIdle().then(() => { if (source === old) source = undefined })
      retiring = retirement
      void retirement.finally(() => {
        if (retiring === retirement) retiring = undefined
        for (const task of tasks.values()) task.wake.resolve()
      }).catch(() => {})
      // Keep the private port: the next demand creates a fresh SW binding after positive cleanup.
    }, BOUNDS.idleMs)
  }
  function release(id: number): void {
    clearTimeout(tasks.get(id)?.timer)
    if (!tasks.delete(id)) return
    relay.count--; relay.bytes -= config.limits.maxBlockBytes
  }
  function dispose(): void {
    if (closed) return
    closed = true
    clearTimeout(idle)
    for (const task of tasks.values()) task.controller.abort(domain('CANCELLED'))
    source?.dispose()
    port.close()
    onClose()
  }
  async function command(message: Record<string, unknown>): Promise<{ value: unknown; transfer?: Transferable[] }> {
    const id = message.blockRequestId as number
    if (closed) throw domain('CANCELLED')
    if (message.type === 'get') {
      if (id <= lastBlock) throw domain('INVALID_INPUT')
      lastBlock = id
      if (tasks.size >= BOUNDS.perBinding || relay.count >= BOUNDS.perBinding
        || relay.bytes + config.limits.maxBlockBytes > BOUNDS.responseBytes) throw domain('LIMIT')
      const task: RelayTask = { controller: new AbortController(), local: latch(), remote: Promise.resolve(), wake: latch() }
      task.controller.signal.addEventListener('abort', task.wake.resolve, { once: true })
      tasks.set(id, task)
      relay.count++; relay.bytes += config.limits.maxBlockBytes
      try {
        const retirement = retiring
        if (retirement) {
          // Cancellable local demand owns no part of the old binding's drain.
          await task.wake.promise
          task.controller.signal.throwIfAborted()
          await retirement
        }
        task.controller.signal.throwIfAborted()
        if (closed) throw domain('CANCELLED')
        if (ownership.quarantined) throw domain('NETWORK')
        source ??= new WindowBlockSource(sessionId, config, environment(), ownership)
        task.source = source
        const result = task.source.get(id, message.cid as string, task.controller.signal)
        task.remote = task.source.settled()
        const bytes = await result
        task.timer = setTimeout(() => { void task.source?.acknowledge(id, true).catch(() => {}) }, BOUNDS.bodyMs)
        return { value: { sessionId, blockRequestId: id, cid: message.cid, byteLength: bytes.byteLength,
          bytes, gateways: task.source.snapshot(), policy: BUILD_POLICY }, transfer: [bytes] }
      } finally {
        task.local.resolve()
        void Promise.all([task.local.promise, task.remote]).then(() => release(id)).catch(() => {})
      }
    }
    if (message.type === 'close') {
      const pending = [...tasks.values()]
      for (const task of pending) task.controller.abort(domain('CANCELLED'))
      source?.dispose()
      await Promise.all(pending.map(task => Promise.all([task.local.promise, task.remote])))
      return { value: null }
    }
    if (id > lastBlock) throw domain('INVALID_INPUT')
    const task = tasks.get(id)
    if (message.type === 'cancel') {
      task?.controller.abort(domain('CANCELLED'))
      await task?.source?.cancel(id)
    } else if (message.type !== 'settled') await task?.source?.acknowledge(id, message.type === 'discard')
    if (task) await Promise.all([task.local.promise, task.remote])
    return { value: null }
  }
  port.onmessage = event => {
    let current = record(event.data) && Number.isSafeInteger(event.data.sequence) ? event.data.sequence as number : 0
    try {
      noPorts(event)
      const message: unknown = event.data
      if (!record(message) || message.v !== VERSION || message.sessionId !== sessionId
        || !Number.isSafeInteger(message.sequence) || (message.sequence as number) <= sequence) throw domain('INVALID_INPUT')
      current = message.sequence as number
      sequence = current
      const fields = ['v', 'sequence', 'sessionId', 'type']
      if (message.type !== 'close') {
        if (!['get', 'cancel', 'consume', 'discard', 'settled'].includes(message.type as string)
          || !Number.isSafeInteger(message.blockRequestId) || (message.blockRequestId as number) <= 0) throw domain('INVALID_INPUT')
        fields.push('blockRequestId')
      }
      if (message.type === 'get') {
        fields.push('cid')
        canonicalCid(message.cid, config.limits.maxBlockBytes)
      }
      exact(message, fields)
      armIdle()
      if (controls >= BOUNDS.controls) throw domain('LIMIT')
      controls++
      void command(message).then(result => {
        reply(port, current, result.value, result.transfer)
        if (message.type === 'close') dispose()
      }, error => reject(port, current, error)).finally(() => { controls-- }).catch(() => {})
    } catch (error) { reject(port, current, error); dispose() }
  }
  port.onmessageerror = () => { ownership.retire(); dispose() }
  port.start(); armIdle()
  reply(port, 0, { sessionId, policy: BUILD_POLICY })
  return dispose
}
