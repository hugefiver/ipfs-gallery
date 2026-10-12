import { expect, test } from '@playwright/test'
import { assertAuditTargets, medianScores, type AuditScores } from './audit-route'
import { reactScanEvidence } from './react-scan'

const perfect: AuditScores = { performance: 100, accessibility: 100, 'best-practices': 100, seo: 100 }

test('median scoring tolerates an outlier, but fails a below-target category median', () => {
  const median = medianScores([perfect, { ...perfect, performance: 74, seo: 99 }, perfect])
  expect(median).toEqual(perfect)
  expect(() => assertAuditTargets(median)).not.toThrow()
  const failing = medianScores([perfect, { ...perfect, accessibility: 99 }, { ...perfect, accessibility: 99 }])
  expect(failing.accessibility).toBe(99)
  expect(() => assertAuditTargets(failing)).toThrow()
})

test('incomplete or invalid Lighthouse samples cannot become a passing median', () => {
  expect(() => medianScores([perfect, perfect])).toThrow()
  expect(() => medianScores([perfect, { ...perfect, performance: Number.NaN }, perfect])).toThrow()
  expect(() => medianScores([perfect, { ...perfect, seo: -1 }, perfect])).toThrow()
  expect(() => medianScores([perfect, { ...perfect, seo: 101 }, perfect])).toThrow()
  expect(() => assertAuditTargets({ ...perfect, performance: 99.5 })).toThrow()
})

test('an absent React event stream is unavailable, not a zero-render pass', () => {
  const evidence = reactScanEvidence([], { url: 'http://127.0.0.1/', measurementId: 'measurement', documentId: 'document', throughSequence: 0 })
  expect(evidence.status).toBe('unavailable')
  expect(evidence.renderQualityStatus).toBe('unverified')
  expect(evidence.commitCount).toBe(0)
  expect(evidence.limitations.length).toBeGreaterThan(0)
})
