import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from 'playwright'
import { launchOwnedAuditBrowser, readOwnedCdpPort, removeOwnedRunRoot } from '../support/owned-audit-browser'
import { AUDIT_CATEGORIES, assertAuditTargets, auditRoute } from './audit-route'
import { bundleBrowserEntry, installReactScan, reactScanDocument, reactScanEvidence, type ReactScanDocument } from './react-scan'

test('owned Chromium endpoint is fresh and cleanup requires the exact marker', async () => {
  const owned = await launchOwnedAuditBrowser()
  try {
    expect(await readOwnedCdpPort(join(owned.runRoot, 'user-data'), Date.now() - 10_000)).toBe(owned.port)
    await expect(removeOwnedRunRoot(owned.runRoot, 'not-the-owner')).rejects.toThrow()
    expect((await stat(owned.runRoot)).isDirectory()).toBe(true)
    await expect(readOwnedCdpPort(join(owned.runRoot, 'user-data'), Date.now() + 60_000)).rejects.toThrow()
    const marker = join(owned.runRoot, '.ocmm-run-owner')
    const token = await readFile(marker, 'utf8')
    try {
      await writeFile(marker, 'changed-owner')
      await expect(removeOwnedRunRoot(owned.runRoot, token)).rejects.toThrow()
    } finally {
      await writeFile(marker, token)
    }
    const endpointFile = join(owned.runRoot, 'user-data', 'DevToolsActivePort')
    const endpointText = await readFile(endpointFile, 'utf8')
    try {
      await writeFile(endpointFile, `${owned.port}\n/devtools/browser/not-this-browser\n`)
      await expect(readOwnedCdpPort(join(owned.runRoot, 'user-data'), Date.now())).rejects.toThrow()
    } finally {
      await writeFile(endpointFile, endpointText)
    }
    const originalContextClose = owned.context.close.bind(owned.context)
    owned.context.close = async () => { throw new Error('Context disposer rejected') }
    try {
      await writeFile(marker, 'changed-owner')
      await expect(owned.close()).rejects.toThrow()
      expect(owned.context.browser()!.isConnected()).toBe(false)
    } finally {
      owned.context.close = originalContextClose
      await writeFile(marker, token)
    }
    await expect(owned.close()).resolves.toBeUndefined()
  } finally {
    await owned.close()
  }
  await expect(stat(owned.runRoot)).rejects.toThrow()
  await owned.close()
})

test('owned measurement tab retains context raw routing and pre-React lite instrumentation', async ({ playwright }, testInfo) => {
  test.setTimeout(360_000)
  const app = await bundleBrowserEntry(new URL('./support-page.tsx', import.meta.url))
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Owned browser routing and instrumentation contract check">
    <title>Owned browser contract</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
  const diagnostics = { served: [] as string[], pageErrors: [] as string[], failedRequests: [] as string[] }
  const server = createServer((request, response) => {
    diagnostics.served.push(request.url ?? '/')
    response.setHeader('content-type', request.url === '/app.js' ? 'application/javascript' : 'text/html')
    response.end(request.url === '/app.js' ? app : html)
  })
  const owned = await launchOwnedAuditBrowser()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    owned.page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message))
    owned.page.on('requestfailed', (request) => diagnostics.failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`))
    expect(owned.context.browser()?.browserType().name()).toBe(playwright.chromium.name())
    const requests: string[] = []
    const installRawRoute = async (context: BrowserContext) => {
      await context.route('https://audit-gateway.invalid/ipfs/**', async (route) => {
        requests.push(route.request().url())
        expect(route.request().headers().accept).toContain('application/vnd.ipld.raw')
        await route.fulfill({
          status: 200,
          contentType: 'application/vnd.ipld.raw',
          headers: { 'access-control-allow-origin': '*' },
          body: 'verified raw bytes',
        })
      })
    }
    await installRawRoute(owned.context)
    const records = await installReactScan(owned.context)
    await owned.page.goto(url)
    expect(diagnostics.pageErrors).toEqual([])
    expect(diagnostics.failedRequests).toEqual([])
    expect(diagnostics.served).toContain('/app.js')
    await expect(owned.page.locator('#worker-result')).toHaveText('verified raw bytes')
    await owned.page.getByRole('button', { name: 'Update' }).click()
    await expect(owned.page.locator('#worker-result')).toHaveText('updated')
    await expect.poll(async () => reactScanEvidence(records, await reactScanDocument(owned.page, 'prepared')).status).toBe('observed')
    const initialDocument = await reactScanDocument(owned.page, 'before-bfcache')
    const initialEvidence = reactScanEvidence(records, initialDocument)
    await owned.page.reload()
    await expect(owned.page.locator('#worker-result')).toHaveText('verified raw bytes')
    const reloadedDocument = await reactScanDocument(owned.page, 'prepared')
    expect(reloadedDocument.documentId).not.toBe(initialDocument.documentId)
    expect(reactScanEvidence(records, initialDocument)).toEqual(initialEvidence)
    const initialRequests = requests.length
    await owned.close()
    const measurementPages = new Set<Page>()
    const probeDocuments: ReactScanDocument[] = []
    const result = await auditRoute({
      url,
      preset: 'desktop',
      outputDir: testInfo.outputPath('lighthouse-contract'),
      install: async (context) => {
        await installRawRoute(context)
        return async () => { probeDocuments.push(await reactScanDocument(context.pages()[0]!, 'probe')) }
      },
      preparePage: async (page) => {
        await expect(page.locator('#worker-result')).toHaveText('verified raw bytes')
        await page.getByRole('button', { name: 'Update' }).click()
      },
      verifyPage: async (page) => {
        expect(page.context().pages()).toEqual([page])
        measurementPages.add(page)
        await expect(page.locator('#worker-result')).toHaveText('updated')
      },
    })
    const evidence = result.runs.map((run) => run.react)
    const evidencePath = testInfo.outputPath('context-boundary-evidence.json')
    await writeFile(evidencePath, JSON.stringify({ requests, initialRequests, evidence }, null, 2))
    await testInfo.attach('context-boundary-evidence', {
      path: evidencePath,
      contentType: 'application/json',
    })
    expect(result.runs).toHaveLength(3)
    const scoresPassed = AUDIT_CATEGORIES.every((category) => result.medians[category] === 100)
    expect(result.scoreStatus).toBe(scoresPassed ? 'passed' : 'failed')
    if (!scoresPassed) expect(() => assertAuditTargets(result.medians)).toThrow()
    expect(measurementPages.size).toBe(3)
    expect(requests.length).toBeGreaterThanOrEqual(initialRequests + 3)
    expect(evidence.every((run) => run.status === 'observed')).toBe(true)
    expect(evidence.every((run) => run.commitCount > 0 && run.rendererCount > 0)).toBe(true)
    for (const [index, run] of result.runs.entries()) {
      expect(run.measurement.document).toEqual(run.react.document)
      expect(run.measurement.geometry.documentId).toBe(run.measurement.document.documentId)
      const worker = run.measurement.geometry.elements.find(element => element.id === 'worker-result')!
      expect(worker.text).toBe('updated')
      expect(worker.rect.width).toBeGreaterThan(0)
      expect(worker.rect.height).toBeGreaterThan(0)
      expect(run.react.records.every(record => record.documentId === run.measurement.document.documentId && record.phase !== 'probe')).toBe(true)
      const screenshot = await readFile(join(testInfo.outputPath('lighthouse-contract'), run.measurement.screenshotFile))
      expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const report = JSON.parse(await readFile(testInfo.outputPath('lighthouse-contract', `desktop-${run.run}.json`), 'utf8'))
      const ownership = JSON.parse(await readFile(testInfo.outputPath('lighthouse-contract', `desktop-${run.run}-owned-browser.json`), 'utf8')) as { runRoot: string }
      await expect(stat(ownership.runRoot)).rejects.toThrow()
      expect(Object.keys(report.categories).sort()).toEqual([...AUDIT_CATEGORIES].sort())
      expect(report.audits['bf-cache']).toBeDefined()
      const finalScreenshot = report.audits['final-screenshot'].details.data as string
      expect(await readFile(testInfo.outputPath('lighthouse-contract', `desktop-${run.run}.jpg`)))
        .toEqual(Buffer.from(finalScreenshot.slice('data:image/jpeg;base64,'.length), 'base64'))
      if (probeDocuments[index]!.documentId !== run.measurement.document.documentId) {
        expect(run.react.records.some(record => record.documentId === probeDocuments[index]!.documentId)).toBe(false)
      }
    }
  } finally {
    try {
      const diagnosticsPath = testInfo.outputPath('browser-contract-diagnostics.json')
      await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2))
      await testInfo.attach('browser-contract-diagnostics', { path: diagnosticsPath, contentType: 'application/json' })
    } finally {
      try {
        await owned.close()
      } finally {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
            server.closeAllConnections()
          })
        }
      }
    }
  }
})
