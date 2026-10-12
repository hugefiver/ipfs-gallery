import { init } from 'react-scan/install-hook'
import { instrument } from 'react-scan/lite'
import type { ReactScanRecord, ReactScanPhase } from './react-scan'

declare global {
  interface Window {
    __auditMeasurementId: string
    __auditReactDocument: {
      measurementId: string
      documentId: string
      phase: ReactScanPhase
      sequence: number
      deliveries: Promise<void>[]
      deliveryErrors: string[]
    }
    __recordAuditReactEvent(record: ReactScanRecord): Promise<void>
  }
}

// This IIFE is installed by addInitScript, synchronously before the app imports React.
const documentEvidence = window.__auditReactDocument = {
  measurementId: window.__auditMeasurementId,
  documentId: crypto.randomUUID(),
  phase: 'navigation' as ReactScanPhase,
  sequence: 0,
  deliveries: [] as Promise<void>[],
  deliveryErrors: [] as string[],
}
init()
instrument({
  recordChangeDescriptions: true,
  includeFiberSource: true,
  includeFiberIdentity: true,
  onEvent: (event) => {
    documentEvidence.deliveries.push(window.__recordAuditReactEvent({
      url: window.location.href,
      measurementId: documentEvidence.measurementId,
      documentId: documentEvidence.documentId,
      phase: documentEvidence.phase,
      sequence: ++documentEvidence.sequence,
      event,
    }).catch(error => { documentEvidence.deliveryErrors.push(String(error)) }))
  },
})
