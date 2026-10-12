import { normalizeContentRef } from '../core/query'
import { discoverGallery } from '../core/gallery'
import { readVerifiedAsset } from '../core/media'
import { createGatewayBroker, normalizeGateway } from '../network/broker'
import { createContentReader } from '../network/reader'
import { GalleryWorkerRuntime } from './runtime'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
const runtime = new GalleryWorkerRuntime({
  postMessage: (message, transfer) => scope.postMessage(message, transfer ?? []),
  normalizeContentRef,
  normalizeGateway,
  createBroker: (config) => createGatewayBroker(config, {
    fetch: globalThis.fetch.bind(globalThis), now: () => Date.now(), random: Math.random,
  }),
  createReader: createContentReader,
  discover: discoverGallery,
  readAsset: readVerifiedAsset,
})

scope.addEventListener('message', (event: MessageEvent<unknown>) => runtime.handleMessage(event.data))
