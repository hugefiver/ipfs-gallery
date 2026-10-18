import { connect, createServer } from 'node:net'
import type { FixtureBlock } from '../fixtures/unixfs'
import { startIpfsProvider } from './ipfs-provider'
import { listenOnLoopback, mapSwFixtureEndpoint, SwOwnedResources } from './sw-owned'
import { SW_TEST_TLS } from './sw-test-tls'

export const SW_GALLERY_WSS_HOST = 'provider.gallery-fixture.net'

/** The upstream is acquired here, never supplied as an arbitrary host/port. */
export async function startSwGalleryBitswapProvider(blocks: ReadonlyMap<string, FixtureBlock>) {
  const provider = await startIpfsProvider(blocks, {
    tls: SW_TEST_TLS.serverOptions, publicHost: SW_GALLERY_WSS_HOST, publicPort: 443,
  })
  const ownership = new SwOwnedResources()
  const errors: unknown[] = []
  const port = provider.localTarget.port
  let closing = false
  let closeWork: Promise<void> | undefined
  const close = () => closeWork ??= (async () => {
    closing = true
    // Provider TLS/WSS stays live until both sides of every relay socket exit.
    const failures: unknown[] = []
    try { await ownership.close() } catch (error) { failures.push(error) }
    try { await provider.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Gallery provider relay cleanup failed')
  })()
  const relay = createServer(client => {
    if (closing) { client.destroy(); return }
    ownership.ownSocket(client, 'gallery-provider-relay', 'connection')
    const upstream = connect({ host: '127.0.0.1', port })
    ownership.ownSocket(upstream, 'gallery-provider-relay', 'upstream')
    client.once('error', () => upstream.destroy())
    upstream.once('error', error => {
      if (!closing && !client.destroyed) errors.push(error)
      client.destroy()
    })
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
    client.pipe(upstream).pipe(client)
  })
  try {
    const target = await listenOnLoopback(relay, ownership, 'gallery-provider-relay')
    return {
      provider,
      endpoint: mapSwFixtureEndpoint(`wss://${SW_GALLERY_WSS_HOST}`, target),
      owned: ownership.records,
      errors,
      get activeCount() { return ownership.activeCount },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
