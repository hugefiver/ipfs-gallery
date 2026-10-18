import { peerIdFromString } from '@libp2p/peer-id'
import type { PeerId } from '@libp2p/interface'
import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'

export const peer: PeerId = peerIdFromString(CID.createV1(0x72, identity.digest(Uint8Array.from([8, 1, 18, 32, ...new Uint8Array(32).fill(1)]))).toString())
export const providerRecord = (addresses = [`/dns4/provider.ipfs.tech/tcp/443/wss/p2p/${peer}`]) => ({
  Schema: 'peer', ID: peer.toString(), Protocols: ['transport-bitswap', 'transport-ipfs-gateway-http'], Addrs: addresses,
})
