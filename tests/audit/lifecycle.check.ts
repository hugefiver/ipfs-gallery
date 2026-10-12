import { inspect } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from '@playwright/test'
import type { Browser } from 'playwright'
import { auditRoute } from './audit-route'
import { launchOwnedAuditBrowser, OWNED_CLOSE_BUDGET_MS } from '../support/owned-audit-browser'
import { measuredNavigation } from './measured-navigation'
import { readFile, stat } from 'node:fs/promises'

for (const failure of ['rejected', 'pending'] as const) {
  test(`a primary audit failure still closes its owned browser when the route disposer is ${failure}`, async ({ playwright }, testInfo) => {
    const primary = new Error('Instrumentation installation failed')
    const cleanup = new Error('Route disposal failed')
    let browser: Browser | undefined
    let restoreInstrumentation: (() => void) | undefined
    let release!: () => void
    let disposalStarted!: () => void
    const disposing = new Promise<void>(resolve => { disposalStarted = resolve })
    const pendingDisposal = new Promise<void>(resolve => { release = resolve })
    let disposalAttempted = false
    const audit = auditRoute({
      url: 'http://audit-support.invalid/',
      preset: 'desktop',
      outputDir: testInfo.outputPath('failed-audit'),
      install: async context => {
        browser = context.browser()!
        expect(browser.browserType().name()).toBe(playwright.chromium.name())
        const original = context.addInitScript.bind(context)
        context.addInitScript = async () => { throw primary }
        restoreInstrumentation = () => { context.addInitScript = original }
        return async () => {
          disposalAttempted = true
          disposalStarted()
          if (failure === 'rejected') throw cleanup
          await pendingDisposal
        }
      },
    }).then(() => undefined, error => error as unknown)
    try {
      await Promise.race([disposing, audit.then(outcome => { throw outcome ?? new Error('The failing audit unexpectedly passed') })])
      const deadline = new AbortController()
      const outcome = await Promise.race([
        audit,
        delay(OWNED_CLOSE_BUDGET_MS + 10_000, 'still-pending', { signal: deadline.signal }),
      ]).finally(() => deadline.abort())
      await testInfo.attach('audit-failure', { body: inspect(outcome), contentType: 'text/plain' })
      expect(outcome).toBeInstanceOf(AggregateError)
      expect((outcome as AggregateError).cause).toBe(primary)
      const errors = (outcome as AggregateError).errors as unknown[]
      expect(errors).toHaveLength(2)
      expect(errors).toContain(primary)
      if (failure === 'rejected') expect(errors).toContain(cleanup)
      expect(disposalAttempted).toBe(true)
      expect(browser!.isConnected()).toBe(false)
      const ownership = JSON.parse(await readFile(testInfo.outputPath('failed-audit', 'desktop-1-owned-browser.json'), 'utf8')) as { runRoot: string; port: number }
      await expect(stat(ownership.runRoot)).rejects.toThrow()
      await expect(fetch(`http://127.0.0.1:${ownership.port}/json/version`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
    } finally {
      release()
      await audit
      restoreInstrumentation?.()
      if (browser?.isConnected()) await browser.close()
    }
  })
}

test('a deadline interrupts and settles the owned Lighthouse worker while its requestor is pending', async () => {
  const owned = await launchOwnedAuditBrowser()
  const controller = new AbortController()
  const deadline = new Error('Owned measurement deadline')
  let timer: ReturnType<typeof setTimeout> | undefined
  let release!: () => void
  const pendingRequestor = new Promise<void>(resolve => { release = resolve })
  let requestorStarted = false
  try {
    const measurement = measuredNavigation(owned, { extends: 'lighthouse:default' }, async () => {
      requestorStarted = true
      timer = setTimeout(() => controller.abort(deadline), 25)
      await pendingRequestor
    }, {
      signal: controller.signal,
      beforeBFCache: async () => { throw new Error('A canceled navigation cannot reach artifact evidence') },
    })
    await expect(measurement).rejects.toBe(deadline)
    expect(requestorStarted).toBe(true)
    expect(owned.context.browser()!.isConnected()).toBe(true)
  } finally {
    clearTimeout(timer)
    release()
    await owned.close()
  }
  await expect(stat(owned.runRoot)).rejects.toThrow()
})
