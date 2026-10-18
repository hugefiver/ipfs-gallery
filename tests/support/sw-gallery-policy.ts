import { BUILTIN_DEFAULT_GATEWAYS, type BuildPolicy } from '../../src/shared/build-policy-defaults'

export interface SwGalleryTestOptions {
  expectedPolicy: BuildPolicy
  galleryBuildDir: string | undefined
  oppositeBuildDir: string | undefined
  serviceWorkerBuildDir: string | undefined
  dedicatedWorkerBuildDir: string | undefined
  alternateGatewayMedia: boolean
  httpProviderAsGateway: boolean
}

/** Browser-test expectations, not inputs to any production realm. */
export function expectedSwGalleryPolicy(trustless = true): BuildPolicy {
  const raw = process.env.SW_GALLERY_EXPECT_DEFAULTS
  const gateways: unknown = raw === undefined ? BUILTIN_DEFAULT_GATEWAYS : JSON.parse(raw)
  if (!Array.isArray(gateways) || !gateways.length || gateways.some(value => typeof value !== 'string')) {
    throw new Error('SW_GALLERY_EXPECT_DEFAULTS must be the normalized nonempty gateway JSON array used for both builds')
  }
  return { trustless, defaultGateways: gateways }
}

// These are the actual HTTP protocol boundary; importing its production parser
// in Node would evaluate constants that belong to compiled browser realms.
export const SW_GALLERY_BLOCK_PATH = '__ipfs_gallery__/blocks/'
export const SW_GALLERY_HEADERS = {
  version: 'X-Ipfs-Gallery-Version', bindingId: 'X-Ipfs-Gallery-Binding', epoch: 'X-Ipfs-Gallery-Epoch',
  capability: 'X-Ipfs-Gallery-Capability', blockRequestId: 'X-Ipfs-Gallery-Request', ticket: 'X-Ipfs-Gallery-Ticket',
} as const
