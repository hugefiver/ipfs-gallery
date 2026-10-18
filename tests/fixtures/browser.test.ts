import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createGalleryFixtures } from './unixfs'

it('decodes real PNG/WebM fixtures without network access', async () => {
  const fixtures = await createGalleryFixtures()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ channel: 'chromium' })
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const unexpectedRequests: string[] = []
    await context.route(/^https?:\/\//, async (route) => {
      unexpectedRequests.push(route.request().url())
      await route.abort('blockedbyclient')
    })
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

      expect(unexpectedRequests).toEqual([])
    } finally {
      await context.close()
    }
  } finally {
    await browser?.close()
  }
}, 30_000)
