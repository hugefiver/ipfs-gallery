export type ContentRef = { cid: string; path: string[] }

export type Source =
  | { kind: 'manifest'; ref: ContentRef }
  | { kind: 'unixfs'; ref: ContentRef; browse: boolean }
  | { kind: 'cids'; refs: ContentRef[]; browse: boolean }

export interface GalleryInput {
  source: Source
}

export interface ViewState {
  q: string
  tags: string[]
  type?: 'image' | 'video'
  item?: string
}

export interface ParsedLocation {
  input?: GalleryInput
  view: ViewState
  gateways: string[]
  notices: string[]
}

export type MediaKind = 'image' | 'video' | 'unknown'

export interface GalleryItem {
  id: string
  ref: ContentRef
  thumbnail?: ContentRef
  title: string
  alt: string
  tags: string[]
  kind: MediaKind
  width?: number
  height?: number
  sourceLabel: string
}

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_METADATA'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'INTEGRITY'
  | 'TIMEOUT'
  | 'LIMIT'
  | 'CANCELLED'
  | 'INTERNAL'

export interface GalleryError {
  code: ErrorCode
  message: string
  retryable: boolean
  ref?: ContentRef
  gateway?: string
}

export interface GalleryResult {
  title: string
  description: string
  items: GalleryItem[]
  warnings: GalleryError[]
  partial: boolean
}

export interface GatewayStat {
  url: string
  state: 'healthy' | 'cooldown' | 'probing'
  ewmaMs?: number
  inFlight: number
  successes: number
  failures: number
  cooldownUntil?: number
}

export interface SessionConfig {
  gateways: string[]
  limits: ResourceLimits
}

export interface ResourceLimits {
  maxRoots: number
  maxGateways: number
  maxManifestBytes: number
  maxManifestDepth: number
  maxManifestNodes: number
  maxItems: number
  maxDirectoryDepth: number
  maxDirectoryEntries: number
  maxBlockBytes: number
  maxAssetBytes: number
  maxImagePixels: number
  maxMediaDimension: number
  maxBlockConcurrency: number
  maxGatewayConcurrency: number
  maxAssetConcurrency: number
  maxBlockCacheBytes: number
  maxBlobCacheBytes: number
  maxAssemblyBytes: number
  maxDiscoveryInputBytes: number
  maxAssetInputBytes: number
  gatewayTimeoutMs: number
  blockTimeoutMs: number
  discoveryTimeoutMs: number
  assetTimeoutMs: number
  progressIntervalMs: number
  telemetryIntervalMs: number
}

export interface VerifiedAsset {
  bytes: ArrayBuffer
  mime: string
  kind: 'image' | 'video'
  byteLength: number
  width?: number
  height?: number
}

export type WorkerRequest =
  | {
      type: 'discover'
      sessionId: string
      requestId: string
      input: GalleryInput
      config: SessionConfig
    }
  | { type: 'asset'; sessionId: string; requestId: string; ref: ContentRef }
  | { type: 'cancel'; sessionId: string; requestId: string; targetRequestId: string }
  | { type: 'release-session'; sessionId: string; requestId: string }
  | { type: 'dispose'; sessionId: string; requestId: string }

export type WorkerResponse =
  | {
      type: 'result'
      sessionId: string
      requestId: string
      op: 'discover'
      value: GalleryResult
    }
  | {
      type: 'result'
      sessionId: string
      requestId: string
      op: 'asset'
      value: VerifiedAsset
    }
  | {
      type: 'result'
      sessionId: string
      requestId: string
      op: 'cancel' | 'release-session' | 'dispose'
      value: null
    }
  | { type: 'error'; sessionId: string; requestId: string; error: GalleryError }
  | {
      type: 'progress'
      sessionId: string
      requestId: string
      phase: 'resolving' | 'listing' | 'metadata' | 'media'
      completed: number
      total?: number
    }
  | {
      type: 'telemetry'
      sessionId: string
      requestId: string
      gateways: GatewayStat[]
    }

export interface GalleryClient {
  discover(request: Extract<WorkerRequest, { type: 'discover' }>): Promise<GalleryResult>
  loadAsset(request: Extract<WorkerRequest, { type: 'asset' }>): Promise<VerifiedAsset>
  cancel(request: Extract<WorkerRequest, { type: 'cancel' }>): Promise<void>
  releaseSession(request: Extract<WorkerRequest, { type: 'release-session' }>): Promise<void>
  dispose(request: Extract<WorkerRequest, { type: 'dispose' }>): Promise<void>
  subscribe(
    listener: (event: Extract<WorkerResponse, { type: 'progress' | 'telemetry' }>) => void,
  ): () => void
}
