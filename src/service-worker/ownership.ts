import { GalleryDomainError } from '../shared/errors'
import { BOUNDS, domain, exact, galleryError, noPorts, openAdmission, VERSION, type OwnerIdentity } from './protocol'

export function latch() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** One bounded exchange on a new port; a timeout is never settlement evidence. */
export function serviceMessage(controller: ServiceWorker, value: Record<string, unknown>,
  channel: () => MessageChannel, timeout: number = BOUNDS.handshakeMs): Promise<unknown> {
  const { port1, port2 } = channel()
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); port1.close() }
    const timer = setTimeout(() => { finish(); reject(domain('TIMEOUT')) }, timeout)
    port1.onmessageerror = () => { finish(); reject(domain('NETWORK')) }
    port1.onmessage = event => {
      try {
        noPorts(event)
        const result: unknown = event.data
        const admission = value.type === 'open' && result && typeof result === 'object' && Object.hasOwn(result, 'admission')
        exact(result, result && (result as { ok?: unknown }).ok === true
          ? ['v', 'sequence', 'ok', 'value'] : ['v', 'sequence', 'ok', 'error', ...(admission ? ['admission'] : [])])
        if (result.v !== VERSION || result.sequence !== 0 || typeof result.ok !== 'boolean') throw domain('INVALID_INPUT')
        if (!result.ok) {
          if (admission) openAdmission(result.admission, { boot: value.boot, ownerId: value.ownerId, attempt: value.attempt })
          throw new GalleryDomainError(galleryError(result.error))
        }
        finish(); resolve(result.value)
      } catch (error) { finish(); reject(error) }
    }
    port1.start()
    try { controller.postMessage({ ...value, v: VERSION }, [port2]) }
    catch (error) { finish(); port2.close(); reject(error) }
  })
}

export interface OwnerDebt extends OwnerIdentity {
  controller: ServiceWorker
  boot: string
  channel(): MessageChannel
  done: ReturnType<typeof latch>
  listeners: Set<() => void>
  uncertain: boolean
}

/** Window-owned and never replaced with a Dedicated Worker generation. Fences are not TTLs. */
export class WindowOwnership {
  private readonly ownerId = crypto.randomUUID()
  private readonly secret = crypto.randomUUID()
  private attempt = 0
  private readonly debts = new Set<OwnerDebt>()
  private recovery?: Promise<void>
  constructor(private readonly changed: () => void = () => {}) {}
  get quarantined(): boolean { return [...this.debts].some(debt => debt.uncertain) }
  isSettled(debt: OwnerDebt): boolean { return !this.debts.has(debt) }
  begin(controller: ServiceWorker, boot: string, channel: () => MessageChannel): OwnerDebt {
    if (this.quarantined) throw domain('NETWORK')
    const replaced = [...this.debts].filter(debt => debt.controller !== controller || debt.boot !== boot)
    if (replaced.length) {
      for (const debt of replaced) this.uncertain(debt)
      throw domain('NETWORK')
    }
    if (this.debts.size >= BOUNDS.bindings || this.attempt >= Number.MAX_SAFE_INTEGER) throw domain('LIMIT')
    const debt: OwnerDebt = { ownerId: this.ownerId, secret: this.secret, attempt: ++this.attempt,
      controller, boot, channel, done: latch(), listeners: new Set(), uncertain: false }
    this.debts.add(debt)
    return debt
  }
  complete(debt: OwnerDebt): void {
    if (!this.debts.delete(debt)) return
    for (const listener of [...debt.listeners]) listener()
    debt.listeners.clear()
    debt.done.resolve()
  }
  watch(debt: OwnerDebt, listener: () => void): () => void {
    if (!this.debts.has(debt)) { listener(); return () => {} }
    debt.listeners.add(listener)
    return () => { debt.listeners.delete(listener) }
  }
  uncertain(debt: OwnerDebt): void {
    if (!this.debts.has(debt)) return
    const notify = !this.quarantined
    debt.uncertain = true
    if (notify) this.changed()
  }
  retire(): void {
    for (const debt of this.debts) this.uncertain(debt)
  }
  recover(): Promise<void> {
    if (this.recovery) return this.recovery
    if (!this.quarantined) return Promise.resolve()
    // One coalesced attempt per explicit read, targeting saved objects, never the new controller.
    const groups = new Map<ServiceWorker, Map<string, OwnerDebt>>()
    for (const debt of this.debts) {
      let boots = groups.get(debt.controller)
      if (!boots) { boots = new Map(); groups.set(debt.controller, boots) }
      const existing = boots.get(debt.boot)
      if (!existing || existing.attempt < debt.attempt) boots.set(debt.boot, debt)
    }
    const recovery = Promise.all([...groups.values()].flatMap(boots => [...boots.values()]).map(async debt => {
      const value = await serviceMessage(debt.controller, { type: 'reconcile', ownerId: debt.ownerId,
        secret: debt.secret, attempt: debt.attempt, boot: debt.boot }, debt.channel)
      exact(value, ['boot', 'ownerId', 'attempt', 'state'])
      // A new boot cannot certify old work; require the saved global's drain proof.
      if (value.boot !== debt.boot || value.ownerId !== debt.ownerId || value.attempt !== debt.attempt
        || value.state !== 'settled') throw domain('NETWORK')
      for (const old of [...this.debts]) {
        if (old.controller === debt.controller && old.boot === debt.boot && old.attempt <= debt.attempt) this.complete(old)
      }
    })).then(() => { if (this.quarantined) throw domain('NETWORK') })
    this.recovery = recovery
    void recovery.finally(() => { if (this.recovery === recovery) this.recovery = undefined }).catch(() => {})
    return recovery
  }
  usage() { return { debts: this.debts.size, quarantined: this.quarantined } }
}
