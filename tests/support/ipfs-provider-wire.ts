import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export interface ProviderWireMessage {
  wantlist?: { full?: boolean; entries: Array<{ cid: Uint8Array; priority?: number; cancel?: boolean; wantType?: string | number }> }
  blocks: Array<{ prefix: Uint8Array; data: Uint8Array }>
  blockPresences?: Array<{ cid: Uint8Array; type: string }>
  pendingBytes?: number
}

/** Official installed codecs used only by fixture instrumentation/probes. */
export async function loadIpfsProviderWire() {
  const entry = import.meta.resolve('@helia/bitswap')
  const requireBitswap = createRequire(entry)
  const { BitswapMessage } = await import(new URL('./pb/message.js', entry).href) as {
    BitswapMessage: {
      decode(data: Uint8Array): ProviderWireMessage
      encode(data: ProviderWireMessage): Uint8Array
    }
  }
  const framing = await import(pathToFileURL(requireBitswap.resolve('it-length-prefixed')).href) as {
    decode(input: Uint8Array[], options: { maxDataLength: number }): Iterable<{ subarray(): Uint8Array; byteLength: number }>
    encode: { single(data: Uint8Array): Uint8Array }
  }
  return { BitswapMessage, framing }
}
