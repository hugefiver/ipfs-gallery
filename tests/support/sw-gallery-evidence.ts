import { expect, type Page } from '@playwright/test'
import type { FixtureBlock } from '../fixtures/unixfs'
import type { BuildPolicy } from '../../src/shared/build-policy-defaults'
import { expectedSwGalleryPolicy, SW_GALLERY_BLOCK_PATH, SW_GALLERY_HEADERS } from './sw-gallery-policy'

interface Delivery {
  sessionId: string; bindingId: string; epoch: string; blockRequestId: number; cid: string
  byteLength: number; bytes: ArrayBuffer; policy: BuildPolicy
}

declare global {
  interface Window { swGalleryDeliveries: Delivery[]; swGalleryObservationErrors: string[] }
}

/** Observe the fixed application's real private RPC; never replace or synthesize a reply. */
export async function observeSwGalleryBlocks(page: Page, blocks: ReadonlyMap<string, FixtureBlock>, policy = expectedSwGalleryPolicy()) {
  await page.addInitScript(() => {
    const requests = new WeakMap<MessagePort, Map<number, { type: string }>>()
    const deliveries: Delivery[] = []
    const errors: string[] = []
    let retained = 0
    window.swGalleryDeliveries = deliveries
    window.swGalleryObservationErrors = errors
    const NativeChannel = MessageChannel
    window.MessageChannel = class extends NativeChannel {
      constructor() {
        super()
        for (const port of [this.port1, this.port2]) {
          requests.set(port, new Map())
          port.addEventListener('message', event => {
            const message = event.data
            const pending = requests.get(port)
            const request = pending?.get(message?.sequence)
            if (!request) return
            pending!.delete(message.sequence)
            if (request.type !== 'read-block' || message.ok !== true) return
            const value = message.value
            if (!(value?.bytes instanceof ArrayBuffer)) { errors.push('Actual read-block reply omitted its ArrayBuffer'); return }
            if (deliveries.length >= 128 || retained + value.bytes.byteLength > 24 * 1024 * 1024) {
              errors.push('Private-result observation exceeded its bounded retention'); return
            }
            retained += value.bytes.byteLength
            deliveries.push({ ...value, bytes: value.bytes.slice(0) })
          })
        }
      }
    }
    const post = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (message && typeof message === 'object' && 'sequence' in message && 'type' in message
        && typeof message.sequence === 'number' && typeof message.type === 'string') {
        requests.get(this)?.set(message.sequence, { type: message.type })
      }
      Reflect.apply(post, this, transfer === undefined ? [message] : [message, transfer])
    }
  })
  const admissions = new Set<string>()
  const work: Promise<void>[] = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (!url.pathname.includes(`/${SW_GALLERY_BLOCK_PATH}`) || !response.ok()) return
    work.push((async () => {
      expect(response.fromServiceWorker()).toBe(true)
      expect(response.status()).toBe(204)
      const headers = response.headers()
      expect(headers['cache-control']).toBe('no-store')
      expect(Number(headers['content-length'] ?? 0)).toBe(0)
      admissions.add(JSON.stringify([headers[SW_GALLERY_HEADERS.bindingId.toLowerCase()], headers[SW_GALLERY_HEADERS.epoch.toLowerCase()],
        Number(headers[SW_GALLERY_HEADERS.blockRequestId.toLowerCase()]), url.pathname.split('/').at(-1)]))
    })())
    void work.at(-1)!.catch(() => {})
  })
  const cids: string[] = []
  const checked = new Set<string>()
  return { cids, finish: async () => {
    await Promise.all(work)
    const observed = await page.evaluate(() => ({ errors: window.swGalleryObservationErrors,
      deliveries: window.swGalleryDeliveries.map(value => {
        const bytes = new Uint8Array(value.bytes)
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
        }
        return { ...value, bytes: btoa(binary) }
      }) }))
    expect(observed.errors).toEqual([])
    for (const value of observed.deliveries) {
      const key = JSON.stringify([value.bindingId, value.epoch, value.blockRequestId, value.cid])
      if (checked.has(key)) continue
      expect(admissions.has(key), `Private bytes need real same-client SW admission: ${value.cid}`).toBe(true)
      expect(value.policy).toEqual(policy)
      const bytes = Buffer.from(value.bytes, 'base64')
      expect(value.byteLength).toBe(bytes.byteLength)
      const expected = blocks.get(value.cid)
      expect(expected, `Private bytes must belong to the expected fixture: ${value.cid}`).toBeDefined()
      expect(bytes.equals(Buffer.from(expected!.bytes)), `Private bytes differ for ${value.cid}`).toBe(true)
      checked.add(key)
      cids.push(value.cid)
    }
  } }
}
