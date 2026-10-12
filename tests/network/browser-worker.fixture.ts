import { createGatewayBroker } from '../../src/network/broker'
import { createContentReader } from '../../src/network/reader'
import type { ContentEntry } from '../../src/core/types'
import type { ContentRef, SessionConfig } from '../../src/shared/contracts'
import { toGalleryError } from '../../src/shared/errors'

interface FixtureRequest {
  config: SessionConfig
  directory: ContentRef
  file: ContentRef
}

const worker = self as unknown as DedicatedWorkerGlobalScope
worker.onmessage = (event: MessageEvent<FixtureRequest>) => {
  const source = createGatewayBroker(event.data.config, { fetch: globalThis.fetch, now: () => Date.now(), random: () => 0 })
  const reader = createContentReader(source, { maxInputBytes: event.data.config.limits.maxDiscoveryInputBytes })
  const signal = new AbortController().signal
  async function run() {
    const stat = await reader.stat(event.data.directory, signal)
    const entries: ContentEntry[] = []
    for await (const entry of reader.ls(event.data.directory, signal)) entries.push(entry)
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of reader.read(event.data.file, { signal, maxBytes: event.data.config.limits.maxAssetBytes })) {
      length += chunk.byteLength
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    worker.postMessage({ stat, entries, bytes: bytes.buffer, gateways: source.snapshot() }, [bytes.buffer])
  }
  void run().catch((error: unknown) => worker.postMessage({ error: toGalleryError(error) })).finally(() => source.dispose())
}
