import { expectTypeOf, it } from 'vitest'
import type {
  ContentEntry,
  ContentReader,
  ContentStat,
  DiscoveryOptions,
  GalleryProgress,
  OperationOptions,
  ReadOptions,
} from '../../src/core/types'
import type { BrokerDependencies, VerifiedBlockSource } from '../../src/network/types'
import type {
  ContentRef,
  GalleryClient,
  GalleryResult,
  GatewayStat,
  ResourceLimits,
  VerifiedAsset,
  WorkerRequest,
  WorkerResponse,
} from '../../src/shared/contracts'

it('keeps the verified source and content reader interfaces independent of exporter types', () => {
  expectTypeOf<VerifiedBlockSource['get']>().toEqualTypeOf<
    (cid: string, signal: AbortSignal) => Promise<Uint8Array>
  >()
  expectTypeOf<VerifiedBlockSource['snapshot']>().toEqualTypeOf<() => GatewayStat[]>()
  expectTypeOf<BrokerDependencies['fetch']>().toEqualTypeOf<typeof globalThis.fetch>()
  expectTypeOf<ContentReader['stat']>().toEqualTypeOf<
    (ref: ContentRef, signal: AbortSignal) => Promise<ContentStat>
  >()
  expectTypeOf<ContentReader['ls']>().toEqualTypeOf<
    (ref: ContentRef, signal: AbortSignal) => AsyncIterable<ContentEntry>
  >()
  expectTypeOf<ContentReader['read']>().toEqualTypeOf<
    (ref: ContentRef, options: ReadOptions) => AsyncIterable<Uint8Array>
  >()
})

it('uses the same progress payload in core callbacks and Worker events', () => {
  expectTypeOf<OperationOptions>().toEqualTypeOf<{
    signal: AbortSignal
    limits: ResourceLimits
  }>()
  expectTypeOf<DiscoveryOptions['onProgress']>().toEqualTypeOf<
    ((event: GalleryProgress) => void) | undefined
  >()
  expectTypeOf<GalleryProgress>().toEqualTypeOf<
    Pick<Extract<WorkerResponse, { type: 'progress' }>, 'phase' | 'completed' | 'total'>
  >()
})

it('retains explicit session/request identity and operation-specific results', () => {
  expectTypeOf<GalleryClient['discover']>().toEqualTypeOf<
    (request: Extract<WorkerRequest, { type: 'discover' }>) => Promise<GalleryResult>
  >()
  expectTypeOf<GalleryClient['loadAsset']>().toEqualTypeOf<
    (request: Extract<WorkerRequest, { type: 'asset' }>) => Promise<VerifiedAsset>
  >()
  expectTypeOf<Extract<WorkerResponse, { type: 'result'; op: 'asset' }>['value']>()
    .toEqualTypeOf<VerifiedAsset>()
})
