import type { SessionConfig } from '../shared/contracts'
import type { VerifiedBlockSource } from '../network/types'
import { createServiceWorkerRuntime, type WindowIdentity } from './runtime'

const GLOBAL_BOOT = crypto.randomUUID()

/** Production and explicitly isolated fixture bundles install the same fetch/control runtime. */
export function installServiceWorker(createSource: (config: SessionConfig) => VerifiedBlockSource,
  scope: ServiceWorkerGlobalScope = globalThis as unknown as ServiceWorkerGlobalScope): void {
  const runtime = createServiceWorkerRuntime({ scope: scope.registration.scope, boot: GLOBAL_BOOT,
    clients: { get: id => scope.clients.get(id) as Promise<WindowIdentity | undefined> }, createSource })
  scope.addEventListener('activate', event => event.waitUntil(scope.clients.claim()))
  scope.addEventListener('message', event => {
    if (!runtime.acceptsOpen(event.data)) return
    const port = event.ports[0]
    if (event.ports.length !== 1 || !port) return
    const source = event.source
    const client = source && 'id' in source && 'url' in source && 'type' in source
      ? { id: source.id, url: source.url, type: source.type } : null
    const type = (event.data as { type: unknown }).type
    event.waitUntil(type === 'open' ? runtime.open(event.data, client, port) : runtime.manage(event.data, client, port))
  })
  scope.addEventListener('fetch', event => {
    const response = runtime.handleFetch(event.request, event.clientId)
    if (response) event.respondWith(response)
  })
}
