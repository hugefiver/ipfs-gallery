import type { BrowserContext, Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import type { LiteEvent } from 'react-scan/lite'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export interface ReactScanRecord {
  url: string
  measurementId: string
  documentId: string
  phase: ReactScanPhase
  sequence: number
  event: LiteEvent
}

export type ReactScanPhase = 'navigation' | 'prepared' | 'before-bfcache' | 'probe'

export interface ReactScanDocument {
  url: string
  measurementId: string
  documentId: string
  throughSequence: number
}

export interface ReactScanEvidence {
  status: 'observed' | 'unavailable'
  renderQualityStatus: 'unverified'
  rendererCount: number
  commitCount: number
  fiberSummaryCount: number
  records: ReactScanRecord[]
  limitations: string[]
  document: ReactScanDocument
}

export async function bundleBrowserEntry(entry: URL): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      emptyOutDir: false,
      minify: true,
      lib: { entry: fileURLToPath(entry), name: 'AuditInstrumentation', formats: ['iife'] },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const chunks = outputs.flatMap((output) => 'output' in output ? output.output : [])
    .filter((output) => output.type === 'chunk')
  if (chunks.length !== 1 || !chunks[0]) throw new Error('Audit browser entry did not produce one self-contained script')
  return chunks[0].code
}

let instrumentation: Promise<string> | undefined

export async function installReactScan(context: BrowserContext): Promise<ReactScanRecord[]> {
  const records: ReactScanRecord[] = []
  const measurementId = randomUUID()
  await context.exposeBinding('__recordAuditReactEvent', (source, record: ReactScanRecord) => {
    if (source.frame === source.page.mainFrame() && record.measurementId === measurementId) records.push(record)
  })
  instrumentation ??= bundleBrowserEntry(new URL('./react-scan-init.ts', import.meta.url))
  await context.addInitScript({ content: `window.__auditMeasurementId = ${JSON.stringify(measurementId)};\n${await instrumentation}` })
  return records
}

export async function reactScanDocument(page: Page, phase: ReactScanPhase): Promise<ReactScanDocument> {
  return page.evaluate(async phase => {
    const evidence = window.__auditReactDocument
    evidence.phase = phase
    await Promise.all(evidence.deliveries)
    if (evidence.deliveryErrors.length) throw new Error(`React evidence delivery failed: ${evidence.deliveryErrors.join('; ')}`)
    return {
      url: window.location.href,
      measurementId: evidence.measurementId,
      documentId: evidence.documentId,
      throughSequence: evidence.sequence,
    }
  }, phase)
}

export function reactScanEvidence(records: ReactScanRecord[], document: ReactScanDocument): ReactScanEvidence {
  const routeRecords = records.filter(record => record.url === document.url &&
    record.measurementId === document.measurementId && record.documentId === document.documentId &&
    record.sequence <= document.throughSequence && record.phase !== 'probe')
  const rendererCount = routeRecords.filter(({ event }) => event.kind === 'renderer-injected').length
  const commitCount = routeRecords.filter(({ event }) => event.kind === 'commit').length
  const fiberSummaryCount = routeRecords.reduce((count, { event }) => count + (event.kind === 'commit' ? event.tree?.length ?? 0 : 0), 0)
  const limitations = [
    'Installed react-scan/lite change descriptions expose props/state/context/hooks/parent, not an unnecessary-render classification. No zero-unnecessary-render verdict is available.',
  ]
  if (!rendererCount || !commitCount) {
    limitations.push('No complete renderer-and-commit stream was observed; render instrumentation is unverified, not a zero-event pass.')
  }
  if (commitCount && !fiberSummaryCount) {
    limitations.push('Commit events were observed, but the production renderer exposed no fiber timing summaries to the installed lite walker. Per-component render analysis is unverified.')
  }
  for (const { event } of routeRecords) {
    if (event.kind === 'profiling-hooks-status' && event.available === false) {
      limitations.push(`React ${event.reactVersion ?? 'unknown'} profiling hooks unavailable: ${event.reason ?? 'unknown'}.`)
    }
  }
  return {
    status: rendererCount > 0 && commitCount > 0 ? 'observed' : 'unavailable',
    renderQualityStatus: 'unverified',
    rendererCount,
    commitCount,
    fiberSummaryCount,
    records: routeRecords,
    document,
    limitations: [...new Set(limitations)],
  }
}
