import type { ResourceLimits } from './contracts'

const MiB = 1024 * 1024

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
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
