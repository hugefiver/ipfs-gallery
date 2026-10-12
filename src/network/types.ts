import type { GatewayStat } from '../shared/contracts'

export interface VerifiedBlockSource {
  get(cid: string, signal: AbortSignal): Promise<Uint8Array>
  snapshot(): GatewayStat[]
  dispose(): void
}

export interface BrokerDependencies {
  fetch: typeof globalThis.fetch
  now: () => number
  random: () => number
}
