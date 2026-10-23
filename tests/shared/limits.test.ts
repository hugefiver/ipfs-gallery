import { describe, expect, it } from 'vitest'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

describe('resource defaults', () => {
  it('provides positive integer budgets and bounded concurrency', () => {
    const MiB = 1024 * 1024
    expect(DEFAULT_LIMITS).toEqual({
      maxRoots: 100,
      maxGateways: 8,
      maxManifestBytes: MiB,
      maxManifestDepth: 16,
      maxManifestNodes: 30_000,
      maxItems: 2_000,
      maxDirectoryDepth: 16,
      maxDirectoryEntries: 10_000,
      maxBlockBytes: 4 * MiB,
      maxAssetBytes: 64 * MiB,
      maxImagePixels: 40_000_000,
      maxMediaDimension: 16_384,
      maxBlockConcurrency: 6,
      maxGatewayConcurrency: 2,
      maxAssetConcurrency: 3,
      maxBlockCacheBytes: 16 * MiB,
      maxBlobCacheBytes: 128 * MiB,
      maxAssemblyBytes: 64 * MiB,
      maxDiscoveryInputBytes: 128 * MiB,
      maxAssetInputBytes: 96 * MiB,
      gatewayTimeoutMs: 30_000,
      blockTimeoutMs: 120_000,
      discoveryTimeoutMs: 300_000,
      assetTimeoutMs: 300_000,
      progressIntervalMs: 100,
      telemetryIntervalMs: 500,
    })
    for (const budget of Object.values(DEFAULT_LIMITS)) {
      expect(Number.isSafeInteger(budget)).toBe(true)
      expect(budget).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true)
  })

  it('uses distinct public HTTPS candidate bases without credentials or URL state', () => {
    expect(DEFAULT_GATEWAYS).toEqual([
      'https://ipfs.filebase.io',
      'https://ipfs.orbitor.dev',
      'https://apac.orbitor.dev',
      'https://dget.top',
      'https://ipfs.4everland.io',
    ])
    expect(DEFAULT_GATEWAYS.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxGateways)
    expect(new Set(DEFAULT_GATEWAYS).size).toBe(DEFAULT_GATEWAYS.length)
    for (const candidate of DEFAULT_GATEWAYS) {
      const url = new URL(candidate)
      expect(url.protocol).toBe('https:')
      expect(url.hostname).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/)
      expect(url.hostname).not.toBe('localhost')
      expect(url.username).toBe('')
      expect(url.password).toBe('')
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    }
  })
})
