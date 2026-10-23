import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { CID } from 'multiformats/cid'
import { fetchBounded } from './direct-http'
import { DirectCleanupError } from './direct-errors'
import { networkError } from './errors'
import { publicProviderAddress, type ProviderAddressPolicy, type ProviderCandidate } from './provider-policy'

export const PROVIDER_LIMITS = Object.freeze({ responseBytes: 256 * 1024, recordBytes: 16 * 1024, candidates: 16, scanned: 256, addresses: 4, addressLength: 4096 })
export const DELEGATED_ROUTER = 'https://delegated-ipfs.dev'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseProvider(value: unknown, policy: ProviderAddressPolicy = publicProviderAddress): ProviderCandidate | undefined {
  if (!record(value) || value.Schema !== 'peer' || typeof value.ID !== 'string' || value.ID.length > 256 ||
    !Array.isArray(value.Addrs)) return undefined
  const protocols = value.Protocols
  if (protocols !== undefined && (!Array.isArray(protocols) || protocols.length > 16 ||
    protocols.some(protocol => typeof protocol !== 'string' || protocol.length > 63))) return undefined
  const unknownProtocols = protocols === undefined || protocols.length === 0
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROVIDER_LIMITS.recordBytes) return undefined
  try {
    const id = peerIdFromString(value.ID)
    const addresses: ProviderCandidate['addresses'] = []
    for (const input of value.Addrs) {
      if (typeof input !== 'string' || input.length > PROVIDER_LIMITS.addressLength) continue
      let safe
      try { safe = policy(multiaddr(input), id) } catch { continue }
      if (!safe || (!unknownProtocols && ((safe.kind === 'wss' && !protocols.includes('transport-bitswap')) ||
        (safe.kind === 'https' && !protocols.includes('transport-ipfs-gateway-http'))))) continue
      if (!addresses.some(address => address.address.equals(safe.address))) addresses.push(safe)
      if (addresses.length === PROVIDER_LIMITS.addresses) break
    }
    return addresses.length ? { id, addresses, ...(unknownProtocols ? { unknownProtocols: true } : {}) } : undefined
  } catch { return undefined }
}

export interface ProviderRoutingOptions { fetch: typeof globalThis.fetch; endpoint: string; policy: ProviderAddressPolicy }

/** A read-only Delegated Routing V1 surface. No peer lookup or record writes. */
export async function findProviders(cid: CID, signal: AbortSignal, options: ProviderRoutingOptions): Promise<ProviderCandidate[]> {
  const result: ProviderCandidate[] = []
  let count = 0
  const acceptRecord = (value: unknown) => {
    count++
    const provider = parseProvider(value, options.policy)
    if (provider) {
      const existing = result.find(candidate => candidate.id.equals(provider.id))
      if (!existing) result.push(provider)
      else {
        for (const address of provider.addresses) {
          if (existing.addresses.length === PROVIDER_LIMITS.addresses) break
          if (!existing.addresses.some(value => value.address.equals(address.address))) existing.addresses.push(address)
        }
        if (provider.unknownProtocols) existing.unknownProtocols = true
      }
    }
    return count < PROVIDER_LIMITS.scanned && result.length < PROVIDER_LIMITS.candidates
  }
  let pending = ''
  let json = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parseLine = (line: string) => {
    if (!line.trim()) return true
    if (new TextEncoder().encode(line).byteLength > PROVIDER_LIMITS.recordBytes) throw networkError('NETWORK', 'Provider 记录过大。')
    return acceptRecord(JSON.parse(line))
  }
  try {
    await fetchBounded(options.fetch, `${options.endpoint}/routing/v1/providers/${cid.toV1()}`, 'application/json, application/x-ndjson', PROVIDER_LIMITS.responseBytes, signal, (chunk, response) => {
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (type !== 'application/json' && type !== 'application/x-ndjson') throw networkError('NETWORK', 'Provider 响应类型无效。')
      json = type === 'application/json'
      pending += decoder.decode(chunk, { stream: true })
      if (json) return true
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!parseLine(line)) { pending = ''; return false }
      }
      if (new TextEncoder().encode(pending).byteLength > PROVIDER_LIMITS.recordBytes) throw networkError('NETWORK', 'Provider 记录过大。')
      return true
    })
    pending += decoder.decode()
    if (pending.trim()) {
      const value: unknown = JSON.parse(pending)
      if (json && record(value) && Array.isArray(value.Providers)) {
        for (const provider of value.Providers) if (!acceptRecord(provider)) break
      } else if (!json && count < PROVIDER_LIMITS.scanned && result.length < PROVIDER_LIMITS.candidates) parseLine(pending)
      else throw networkError('NETWORK', 'Provider 响应结构无效。')
    }
    return result
  } catch (error) {
    if (error instanceof DirectCleanupError) throw error
    if (signal.aborted) throw signal.reason
    if (error instanceof SyntaxError || error instanceof TypeError) throw networkError('NETWORK', 'Provider 响应格式无效。')
    throw error
  }
}
