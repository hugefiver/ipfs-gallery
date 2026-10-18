import { vi } from 'vitest'
import type { VerifiedBlockSource } from '../../src/network/types'
import { createServiceWorkerRuntime } from '../../src/service-worker/runtime'
import type { WindowSourceEnvironment } from '../../src/service-worker/window-source'
import { SCRIPT } from '../../src/service-worker/protocol'
import { client, scope, source } from './helpers'

export function environment(cleanups: Array<() => void | Promise<void>>, get: VerifiedBlockSource['get'],
  initiallyControlled = true, settled?: () => Promise<void>,
  createSource: () => VerifiedBlockSource = () => ({ ...source(get), settled })) {
  let runtime = createServiceWorkerRuntime({ scope, boot: 'test-boot', clients: { get: async () => client }, createSource })
  cleanups.push(() => runtime.dispose())
  const container = new EventTarget() as EventTarget & { controller: ServiceWorker | null; register: ReturnType<typeof vi.fn> }
  const controller = { scriptURL: new URL(SCRIPT, scope).href,
    postMessage: (value: unknown, ports: MessagePort[]) => {
      if ((value as { type: string }).type === 'open') void runtime.open(value, client, ports[0]!)
      else void runtime.manage(value, client, ports[0]!)
    } } as unknown as ServiceWorker
  container.controller = initiallyControlled ? controller : null
  container.register = vi.fn(async () => {
    if (!container.controller) { container.controller = controller; container.dispatchEvent(new Event('controllerchange')) }
    return {}
  })
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init)
    const response = runtime.handleFetch(request, client.id)
    if (!response) throw new Error('Request escaped the same-origin block handler')
    // Browser fetch rejects on abort before the SW's underlying work necessarily settles.
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      void response.then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort))
    })
  })
  const env: WindowSourceEnvironment = { base: new URL(scope), serviceWorker: container as unknown as ServiceWorkerContainer,
    fetch, channel: () => new MessageChannel() }
  return { env, container, fetch, controller, runtime: () => runtime,
    async restart() {
      await runtime.dispose()
      runtime = createServiceWorkerRuntime({ scope, boot: 'new-test-boot', clients: { get: async () => client }, createSource })
    } }
}
