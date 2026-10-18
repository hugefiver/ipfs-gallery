export interface BuildPolicy {
  readonly defaultGateways: readonly string[]
  readonly trustless: boolean
}

// Public HTTPS candidates; availability and raw-block CORS support require live checks.
export const BUILTIN_DEFAULT_GATEWAYS: readonly string[] = Object.freeze([
  'https://ipfs.4everland.io',
  'https://gateway.pinata.cloud',
  'https://trustless-gateway.link',
])
