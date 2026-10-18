import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { ui, enterAlbum, openPanel, openReaderTools, expectDownloadBytes, observeVerifiedBlobs } from '../e2e/gallery-ui'

// Publicly pinned directory from https://docs.ipfs.tech/quickstart/retrieve/.
const directory = 'bafybeicn7i3soqdgr7dwnrwytgq4zxy7a5jpkizrvhm5mv6bgjd32wm3q4'

test('public UnixFS directory renders through CID-verified Worker retrieval', async ({ page, baseURL }, testInfo) => {
  if (!baseURL || new URL(baseURL).port === '4173') throw new Error('Public smoke requires an isolated preview')
  await observeVerifiedBlobs(page)
  const requests: { url: string; owner: 'service-worker' | 'window'; status?: number; error?: string }[] = []
  const workers: string[] = []
  let gateways: string[] | undefined
  const kind = (url: string) => url.startsWith('https://delegated-ipfs.dev/routing/v1/providers/') ? 'router' as const
    : url.includes('/__ipfs_gallery__/blocks/') ? 'block' as const
    : gateways === undefined ? 'unclassified' as const
      : gateways.some(gateway => url.startsWith(`${gateway}/ipfs/`)) ? 'gateway' as const : 'provider' as const
  page.context().on('serviceworker', worker => workers.push(worker.url()))
  page.context().on('request', (request) => {
    if (request.url().includes('format=raw') || request.url().includes('/__ipfs_gallery__/blocks/') || request.url().startsWith('https://delegated-ipfs.dev/routing/v1/providers/')) {
      requests.push({ url: request.url(), owner: request.serviceWorker() ? 'service-worker' : 'window' })
    }
  })
  page.context().on('response', (response) => {
    const request = requests.findLast((entry) => entry.url === response.url())
    if (request) request.status = response.status()
  })
  page.context().on('requestfailed', (request) => {
    const entry = requests.findLast((entry) => entry.url === request.url())
    if (entry) entry.error = request.failure()?.errorText
  })
  try {
    await page.setViewportSize({ width: 1280, height: 1200 })
    const params = new URLSearchParams({ unixfs: directory })
    await page.goto(`/?${params}`)
    await expect.poll(() => ui.reader(page).getByRole('img').evaluateAll((images) =>
      images.some((image) => image instanceof HTMLImageElement && image.naturalWidth > 0 && image.src.startsWith('blob:')),
    ), { timeout: 100_000 }).toBe(true)
    expect(requests.some((entry) => entry.status === 200)).toBe(true)
    expect(requests.some(entry => kind(entry.url) === 'block' && entry.status === 204)).toBe(true)
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(new URL('ipfs-service-worker.js', baseURL).href)
    expect(page.workers().length).toBeGreaterThan(0)
    const renderedBytes = await ui.reader(page).getByRole('img').evaluate(async (image: HTMLImageElement) => {
      const blob = window.mediaTestBlobs!.get(image.currentSrc)
      if (!blob) throw new Error('Rendered media must retain its observed verified Blob')
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    await openReaderTools(page)
    await expectDownloadBytes(page, ui.readerTools(page), Uint8Array.from(renderedBytes))
    await page.keyboard.press('Escape')
    await page.screenshot({ path: testInfo.outputPath('public-directory.png'), fullPage: true })
    await enterAlbum(page)
    await expect(ui.tiles(page).first()).toBeVisible()
    await ui.tiles(page).first().click()
    await expect(ui.reader(page)).toBeVisible()
    await openPanel(page, 'network')
    await expect(ui.gateways(ui.settingsDialog(page)).first()).toBeVisible()
    gateways = await ui.gateways(ui.settingsDialog(page)).evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))
    expect(gateways.length).toBeGreaterThan(0)
  } finally {
    const evidencePath = testInfo.outputPath('public-retrieval.json')
    await writeFile(evidencePath, JSON.stringify({
      directory, timestamp: new Date().toISOString(), gateways: gateways ?? null,
      requests: requests.map(entry => ({ ...entry, kind: kind(entry.url) })), workers,
      retrieval: requests.some(entry => kind(entry.url) === 'gateway' && entry.status === 200) ? 'fallback-observed'
        : requests.some(entry => kind(entry.url) === 'provider' && entry.status === 200) ? 'direct-http-observed' : 'direct-transport-unclassified',
      limitation: 'Public request telemetry does not decode Bitswap wire traffic; deterministic WSS acceptance is reported by the local provider suite.',
    }, null, 2))
    await testInfo.attach('public-retrieval', {
      path: evidencePath,
      contentType: 'application/json',
    })
  }
})
