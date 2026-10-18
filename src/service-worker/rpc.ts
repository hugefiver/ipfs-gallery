import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { record } from '../worker/protocol'
import { BOUNDS, domain, exact, galleryError, noPorts, VERSION } from './protocol'

interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
/** Private ports use independent, bounded request tables, never Gallery Worker business messages. */
export class PortRpc {
  private sequence = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false
  constructor(readonly port: MessagePort, private readonly failed: () => void = () => {},
    private readonly idle?: (value: Record<string, unknown>) => void) {
    port.onmessage = event => {
      const value: unknown = event.data
      try {
        noPorts(event)
        if (record(value) && value.type === 'idle') {
          if (!this.idle) throw domain('INVALID_INPUT')
          exact(value, ['v', 'type', 'sessionId', 'bindingId', 'epoch'])
          if (value.v !== VERSION) throw domain('INVALID_INPUT')
          this.idle(value)
          return
        }
        if (!record(value) || value.v !== VERSION || !Number.isSafeInteger(value.sequence)) throw domain('INVALID_INPUT')
        exact(value, value.ok === true ? ['v', 'sequence', 'ok', 'value'] : ['v', 'sequence', 'ok', 'error'])
        if (typeof value.ok !== 'boolean') throw domain('INVALID_INPUT')
        const pending = this.pending.get(value.sequence as number)
        if (!pending) return
        const error = value.ok ? undefined : new GalleryDomainError(galleryError(value.error))
        this.pending.delete(value.sequence as number)
        clearTimeout(pending.timer)
        if (value.ok) pending.resolve(value.value)
        else pending.reject(error)
      } catch { this.close(domain('INVALID_INPUT')) }
    }
    port.onmessageerror = () => this.close(domain('NETWORK'))
    port.start()
  }
  request(message: Record<string, unknown>, timeout: number = BOUNDS.handshakeMs): Promise<unknown> {
    if (this.closed) return Promise.reject(domain('NETWORK'))
    if (this.pending.size >= BOUNDS.controls || this.sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(domain('LIMIT'))
    const sequence = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(domain('TIMEOUT')), timeout)
      this.pending.set(sequence, { resolve, reject, timer })
      try { this.port.postMessage({ ...message, v: VERSION, sequence }) }
      catch { this.close(domain('NETWORK')) }
    })
  }
  close(error: unknown = domain('NETWORK')): void {
    if (this.closed) return
    this.closed = true
    this.port.close()
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error) }
    this.pending.clear()
    this.failed()
  }
}
export function reply(port: MessagePort, sequence: number, value: unknown, transfer: Transferable[] = []): void {
  port.postMessage({ v: VERSION, sequence, ok: true, value }, transfer)
}
export function reject(port: MessagePort, sequence: number, error: unknown): void {
  const { code, message, retryable } = toGalleryError(error)
  port.postMessage({ v: VERSION, sequence, ok: false, error: { code, message: message.slice(0, 1024), retryable } })
}
