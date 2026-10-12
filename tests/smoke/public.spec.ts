import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import { ui, enterAlbum } from '../e2e/gallery-ui'

// Publicly pinned directory from https://docs.ipfs.tech/quickstart/retrieve/.
const directory = 'bafybeicn7i3soqdgr7dwnrwytgq4zxy7a5jpkizrvhm5mv6bgjd32wm3q4'

test('public UnixFS directory renders through CID-verified Worker retrieval', async ({ page, baseURL }, testInfo) => {
  if (!baseURL || new URL(baseURL).port === '4173') throw new Error('Public smoke requires an isolated preview')
  const requests: { url: string; status?: number; error?: string }[] = []
  page.context().on('request', (request) => {
    if (request.url().includes('format=raw')) requests.push({ url: request.url() })
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
    expect(requests.every((entry) => DEFAULT_GATEWAYS.some((gateway) => entry.url.startsWith(`${gateway}/ipfs/`)))).toBe(true)
    expect(page.workers().length).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('public-directory.png'), fullPage: true })
    await enterAlbum(page)
    await expect(ui.tiles(page).first()).toBeVisible()
    await ui.tiles(page).first().click()
    await expect(ui.reader(page)).toBeVisible()
  } finally {
    const evidencePath = testInfo.outputPath('public-retrieval.json')
    await writeFile(evidencePath, JSON.stringify({
      directory, timestamp: new Date().toISOString(), gateways: DEFAULT_GATEWAYS, requests,
    }, null, 2))
    await testInfo.attach('public-retrieval', {
      path: evidencePath,
      contentType: 'application/json',
    })
  }
})
