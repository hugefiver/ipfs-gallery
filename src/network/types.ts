import type { GatewayStat } from '../shared/contracts'

export interface VerifiedBlockSource {
  /** Bytes-only reader boundary; compile-time configured-gateway exceptions stay inside network/SW admission. */
  get(cid: string, signal: AbortSignal): Promise<Uint8Array>
  snapshot(): GatewayStat[]
  dispose(): void
  /** Snapshot barrier for work already registered; only successful cleanup completes it. */
  settled?(): Promise<void>
}

export interface BrokerDependencies {
  fetch: typeof globalThis.fetch
  now: () => number
  random: () => number
  /** Keep the last consumer pending until fetch/reader cleanup really exits. */
  settleOnAbort?: boolean
}
