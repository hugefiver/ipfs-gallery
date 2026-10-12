import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { playAudit } from 'playwright-lighthouse'
import { waitForOwnedAudit, type OwnedAuditBrowser } from '../support/owned-audit-browser'

type AuditResult = Pick<Awaited<ReturnType<typeof playAudit>>, 'lhr'>
type MeasuredReport = { result: AuditResult; html: string; json: string }

// Resolve only the already installed audit dependency graph; no CLI or browser launch.
const dependencyRequire = createRequire(createRequire(import.meta.url).resolve('playwright-lighthouse'))
const lighthouseEntry = dependencyRequire.resolve('lighthouse')
const lighthouseRequire = createRequire(lighthouseEntry)

// Lighthouse's signal covers navigation waits, not all gathering/auditing work.
// A terminated worker also contains the installed driver's unhandled CDP callbacks.
const measurementWorker = `
const { parentPort, workerData } = require('node:worker_threads');
let pendingPhase;
parentPort.on('message', () => { pendingPhase?.(); pendingPhase = undefined; });
function checkpoint(phase) {
  return new Promise(resolve => { pendingPhase = resolve; parentPort.postMessage({ phase }); });
}
(async () => {
  const lighthouse = await import(workerData.lighthouse);
  const puppeteer = await import(workerData.puppeteer);
  const { default: BFCacheFailures } = await import(workerData.bfCache);
  class MeasurementBFCache extends BFCacheFailures {
    async getArtifact(context) {
      await checkpoint('before-bfcache');
      return super.getArtifact(context);
    }
  }
  const connection = await puppeteer.connect({
    browserURL: workerData.browserURL, defaultViewport: null, protocolTimeout: 10000,
  });
  let report;
  const errors = [];
  try {
    const pages = await connection.pages();
    if (pages.length !== 1 || pages[0].url() !== workerData.initialUrl) {
      throw new Error('Audit must own exactly one measurement tab');
    }
    const result = await lighthouse.navigation(pages[0], () => checkpoint('prepare'), {
      config: { ...workerData.config, artifacts: [{ id: 'BFCacheFailures', gatherer: MeasurementBFCache }] },
      flags: { logLevel: 'error', disableStorageReset: true,
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] },
    });
    if (!result) throw new Error('Lighthouse did not return a navigation report');
    report = { result: { lhr: result.lhr }, html: lighthouse.generateReport(result.lhr, 'html'),
      json: lighthouse.generateReport(result.lhr, 'json') };
  } catch (error) {
    errors.push(error);
  } finally {
    try { await connection.disconnect(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Lighthouse measurement and disconnect failed');
  parentPort.postMessage({ report });
})().catch(error => { throw error; });
`

export async function measuredNavigation(
  owned: OwnedAuditBrowser,
  config: Record<string, unknown>,
  prepare: () => Promise<void>,
  options: { signal: AbortSignal; beforeBFCache: () => Promise<void> },
): Promise<MeasuredReport> {
  const { signal } = options
  signal.throwIfAborted()
  const worker = new Worker(measurementWorker, {
    eval: true,
    workerData: {
      lighthouse: pathToFileURL(lighthouseEntry).href,
      puppeteer: pathToFileURL(lighthouseRequire.resolve('puppeteer-core')).href,
      bfCache: new URL('./gather/gatherers/bf-cache-failures.js', pathToFileURL(lighthouseEntry)).href,
      browserURL: `http://127.0.0.1:${owned.port}`,
      initialUrl: owned.page.url(),
      config,
    },
  })
  const report = new Promise<MeasuredReport>((resolve, reject) => {
    worker.on('message', (message: { phase?: 'prepare' | 'before-bfcache'; report?: MeasuredReport }) => {
      if (message.report) {
        resolve(message.report)
      } else if (message.phase) {
        const callback = message.phase === 'prepare' ? prepare : options.beforeBFCache
        waitForOwnedAudit(Promise.resolve().then(callback), signal).then(
          () => worker.postMessage('completed'),
          reject,
        )
      }
    })
    worker.on('error', reject)
    worker.on('exit', code => reject(new Error(`Owned Lighthouse worker exited before returning a report (${code})`)))
  })
  let result: MeasuredReport | undefined
  const errors: unknown[] = []
  try {
    result = await waitForOwnedAudit(report, signal)
  } catch (error) {
    errors.push(error)
  } finally {
    // Await exit before resolving/rejecting: timeout is cancellation, not an abandoned race.
    try { await worker.terminate() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Owned Lighthouse work and worker cleanup failed', { cause: errors[0] })
  return result!
}
