import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { launchOwnedAuditBrowser, OWNED_CLOSE_BUDGET_MS, waitForOwnedAudit, withinOwnedAuditBudget, type OwnedAuditBrowser } from '../support/owned-audit-browser'
import { installReactScan, reactScanDocument, reactScanEvidence, type ReactScanDocument, type ReactScanEvidence } from './react-scan'
import { measuredNavigation } from './measured-navigation'

export const AUDIT_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const
export type AuditCategory = typeof AUDIT_CATEGORIES[number]
export type AuditScores = Record<AuditCategory, number>
export type AuditPreset = 'mobile' | 'desktop'
export const AUDIT_TARGETS: AuditScores = { performance: 100, accessibility: 100, 'best-practices': 100, seo: 100 }
// One run owns 90s: 45s for launch/install/navigation/evidence, then at most
// 5s route disposal + 35s owned process/profile close + 5s measurement settlement.
export const AUDIT_RUN_BUDGET_MS = 90_000
const DISPOSAL_BUDGET_MS = 5_000
const SETTLE_BUDGET_MS = 5_000
const WORK_BUDGET_MS = AUDIT_RUN_BUDGET_MS - DISPOSAL_BUDGET_MS - OWNED_CLOSE_BUDGET_MS - SETTLE_BUDGET_MS

async function pageGeometry(page: Page) {
  return page.evaluate(() => ({
    documentId: window.__auditReactDocument.documentId,
    url: location.href,
    capturedAt: new Date().toISOString(),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
    documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    elements: [...document.querySelectorAll('main,header,nav,aside,footer,dialog,[id],[data-testid],[data-ui],button,input,a,img,[role]')]
      .filter(element => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
      .map(element => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          testId: element.getAttribute('data-testid'),
          ui: element.getAttribute('data-ui'),
          role: element.getAttribute('role'),
          label: element.getAttribute('aria-label'),
          text: element instanceof HTMLElement ? element.innerText : element.textContent,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          image: element instanceof HTMLImageElement ? {
            currentSrc: element.currentSrc, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight, complete: element.complete,
          } : undefined,
        }
      }),
  }))
}

export interface AuditMeasurement {
  phase: 'before-bfcache'
  document: ReactScanDocument
  geometry: Awaited<ReturnType<typeof pageGeometry>>
  screenshotFile: string
}

export interface AuditRun {
  preset: AuditPreset
  run: number
  scores: AuditScores
  warnings: string[]
  failingAudits: { id: string; score: number | null; title: string; displayValue?: string }[]
  react: ReactScanEvidence
  measurement: AuditMeasurement
}

export interface RouteAudit {
  url: string
  preset: AuditPreset
  runs: AuditRun[]
  medians: AuditScores
  scoreStatus: 'passed' | 'failed'
}

export function medianScores(samples: readonly AuditScores[]): AuditScores {
  if (samples.length !== 3) throw new Error('A route audit requires exactly three complete runs')
  return Object.fromEntries(AUDIT_CATEGORIES.map((category) => {
    const scores = samples.map((sample) => sample[category])
    if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 100)) {
      throw new Error(`Missing or invalid ${category} score`)
    }
    scores.sort((a, b) => a - b)
    return [category, scores[1]!]
  })) as AuditScores
}

export function assertAuditTargets(scores: AuditScores): void {
  const failures = AUDIT_CATEGORIES.filter((category) => scores[category] !== AUDIT_TARGETS[category])
  if (failures.length) {
    throw new Error(`Lighthouse target not met: ${failures.map((category) => `${category}=${scores[category]}/100`).join(', ')}`)
  }
}

export async function auditRoute(options: {
  url: string
  preset: AuditPreset
  outputDir: string
  install?: (context: BrowserContext) => Promise<void | (() => Promise<void>)>
  verifyPage?: (page: Page) => Promise<void>
  preparePage?: (page: Page) => Promise<void>
  signal?: AbortSignal
}): Promise<RouteAudit> {
  const url = new URL(options.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Audit requires a top-level HTTP(S) page, not an opaque iframe')
  if (url.port === '4173') throw new Error('Audit must not use the user preview')
  await withinOwnedAuditBudget(mkdir(options.outputDir, { recursive: true }), 5_000, 'Audit output directory')
  const runs: AuditRun[] = []
  for (let run = 1; run <= 3; run += 1) {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    const auditDeadline = setTimeout(() => controller.abort(new Error('Owned audit work exceeded its run budget')), WORK_BUDGET_MS)
    let owned: OwnedAuditBrowser | undefined
    let measurementWork: ReturnType<typeof measuredNavigation> | undefined
    let disposeRoutes: void | (() => Promise<void>) = undefined
    const errors: unknown[] = []
    const name = `${options.preset}-${run}`
    try {
      owned = await launchOwnedAuditBrowser(signal)
      const browser = owned
      await waitForOwnedAudit(writeFile(join(options.outputDir, `${name}-owned-browser.json`), JSON.stringify({ runRoot: browser.runRoot, port: browser.port }, null, 2)), signal)
      disposeRoutes = await waitForOwnedAudit(Promise.resolve(options.install?.(browser.context)), signal)
      const reactRecords = await waitForOwnedAudit(installReactScan(browser.context), signal)
      const config = options.preset === 'desktop'
          ? { extends: 'lighthouse:default', settings: {
            formFactor: 'desktop',
            screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
            emulatedUserAgent: false,
            throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
          } }
          : { extends: 'lighthouse:default', settings: {
            formFactor: 'mobile',
            screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
            throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
          } }
      let prepared: ReactScanDocument | undefined
      let measurement: AuditMeasurement | undefined
      let react: ReactScanEvidence | undefined
      measurementWork = measuredNavigation(browser, config, async () => {
        await browser.page.goto(options.url)
        await options.preparePage?.(browser.page)
        await options.verifyPage?.(browser.page)
        prepared = await reactScanDocument(browser.page, 'prepared')
      }, {
        signal,
        beforeBFCache: async () => {
          const document = await reactScanDocument(browser.page, 'before-bfcache')
          if (!prepared || document.documentId !== prepared.documentId || document.url !== options.url) {
            throw new Error('The prepared measurement document changed before artifact collection completed')
          }
          await options.verifyPage?.(browser.page)
          const geometry = await pageGeometry(browser.page)
          const screenshotFile = `${name}-measured.png`
          await browser.page.screenshot({ path: join(options.outputDir, screenshotFile), type: 'png', caret: 'initial' })
          await options.verifyPage?.(browser.page)
          const cutoff = await reactScanDocument(browser.page, 'probe')
          if (cutoff.documentId !== document.documentId || geometry.documentId !== document.documentId || cutoff.url !== options.url) {
            throw new Error('The measurement document changed while collecting target evidence')
          }
          measurement = { phase: 'before-bfcache', document: cutoff, geometry, screenshotFile }
          react = reactScanEvidence(reactRecords, cutoff)
          await writeFile(join(options.outputDir, `${name}-measurement.json`), JSON.stringify({ ...measurement, react }, null, 2))
        },
      })
      const measured = await waitForOwnedAudit(measurementWork, signal)
      const { result } = measured
      await waitForOwnedAudit(writeFile(join(options.outputDir, `${name}.html`), measured.html), signal)
      await waitForOwnedAudit(writeFile(join(options.outputDir, `${name}.json`), measured.json), signal)
      if (result.lhr.runtimeError) throw new Error(`Lighthouse runtime failure: ${result.lhr.runtimeError.code}`)
      if (result.lhr.finalDisplayedUrl !== options.url) throw new Error('Lighthouse measured a different top-level page')
      if (!measurement || !react) throw new Error('Lighthouse did not produce document-bound target evidence')
      const scores = Object.fromEntries(AUDIT_CATEGORIES.map((category) => {
        const score = result.lhr.categories[category]?.score
        if (score == null || !Number.isFinite(score)) throw new Error(`Lighthouse omitted ${category}`)
        return [category, score * 100]
      })) as AuditScores
      const evidence: AuditRun = {
        preset: options.preset,
        run,
        scores,
        warnings: result.lhr.runWarnings ?? [],
        failingAudits: Object.entries(result.lhr.audits)
          .filter(([, audit]) => audit.score !== null && audit.score < 1)
          .map(([id, audit]) => ({ id, score: audit.score, title: audit.title, displayValue: audit.displayValue })),
        react,
        measurement,
      }
      runs.push(evidence)
      await waitForOwnedAudit(writeFile(join(options.outputDir, `${name}-evidence.json`), JSON.stringify(evidence, null, 2)), signal)
      const screenshot = result.lhr.audits['final-screenshot']?.details
      if (screenshot?.type !== 'screenshot') throw new Error('Lighthouse omitted its actual final screenshot')
      const match = /^data:image\/jpeg;base64,(.+)$/.exec(screenshot.data)
      if (!match?.[1]) throw new Error('Lighthouse returned an unsupported final screenshot')
      await waitForOwnedAudit(writeFile(join(options.outputDir, `${name}.jpg`), Buffer.from(match[1], 'base64')), signal)
    } catch (error) {
      errors.push(error)
    } finally {
      clearTimeout(auditDeadline)
      controller.abort(new Error('Owned audit measurement ended'))
      try {
        await withinOwnedAuditBudget(Promise.resolve().then(() => disposeRoutes?.()), DISPOSAL_BUDGET_MS, 'Route disposal')
      } catch (error) {
        errors.push(error)
      } finally {
        try { await owned?.close() } catch (error) { errors.push(error) }
      }
      if (measurementWork) {
        try {
          await withinOwnedAuditBudget(measurementWork.then(() => undefined, error => {
            const failures: unknown[] = error instanceof AggregateError ? error.errors : [error]
            for (const failure of failures) {
              if (failure !== signal.reason && !errors.includes(failure)) errors.push(failure)
            }
          }), SETTLE_BUDGET_MS, 'Interrupted Lighthouse settlement')
        } catch (error) {
          errors.push(error)
        }
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Audit work and owned cleanup failed', { cause: errors[0] })
  }
  const medians = medianScores(runs.map((run) => run.scores))
  const result: RouteAudit = {
    url: options.url,
    preset: options.preset,
    runs,
    medians,
    scoreStatus: AUDIT_CATEGORIES.every((category) => medians[category] === 100) ? 'passed' : 'failed',
  }
  await withinOwnedAuditBudget(writeFile(join(options.outputDir, 'summary.json'), JSON.stringify(result, null, 2)), 5_000, 'Audit summary')
  return result
}
