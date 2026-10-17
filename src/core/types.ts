import type { ContentRef, GalleryError, ResourceLimits, WorkerResponse } from '../shared/contracts'

export interface ContentStat {
  kind: 'file' | 'directory' | 'symlink'
  size?: bigint
}

export interface ContentEntry extends ContentStat {
  name: string
  ref: ContentRef
}

export interface ContentEntryFailure {
  name: string
  ref: ContentRef
  error: GalleryError
}

export type ContentListingEntry = ContentEntry | ContentEntryFailure

export interface ReadOptions {
  signal: AbortSignal
  maxBytes: number
  offset?: number
  length?: number
}

export interface ContentReader {
  stat(ref: ContentRef, signal: AbortSignal): Promise<ContentStat>
  ls(ref: ContentRef, signal: AbortSignal): AsyncIterable<ContentListingEntry>
  read(ref: ContentRef, options: ReadOptions): AsyncIterable<Uint8Array>
}

export type GalleryProgress = Pick<
  Extract<WorkerResponse, { type: 'progress' }>,
  'phase' | 'completed' | 'total'
>

export interface OperationOptions {
  signal: AbortSignal
  limits: ResourceLimits
}

export interface DiscoveryOptions extends OperationOptions {
  onProgress?: (event: GalleryProgress) => void
}
