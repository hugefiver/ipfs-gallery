import type { GatewayStat, SessionConfig } from '../shared/contracts'
import { BUILD_POLICY } from '../shared/build-policy'
import { GalleryDomainError } from '../shared/errors'
import { parseBlockCid, verifyBlock } from '../network/verify'
import { validIdentity } from '../worker/protocol'
import { BLOCK_PATH, BOUNDS, domain, exact, galleryError, HEADERS, matchingBuildPolicy, noPorts, openAdmission, SCRIPT, stats,
  VERSION, type BindingIdentity } from './protocol'
import { PortRpc } from './rpc'
import { latch, serviceMessage, WindowOwnership, type OwnerDebt } from './ownership'

interface Connection extends BindingIdentity { capability: string; rpc: PortRpc; debt: OwnerDebt; closing?: Promise<void> }
interface Work {
  id: number; swId: number; controller: AbortController; done: ReturnType<typeof latch>
  admission: ReturnType<typeof latch>; prepareSent: boolean; known: boolean
  connection?: Connection; debt?: OwnerDebt; cleanup?: Promise<void>
  unsubscribe?: () => void
}
export interface WindowSourceEnvironment {
  base: URL; serviceWorker: ServiceWorkerContainer; fetch: typeof fetch; channel(): MessageChannel
}
export function applicationBase(): URL { return new URL(import.meta.env.BASE_URL, document.baseURI) }

export class WindowBlockSource {
  private connection?: Connection
  private opening?: Promise<Connection>
  private openingDebt?: OwnerDebt
  private disposed = false
  private nextId = 0
  private maintainSequence = 0
  private maintenance?: Promise<void>
  private contentSeen = false
  private readonly work = new Map<number, Work>()
  private gateways: GatewayStat[] = []
  private readonly changed = () => {
    if (!this.openingDebt && !this.connection) return
    if (this.openingDebt) this.ownership.uncertain(this.openingDebt)
    this.dispose()
  }
  constructor(private readonly sessionId: string, private readonly config: SessionConfig,
    private readonly env: WindowSourceEnvironment, readonly ownership = new WindowOwnership(), private readonly roots: string[] = []) {
    env.serviceWorker.addEventListener('controllerchange', this.changed)
  }
  private async controller(): Promise<ServiceWorker> {
    const { serviceWorker, base } = this.env
    const script = new URL(SCRIPT, base).href
    const deadline = performance.now() + BOUNDS.handshakeMs
    if (serviceWorker.controller && serviceWorker.controller.scriptURL !== script) throw domain('UNSUPPORTED')
    let registrationTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([serviceWorker.register(script, { scope: base.pathname, type: 'module', updateViaCache: 'none' }),
        new Promise<never>((_, reject) => { registrationTimer = setTimeout(() => reject(domain('TIMEOUT')), BOUNDS.handshakeMs) })])
    } finally { clearTimeout(registrationTimer) }
    if (serviceWorker.controller?.scriptURL === script) return serviceWorker.controller
    return new Promise((resolve, reject) => {
      const done = () => {
        const controller = serviceWorker.controller
        if (!controller) return
        cleanup()
        if (controller.scriptURL === script) resolve(controller)
        else reject(domain('UNSUPPORTED'))
      }
      const timer = setTimeout(() => { cleanup(); reject(domain('TIMEOUT')) }, Math.max(1, deadline - performance.now()))
      const cleanup = () => { clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', done) }
      serviceWorker.addEventListener('controllerchange', done)
      done()
    })
  }
  private connect(): Promise<Connection> {
    if (this.disposed || this.ownership.quarantined) return Promise.reject(domain('NETWORK'))
    if (this.connection) return Promise.resolve(this.connection)
    if (this.opening) return this.opening
    const opening = (async () => {
      const controller = await this.controller()
      if (this.disposed) throw domain('CANCELLED')
      const identity = await serviceMessage(controller, { type: 'identify' }, this.env.channel)
      exact(identity, ['boot', 'policy'])
      if (!validIdentity(identity.boot)) throw domain('INVALID_INPUT')
      matchingBuildPolicy(identity.policy)
      if (this.disposed || this.ownership.quarantined) throw domain('CANCELLED')
      // This owner/attempt/secret exists before postMessage, independently of its ACK.
      const debt = this.ownership.begin(controller, identity.boot, this.env.channel)
      this.openingDebt = debt
      const { port1, port2 } = this.env.channel()
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(domain('TIMEOUT')), BOUNDS.handshakeMs)
          port1.onmessage = event => {
            clearTimeout(timer)
            try { noPorts(event); resolve(event.data) } catch (error) { reject(error) }
          }
          port1.onmessageerror = () => { clearTimeout(timer); reject(domain('NETWORK')) }
          port1.start()
          try { controller.postMessage({ v: VERSION, type: 'open', sessionId: this.sessionId, config: this.config, roots: this.roots,
             ownerId: debt.ownerId, attempt: debt.attempt, secret: debt.secret, boot: debt.boot, policy: BUILD_POLICY }, [port2]) }
          catch (error) { clearTimeout(timer); port2.close(); reject(error) }
        })
        const admission = value && typeof value === 'object' && Object.hasOwn(value, 'admission')
        exact(value, value && (value as { ok?: unknown }).ok === true
          ? ['v', 'sequence', 'ok', 'value'] : ['v', 'sequence', 'ok', 'error', ...(admission ? ['admission'] : [])])
        if (value.v !== VERSION || value.sequence !== 0 || typeof value.ok !== 'boolean') throw domain('INVALID_INPUT')
        if (!value.ok) {
          const error = galleryError(value.error)
          if (admission) {
            openAdmission(value.admission, { boot: debt.boot, ownerId: debt.ownerId, attempt: debt.attempt })
            this.ownership.complete(debt)
          }
          throw new GalleryDomainError(error)
        }
        exact(value.value, ['v', 'sessionId', 'bindingId', 'epoch', 'capability', 'maxBlockBytes', 'policy'])
        const result = value.value
        matchingBuildPolicy(result.policy)
        if (result.v !== VERSION || result.sessionId !== this.sessionId || result.epoch !== debt.boot
          || !validIdentity(result.bindingId) || !validIdentity(result.capability)
          || result.maxBlockBytes !== this.config.limits.maxBlockBytes) throw domain('INVALID_INPUT')
        const rpc = new PortRpc(port1, () => this.ownership.uncertain(debt), value => {
          if (value.sessionId !== this.sessionId || value.bindingId !== result.bindingId || value.epoch !== debt.boot) throw domain('INVALID_INPUT')
          this.ownership.complete(debt)
          if (this.connection?.rpc === rpc) this.connection = undefined
          if (this.openingDebt === debt) this.openingDebt = undefined
          rpc.close()
        })
        const connection = { sessionId: this.sessionId, bindingId: result.bindingId,
          epoch: debt.boot, capability: result.capability, rpc, debt }
        this.connection = connection
        if (this.disposed || this.env.serviceWorker.controller !== controller) {
          void this.closeConnection(connection).catch(() => {})
          throw domain('NETWORK')
        }
        return connection
      } catch (error) { port1.close(); this.ownership.uncertain(debt); throw error }
    })()
    this.opening = opening
    void opening.finally(() => { if (this.opening === opening) this.opening = undefined }).catch(() => {})
    return opening
  }
  private control(connection: Connection, type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    return connection.rpc.request({ type, sessionId: connection.sessionId, bindingId: connection.bindingId,
      epoch: connection.epoch, ...fields })
  }
  private finish(work: Work): void {
    if (this.work.get(work.id) !== work) return
    this.work.delete(work.id)
    work.unsubscribe?.()
    work.done.resolve()
  }
  private cleanup(work: Work, type: string): Promise<void> {
    if (work.cleanup) return work.cleanup
    const cleanup = (async () => {
      if (work.prepareSent) await work.admission.promise
      if (work.prepareSent && !work.known) throw domain('NETWORK')
      if (work.prepareSent && work.connection) {
        try { await this.control(work.connection, type, { blockRequestId: work.swId }) }
        catch (error) { if (!this.ownership.isSettled(work.connection.debt)) throw error }
      }
      this.finish(work)
    })()
    work.cleanup = cleanup
    void cleanup.catch(() => { if (work.debt) this.ownership.uncertain(work.debt) })
    return cleanup
  }
  async get(id: number, cidText: string, signal: AbortSignal): Promise<ArrayBuffer> {
    if (this.work.has(id) || this.work.size >= BOUNDS.perBinding) throw domain('LIMIT')
    if (this.disposed || this.ownership.quarantined) throw domain('NETWORK')
    const work: Work = { id, swId: ++this.nextId, controller: new AbortController(), done: latch(),
      admission: latch(), prepareSent: false, known: false }
    this.work.set(id, work)
    const abort = () => work.controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timer = setTimeout(() => work.controller.abort(domain('TIMEOUT')), this.config.limits.blockTimeoutMs + BOUNDS.handshakeMs * 3)
    let connecting = false
    try {
      work.controller.signal.throwIfAborted()
      const cid = parseBlockCid(cidText, this.config.limits.maxBlockBytes)
      if (cid.multihash.code === 0) throw domain('INVALID_INPUT')
      connecting = true
      const connection = await this.connect()
      work.connection = connection; work.debt = connection.debt
      work.unsubscribe = this.ownership.watch(connection.debt, () => this.finish(work))
      work.controller.signal.throwIfAborted()
      // Admission ownership precedes sending prepare, including the lost-ACK case.
      work.prepareSent = true
      const prepared = await this.control(connection, 'prepare-block', { blockRequestId: work.swId, cid: cid.toV1().toString() })
      exact(prepared, ['ticket'])
      if (!validIdentity(prepared.ticket)) throw domain('INVALID_INPUT')
      this.contentSeen = true
      work.known = true; work.admission.resolve()
      work.controller.signal.throwIfAborted()
      const headers = new Headers({ [HEADERS.version]: String(VERSION), [HEADERS.bindingId]: connection.bindingId,
        [HEADERS.epoch]: connection.epoch, [HEADERS.capability]: connection.capability,
        [HEADERS.blockRequestId]: String(work.swId), [HEADERS.ticket]: prepared.ticket })
      const response = await this.env.fetch(new URL(`${BLOCK_PATH}${cid.toV1()}`, this.env.base), {
        method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        cache: 'no-store', headers, signal: work.controller.signal,
      })
      if (response.redirected || response.headers.get(HEADERS.version) !== String(VERSION)
        || response.headers.get(HEADERS.epoch) !== connection.epoch
        || response.headers.get(HEADERS.bindingId) !== connection.bindingId
        || response.headers.get(HEADERS.blockRequestId) !== String(work.swId)) throw domain('INTEGRITY')
      if (!response.ok) {
        if (response.headers.get('content-type') !== 'application/json') throw domain('INTEGRITY')
        const bytes = await readBounded(response, 4096, work.controller.signal)
        throw new GalleryDomainError(galleryError(JSON.parse(new TextDecoder().decode(bytes))))
      }
      // HTTP is only WindowClient admission; it can never supply content bytes or provenance.
      if (response.status !== 204) { await response.body?.cancel(); throw domain('INTEGRITY') }
      if (response.body !== null) await readBounded(response, 0, work.controller.signal)
      work.controller.signal.throwIfAborted()
      const delivery = await this.control(connection, 'read-block', { blockRequestId: work.swId })
      exact(delivery, ['sessionId', 'bindingId', 'epoch', 'blockRequestId', 'cid', 'byteLength', 'bytes', 'policy'])
      matchingBuildPolicy(delivery.policy)
      if (delivery.sessionId !== this.sessionId || delivery.bindingId !== connection.bindingId
        || delivery.epoch !== connection.epoch || delivery.blockRequestId !== work.swId || delivery.cid !== cid.toV1().toString()
        || !(delivery.bytes instanceof ArrayBuffer) || delivery.bytes.byteLength > this.config.limits.maxBlockBytes
        || delivery.byteLength !== delivery.bytes.byteLength) throw domain('INTEGRITY')
      const bytes = new Uint8Array(delivery.bytes)
      if (BUILD_POLICY.trustless) await verifyBlock(cid, bytes, this.config.limits.maxBlockBytes)
      work.controller.signal.throwIfAborted()
      if (this.connection !== connection || this.disposed) throw domain('NETWORK')
      void this.control(connection, 'snapshot').then(value => { this.gateways = stats(value, this.config) }).catch(() => {})
      return delivery.bytes
    } catch (error) {
      work.admission.resolve()
      if (connecting && !work.debt && this.openingDebt) {
        work.debt = this.openingDebt
        work.unsubscribe = this.ownership.watch(work.debt, () => this.finish(work))
      }
      if (work.debt && !work.connection) this.ownership.uncertain(work.debt)
      else void this.cleanup(work, 'discard').catch(() => {})
      throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }
  async acknowledge(id: number, discard = false): Promise<void> {
    const work = this.work.get(id)
    if (work) await this.cleanup(work, discard ? 'discard' : 'consume')
  }
  async cancel(id: number): Promise<void> {
    const work = this.work.get(id)
    if (!work) return
    work.controller.abort(domain('CANCELLED'))
    if (work.connection) await this.cleanup(work, 'cancel-block')
  }
  settled(): Promise<void> { return Promise.all([...this.work.values()].map(work => work.done.promise)).then(() => {}) }
  hasContentAdmission(): boolean { return this.contentSeen }
  maintain(): Promise<void> {
    if (this.disposed || (!this.roots.length && !this.contentSeen)) return Promise.resolve()
    if (this.maintenance) return this.maintenance
    const task = (async () => {
      const connection = await this.connect()
      if (this.disposed) throw domain('CANCELLED')
      const sequence = ++this.maintainSequence
      const value = await serviceMessage(connection.debt.controller, { type: 'maintain',
        sessionId: connection.sessionId, bindingId: connection.bindingId, epoch: connection.epoch,
        capability: connection.capability, sequence }, this.env.channel, BOUNDS.maintainMs + BOUNDS.handshakeMs)
      exact(value, ['sessionId', 'bindingId', 'epoch', 'sequence'])
      if (value.sessionId !== connection.sessionId || value.bindingId !== connection.bindingId ||
        value.epoch !== connection.epoch || value.sequence !== sequence) throw domain('INVALID_INPUT')
    })()
    this.maintenance = task
    void task.finally(() => { if (this.maintenance === task) this.maintenance = undefined }).catch(() => {})
    return task
  }
  async drained(): Promise<void> {
    await this.opening?.catch(() => {})
    await this.maintenance?.catch(() => {})
    if (this.connection) await this.closeConnection(this.connection)
    if (this.openingDebt && !this.ownership.isSettled(this.openingDebt)) {
      this.ownership.uncertain(this.openingDebt)
      await this.ownership.recover()
      if (!this.ownership.isSettled(this.openingDebt)) throw domain('NETWORK')
    }
    await this.settled()
  }
  recover(): Promise<void> { return this.ownership.recover() }
  snapshot(): GatewayStat[] { return this.gateways.map(item => ({ ...item })) }
  private closeConnection(connection: Connection): Promise<void> {
    if (!connection.closing) {
      connection.closing = this.control(connection, 'close').then(() => this.ownership.complete(connection.debt), error => {
        if (this.ownership.isSettled(connection.debt)) return
        this.ownership.uncertain(connection.debt)
        throw error
      }).finally(() => connection.rpc.close())
      void connection.closing.catch(() => {})
    }
    return connection.closing
  }
  async retireIdle(): Promise<void> {
    if (this.work.size || this.ownership.quarantined) throw domain('NETWORK')
    const connection = this.connection
    this.dispose()
    if (connection) await this.closeConnection(connection)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.env.serviceWorker.removeEventListener('controllerchange', this.changed)
    for (const work of this.work.values()) work.controller.abort(domain('CANCELLED'))
    if (this.connection) void this.closeConnection(this.connection).catch(() => {})
    else if (this.openingDebt) this.ownership.uncertain(this.openingDebt)
  }
}

export async function readBounded(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    await response.body?.cancel(); throw domain('LIMIT')
  }
  if (!response.body) throw domain('INTEGRITY')
  const reader = response.body.getReader()
  const buffer = new Uint8Array(declared === null ? max : Number(declared))
  let size = 0
  let complete = false
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) { complete = true; break }
      if (size + value.length > buffer.length) throw domain('LIMIT')
      buffer.set(value, size); size += value.length
    }
    if (declared !== null && size !== Number(declared)) throw domain('INTEGRITY')
    return size === buffer.length ? buffer : buffer.slice(0, size)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
