import { webSockets, type WebSocketMultiaddrConnection } from '@libp2p/websockets'
import type { Multiaddr } from '@multiformats/multiaddr'
import { GalleryDomainError } from '../shared/errors'
import { directBudget } from './direct-budget'
import { DirectCleanupError } from './direct-errors'
import { checkSignal, networkError } from './errors'

/** Each dial reservation follows the patched raw connection's native exit. */
export function createBudgetedWebSockets(
  allow: (address: Multiaddr) => boolean | Promise<boolean>,
  onLimit: (address: Multiaddr, error: GalleryDomainError) => void,
  socketClosures: Set<Promise<void>>,
  dialWork: Map<string, Set<Promise<void>>> = new Map(),
): ReturnType<typeof webSockets> {
  return components => {
    const base = webSockets({ maxBufferedAmount: 4 * 1024 * 1024 })(components)
    const performDial: typeof base.dial = async (address, options) => {
        checkSignal(options.signal)
        if (!await allow(address)) throw networkError('NETWORK', '拨号地址未获准。')
        let releaseDial: (() => void) | undefined
        let releaseConnection: (() => void) | undefined
        let raw: WebSocketMultiaddrConnection | undefined
        let closed: Promise<void> | undefined
        try {
          releaseDial = directBudget.acquire('dial')
          releaseConnection = directBudget.acquire('connection')
          const outbound = webSockets({
            maxBufferedAmount: 4 * 1024 * 1024,
            onConnection(connection) {
              raw = connection
              closed = connection.closed.then(() => {
                releaseConnection!()
                socketClosures.delete(closed!)
              }, () => { throw new DirectCleanupError() })
              socketClosures.add(closed)
              void closed.catch(() => {})
            },
          })(components)
          return await outbound.dial(address, options)
        } catch (error) {
          if (error instanceof GalleryDomainError && error.error.code === 'LIMIT') onLimit(address, error)
          if (raw) {
            let cleanupFailed = false
            try { raw.abort(error instanceof Error ? error : networkError('NETWORK', '连接升级失败。')) } catch { cleanupFailed = true }
            try { await closed } catch { cleanupFailed = true }
            if (cleanupFailed) throw new DirectCleanupError()
          } else {
            // Before onConnection, the patched handshake rejects only after
            // closing its socket; a pre-admission rejection creates no socket.
            releaseConnection?.()
          }
          throw error
        } finally { releaseDial?.() }
    }
    return {
      ...base,
      dial(address, options) {
        // Register before the underlying transport starts, including the period
        // before onConnection can expose a raw socket to its lifecycle owner.
        const result = Promise.resolve().then(() => performDial(address, options))
        const cleanup = result.then(() => {}, error => { if (error instanceof DirectCleanupError) throw error })
        const key = address.toString()
        const work = dialWork.get(key) ?? new Set<Promise<void>>()
        work.add(cleanup)
        dialWork.set(key, work)
        const remove = () => {
          work.delete(cleanup)
          if (!work.size && dialWork.get(key) === work) dialWork.delete(key)
        }
        void cleanup.then(remove, () => {})
        return result
      },
      createListener() { throw networkError('UNSUPPORTED', '不允许监听。') },
      listenFilter: () => [],
      dialFilter: addresses => base.dialFilter(addresses),
    }
  }
}
