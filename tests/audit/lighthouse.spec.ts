import { expect, test } from '@playwright/test'
import { auditRoute, assertAuditTargets, type AuditPreset } from './audit-route'
import { createGalleryFixtures } from '../fixtures/unixfs'
import { startSwGalleryNetwork } from '../support/sw-gallery-network'
import { launchSwGalleryAuditBrowser } from '../support/sw-gallery-audit'
import { sourceUrl } from '../e2e/gateway-route'
import { ui, enterAlbum, expectReaderImage, expectImageBytes } from '../e2e/gallery-ui'

for (const preset of ['mobile', 'desktop'] as const satisfies readonly AuditPreset[]) {
  test(`empty production page: ${preset}, three-run medians`, async ({ baseURL }, testInfo) => {
    test.setTimeout(360_000)
    if (!baseURL) throw new Error('Production preview baseURL is required')
    const fixtures = await createGalleryFixtures()
    const network = await startSwGalleryNetwork(fixtures.blocks)
    try {
      const result = await auditRoute({
        url: new URL('/', network.baseURL).href,
        launch: signal => launchSwGalleryAuditBrowser(network, signal),
        preset,
        outputDir: testInfo.outputPath(`empty-${preset}`),
        verifyPage: async page => {
          await expect(ui.source(page)).toHaveValue('')
          await expect(ui.dialog(page)).toHaveCount(1)
          const heading = ui.dialog(page).getByRole('heading', { level: 2 })
          await expect(heading).toBeVisible()
          await expect(heading).not.toHaveText('')
          await expect(ui.dialog(page)).toHaveAttribute('aria-labelledby', (await heading.getAttribute('id'))!)
          await expect(ui.dialog(page)).toHaveAccessibleName(await heading.innerText())
          await expect(page.locator('iframe')).toHaveCount(0)
        },
      })
      await testInfo.attach('audit-summary', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
      assertAuditTargets(result.medians)
      expect(result.runs.every(run => run.react.status === 'observed'), 'React renderer and commit stream must be observed').toBe(true)
      testInfo.annotations.push({ type: 'verification-limit', description: result.runs[0]!.react.limitations.join(' ') })
      expect(network.router.events).toEqual([])
      expect(network.bridge.routes).toEqual([])
      expect(network.unexpectedRequests).toEqual([])
    } finally { await network.close() }
  })

  for (const surface of ['reader', 'album'] as const) {
    test(`fixture ${surface} production page: ${preset}, three-run medians`, async ({ baseURL }, testInfo) => {
      test.setTimeout(360_000)
      if (!baseURL) throw new Error('Production preview baseURL is required')
      const fixtures = await createGalleryFixtures()
      const network = await startSwGalleryNetwork(fixtures.blocks)
      try {
        const url = new URL(sourceUrl('unixfs', fixtures.directories.json.ref), network.baseURL).href
        const result = await auditRoute({
          url,
          preset,
          outputDir: testInfo.outputPath(`${surface}-${preset}`),
          launch: signal => launchSwGalleryAuditBrowser(network, signal),
          preparePage: async page => {
            await expectReaderImage(page, fixtures.raw.bytes)
            if (surface === 'album') await enterAlbum(page)
          },
          verifyPage: async page => {
            if (surface === 'reader') {
              await expectReaderImage(page, fixtures.raw.bytes)
              await expect(ui.reader(page).getByRole('img')).toHaveCount(1)
            } else {
              await expect(ui.album(page)).toBeVisible()
              await expect(ui.tiles(page)).toHaveCount(4)
              await expectImageBytes(ui.tileImage(page, '琥珀影像'), fixtures.raw.bytes)
            }
            if (surface === 'reader') { await expect(ui.menuButton(page)).toBeVisible(); await expect(page.getByRole('button')).toHaveCount(1) }
            else await expect(ui.menuButton(page)).toBeVisible()
            await expect(ui.dialog(page)).toHaveCount(0)
            await expect(page.locator('iframe')).toHaveCount(0)
            expect(new URL(page.url()).searchParams.has('mode')).toBe(false)
            expect(page.workers().length).toBeGreaterThan(0)
          },
        })
        await testInfo.attach('audit-summary', { body: JSON.stringify({ surface, ...result }, null, 2), contentType: 'application/json' })
        assertAuditTargets(result.medians)
        expect(network.bridge.routes.length).toBeGreaterThan(0)
        expect(network.bridge.errors).toEqual([])
        expect(network.unexpectedRequests).toEqual([])
        expect([...network.slow.requests, ...network.fast.requests].some(request => request.status === 200)).toBe(true)
        expect(network.bridge.routes.every(request => new URL(request.url).searchParams.get('format') === 'raw')).toBe(true)
        expect(result.runs.every(run => run.react.status === 'observed'), 'React renderer and commit stream must be observed').toBe(true)
        testInfo.annotations.push({ type: 'verification-limit', description: result.runs[0]!.react.limitations.join(' ') })
      } finally {
        try {
          await testInfo.attach('raw-gateway-requests', { body: JSON.stringify({ receivedHttps: network.bridge.routes, slow: network.slow.requests, fast: network.fast.requests, router: network.router.events, proxy: network.proxy.events }, null, 2), contentType: 'application/json' })
        } finally {
          await network.close()
        }
      }
    })
  }
}
