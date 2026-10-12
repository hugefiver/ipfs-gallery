import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createGalleryFixtures } from './unixfs'
import { startTrustlessGateway } from '../support/trustless-gateway'
import { FIXTURE_GATEWAYS, routeFixtureGateways } from '../e2e/gateway-route'

it('decodes real PNG/WebM fixtures and routes dedicated Worker HTTPS fetches without replacing the Worker', async () => {
  const fixtures = await createGalleryFixtures()
  const slow = await startTrustlessGateway(fixtures.blocks)
  const fast = await startTrustlessGateway(fixtures.blocks)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ channel: 'chromium' })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const unexpectedRequests: string[] = []
    await context.route(/^https?:\/\//, async (route) => {
      unexpectedRequests.push(route.request().url())
      await route.abort('blockedbyclient')
    })
    const bridge = await routeFixtureGateways(context, { slow, fast })
    try {
      const page = await context.newPage()
      await page.setContent('<!doctype html><html><body></body></html>')
      for (const [asset, width, height] of [
        [fixtures.raw, 32, 24], [fixtures.dagPb, 32, 24], [fixtures.multiblock, 96, 64],
      ] as const) {
        const dimensions = await page.evaluate(async (bytes) => {
          const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }))
          try {
            const image = new Image()
            image.src = url
            await image.decode()
            return { width: image.naturalWidth, height: image.naturalHeight }
          } finally { URL.revokeObjectURL(url) }
        }, Array.from(asset.bytes))
        expect(dimensions).toEqual({ width, height })
      }
      const video = await page.evaluate(async (bytes) => {
        const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'video/webm' }))
        const video = document.createElement('video')
        try {
          video.preload = 'auto'
          video.muted = true
          const loaded = new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve()
            video.onerror = () => reject(new Error(`Video decode failed: ${video.error?.code}`))
          })
          video.src = url
          document.body.append(video)
          await loaded
          return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, readyState: video.readyState }
        } finally { video.remove(); URL.revokeObjectURL(url) }
      }, Array.from(fixtures.video.bytes))
      expect(video.width).toBe(32)
      expect(video.height).toBe(24)
      expect(video.duration).toBeCloseTo(1, 1)
      expect(video.readyState).toBeGreaterThanOrEqual(2)

      const bytes = await page.evaluate(async (url) => {
        const source = `onmessage = async ({ data }) => {
          try {
            const response = await fetch(data, { headers: { Accept: 'application/vnd.ipld.raw' }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
            postMessage({ status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) });
          } catch (error) { postMessage({ error: String(error) }); }
        }`
        const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        const worker = new Worker(workerUrl)
        try {
          return await new Promise<{ status?: number; bytes?: number[]; error?: string }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Dedicated Worker route probe timed out')), 10_000)
            worker.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data) }
            worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)) }
            worker.postMessage(url)
          })
        } finally { worker.terminate(); URL.revokeObjectURL(workerUrl) }
      }, `${FIXTURE_GATEWAYS.slow}/ipfs/${fixtures.raw.cid}?format=raw`)
      expect(bytes.error).toBeUndefined()
      expect(bytes.status).toBe(200)
      expect(Uint8Array.from(bytes.bytes!)).toEqual(fixtures.raw.bytes)
      expect(bridge.routes).toHaveLength(1)
      expect(slow.requests).toHaveLength(1)
      expect(slow.requests[0]!.headers.accept).toBe('application/vnd.ipld.raw')
      slow.setMode({ kind: 'delay', milliseconds: 60_000 })
      const abortResult = await page.evaluate(async (url) => {
        const source = `const controller = new AbortController();
          onmessage = async ({ data }) => {
            if (data === 'abort') { controller.abort(); return; }
            try {
              await fetch(data, { headers: { Accept: 'application/vnd.ipld.raw' }, signal: controller.signal });
              postMessage('completed');
            } catch (error) { postMessage(error.name); }
          }`
        const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        const worker = new Worker(workerUrl)
        const abortTimer = setTimeout(() => worker.postMessage('abort'), 500)
        try {
          return await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Dedicated Worker abort probe timed out')), 5000)
            worker.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data) }
            worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)) }
            worker.postMessage(url)
          })
        } finally { clearTimeout(abortTimer); worker.terminate(); URL.revokeObjectURL(workerUrl) }
      }, `${FIXTURE_GATEWAYS.slow}/ipfs/${fixtures.raw.cid}?format=raw`)
      expect(abortResult).toBe('AbortError')
      expect(slow.requests).toHaveLength(2)
      await expect.poll(() => slow.requests[1]!.aborted).toBe(true)
      expect(unexpectedRequests).toEqual([])
      expect(bridge.errors).toEqual([])
    } finally {
      await bridge.close()
      await context.close()
    }
  } finally {
    await browser?.close()
    await Promise.all([slow.close(), fast.close()])
  }
}, 30_000)
