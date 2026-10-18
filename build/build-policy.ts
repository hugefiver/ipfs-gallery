import { BUILTIN_DEFAULT_GATEWAYS, type BuildPolicy } from '../src/shared/build-policy-defaults'
import { normalizeGateway } from '../src/shared/gateway-normalizer'
import { DEFAULT_LIMITS } from '../src/shared/limits'

interface BuildEnvironment {
  readonly IPFS_GALLERY_GATEWAYS?: string
  readonly IPFS_GALLERY_TRUSTLESS?: string
}

const MAX_GATEWAYS_JSON_BYTES = 40 * 1024
const MAX_GATEWAY_LENGTH = 4096

function parseGateways(input: string | undefined): readonly string[] {
  if (input === undefined) return BUILTIN_DEFAULT_GATEWAYS
  const invalid = (detail: string) => new Error(`IPFS_GALLERY_GATEWAYS: ${detail}`)
  if (input.length > MAX_GATEWAYS_JSON_BYTES || new TextEncoder().encode(input).byteLength > MAX_GATEWAYS_JSON_BYTES) {
    throw invalid('JSON exceeds 40 KiB')
  }
  let values: unknown
  try { values = JSON.parse(input) } catch { throw invalid('expected a non-empty JSON string array') }
  if (!Array.isArray(values) || values.length === 0 || values.length > DEFAULT_LIMITS.maxGateways) {
    throw invalid(`expected between 1 and ${DEFAULT_LIMITS.maxGateways} entries`)
  }
  const gateways = values.map((value: unknown, index) => {
    if (typeof value !== 'string' || value.length > MAX_GATEWAY_LENGTH) throw invalid(`entry ${index + 1} must be a string of at most 4096 characters`)
    let gateway: string
    try { gateway = normalizeGateway(value) } catch { throw invalid(`entry ${index + 1} must be a public HTTPS gateway`) }
    if (gateway.length > MAX_GATEWAY_LENGTH) throw invalid(`entry ${index + 1} exceeds 4096 normalized characters`)
    return gateway
  })
  return Object.freeze([...new Set(gateways)])
}

/** The caller supplies only the two explicit Node build inputs. */
export function parseBuildPolicy(environment: BuildEnvironment): BuildPolicy {
  const input = environment.IPFS_GALLERY_TRUSTLESS
  if (input !== undefined && input !== 'true' && input !== 'false') {
    throw new Error('IPFS_GALLERY_TRUSTLESS: expected exactly true or false')
  }
  return Object.freeze({ defaultGateways: parseGateways(environment.IPFS_GALLERY_GATEWAYS), trustless: input !== 'false' })
}

export function buildPolicyDefines(policy: BuildPolicy): Record<string, string> {
  return {
    __IPFS_GALLERY_DEFAULT_GATEWAYS__: JSON.stringify(policy.defaultGateways),
    __IPFS_GALLERY_TRUSTLESS__: JSON.stringify(policy.trustless),
  }
}
