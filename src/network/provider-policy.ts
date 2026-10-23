import type { ConnectionGater, PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { normalizeGateway } from './gateways'

export interface ProviderAddress { kind: 'wss' | 'https'; address: Multiaddr; url?: string }
export interface ProviderCandidate { id: PeerId; addresses: ProviderAddress[]; unknownProtocols?: boolean }
export type ProviderAddressPolicy = (address: Multiaddr, peer: PeerId) => ProviderAddress | undefined

/** DNS resolution belongs to the browser; this does not prevent DNS rebinding. */
export const publicProviderAddress: ProviderAddressPolicy = (address, peer) => {
  if (address.toString().length > 4096) return undefined
  const parts = address.getComponents()
  if (parts.at(-1)?.name === 'p2p') {
    try { if (!peerIdFromString(parts.at(-1)!.value!).equals(peer)) return undefined } catch { return undefined }
    parts.pop()
  }
  if (!['dns', 'dns4', 'dns6'].includes(parts[0]?.name ?? '') || parts[1]?.name !== 'tcp') return undefined
  const host = parts[0]?.value
  const port = parts[1]?.value
  if (!host || !port || !/^\d+$/.test(port) || Number(port) > 65535 || (Number(port) !== 443 && Number(port) < 1024)) return undefined
  let base: string
  try { base = normalizeGateway(`https://${host}:${port}`) } catch { return undefined }
  const protocols = parts.slice(2).map(part => part.name).join('/')
  if (protocols === 'wss' || protocols === 'tls/ws') return { kind: 'wss', address: multiaddr(`${address.toString().replace(/\/p2p\/[^/]+$/, '')}/p2p/${peer}`) }
  if (protocols === 'https' || protocols === 'tls/http') return { kind: 'https', address, url: base }
  return undefined
}

/** Admission, peerstore writes and the final transport dial use the same allow set. */
export function providerGater(allowed: Map<string, Set<string>>, policy: ProviderAddressPolicy = publicProviderAddress): ConnectionGater {
  const accepts = (peer: PeerId, address: Multiaddr) => {
    const safe = policy(address, peer)
    return safe?.kind === 'wss' && allowed.get(peer.toString())?.has(safe.address.toString()) === true
  }
  const denyAddress = (address: Multiaddr) => {
    const id = address.getComponents().find(part => part.name === 'p2p')?.value
    if (!id) return true
    try { return !accepts(peerIdFromString(id), address) } catch { return true }
  }
  return {
    denyDialPeer: peer => !allowed.has(peer.toString()),
    denyDialMultiaddr: denyAddress,
    filterMultiaddrForPeer: accepts,
    denyOutboundConnection: (peer, connection) => !accepts(peer, connection.remoteAddr),
    denyOutboundEncryptedConnection: (peer, connection) => !accepts(peer, connection.remoteAddr),
    denyOutboundUpgradedConnection: (peer, connection) => !accepts(peer, connection.remoteAddr),
    denyInboundConnection: () => true, denyInboundEncryptedConnection: () => true,
    denyInboundUpgradedConnection: () => true, denyInboundRelayReservation: () => true,
    denyInboundRelayedConnection: () => true, denyOutboundRelayedConnection: () => true,
  }
}
