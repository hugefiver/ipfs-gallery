export interface BuildPolicy {
  readonly defaultGateways: readonly string[]
  readonly trustless: boolean
}

// Public HTTPS candidates; availability and raw-block CORS support require live checks.
export const BUILTIN_DEFAULT_GATEWAYS: readonly string[] = Object.freeze([
  'https://ipfs.filebase.io',
  'https://ipfs.orbitor.dev',
  'https://apac.orbitor.dev',
  'https://dget.top',
  'https://ipfs.4everland.io',
])
