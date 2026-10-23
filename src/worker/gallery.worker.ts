import { normalizeContentRef } from '../core/query'
import { discoverGallery } from '../core/gallery'
import { readVerifiedAsset } from '../core/media'
import { normalizeGateway } from '../network/gateways'
import { createContentReader } from '../network/reader'
import { GalleryWorkerRuntime } from './runtime'
import { createBridgedBlockSource } from './block-bridge'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope
const runtime = new GalleryWorkerRuntime({
  postMessage: (message, transfer) => scope.postMessage(message, transfer ?? []),
  normalizeContentRef,
  normalizeGateway,
  createBroker: (config, sessionId, roots) => createBridgedBlockSource(config, sessionId,
    (message, transfer) => scope.postMessage(message, transfer), roots),
  createReader: createContentReader,
  discover: discoverGallery,
  readAsset: readVerifiedAsset,
})

scope.addEventListener('message', (event: MessageEvent<unknown>) => runtime.handleMessage(event.data))
