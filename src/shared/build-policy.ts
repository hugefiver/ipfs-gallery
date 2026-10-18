import type { BuildPolicy } from './build-policy-defaults'

export type { BuildPolicy } from './build-policy-defaults'

export const BUILD_POLICY: BuildPolicy = Object.freeze({
  defaultGateways: Object.freeze([...__IPFS_GALLERY_DEFAULT_GATEWAYS__]),
  trustless: __IPFS_GALLERY_TRUSTLESS__,
})

/** Realm identities must exactly match the local compilation, never negotiate policy. */
export function matchesBuildPolicy(value: unknown): value is BuildPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'defaultGateways') || !Object.hasOwn(value, 'trustless')) return false
  const policy = value as Record<string, unknown>
  const gateways = policy.defaultGateways
  return policy.trustless === BUILD_POLICY.trustless &&
    Array.isArray(gateways) &&
    gateways.length === BUILD_POLICY.defaultGateways.length &&
    BUILD_POLICY.defaultGateways.every((gateway, index) => gateways[index] === gateway)
}
