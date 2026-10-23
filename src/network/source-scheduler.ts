import type { GalleryError } from '../shared/contracts'
import type { ProviderAddress, ProviderCandidate } from './provider-policy'

export const MAINTENANCE_BLOCK_BYTES = 256 * 1024

export interface Candidate {
  key: string
  gateway?: string
  provider?: ProviderCandidate
  address?: ProviderAddress
  latency: number
  deviation: number
  successes: number
  failures: number
  totalSuccesses: number
  totalFailures: number
  inFlight: number
  cooldown: number
  penalty: number
  sampled: number
  healthDue: number
  healthChecked: number
  decayed: number
  cids: Map<string, number>
  expires: number
}

/** Binding-local, bounded observations. No CID or provider statistics persist. */
export class SourceScheduler {
  readonly candidates = new Map<string, Candidate>()
  private healthSequence = 0
  constructor(gateways: string[], private readonly now = Date.now) {
    gateways.forEach((gateway, index) => this.add(`gateway:${gateway}`, 1200 * (1 + .03 * index), { gateway }))
  }
  private add(key: string, latency: number, fields: Pick<Candidate, 'gateway' | 'provider' | 'address'>): void {
    if (this.candidates.has(key)) return
    if (this.candidates.size >= 72) {
      const oldest = [...this.candidates.values()].filter(value => !value.gateway && !value.inFlight)
        .sort((a, b) => a.sampled - b.sampled)[0]
      if (!oldest) return
      this.candidates.delete(oldest.key)
    }
    const now = this.now()
    this.candidates.set(key, { key, ...fields, latency, deviation: latency / 2, successes: 0, failures: 0,
      inFlight: 0, totalSuccesses: 0, totalFailures: 0, cooldown: 0, penalty: 0, sampled: now,
      healthDue: now + 20_000, healthChecked: 0, decayed: now,
      cids: new Map(), expires: fields.gateway ? Infinity : now + 300_000 })
  }
  providers(providers: ProviderCandidate[], cid: string): boolean {
    const previous = new Set([...this.candidates.values()].filter(value => value.cids.has(cid)).map(value => value.key))
    const current = new Set<string>()
    for (const provider of providers) for (const address of provider.addresses) {
      const key = `${provider.id}:${address.kind}:${address.address}`
      current.add(key)
      this.add(key, address.kind === 'https' ? 1000 : 1200, { provider, address })
      const candidate = this.candidates.get(key)
      if (candidate) {
        candidate.provider = provider
        this.confirm(candidate, cid)
      }
    }
    for (const key of previous) if (!current.has(key)) this.candidates.get(key)?.cids.delete(cid)
    this.prune()
    return previous.size !== current.size || [...current].some(key => !previous.has(key))
  }
  confirm(candidate: Candidate, cid: string): void {
    candidate.cids.delete(cid)
    candidate.cids.set(cid, this.now() + 300_000)
    if (candidate.cids.size > 32) candidate.cids.delete(candidate.cids.keys().next().value!)
    if (!candidate.gateway) candidate.expires = this.now() + 300_000
  }
  prune(): void {
    for (const candidate of this.candidates.values()) {
      for (const [cid, expires] of candidate.cids) if (expires <= this.now()) candidate.cids.delete(cid)
      if (!candidate.gateway && !candidate.inFlight && (candidate.expires <= this.now() || !candidate.cids.size)) this.candidates.delete(candidate.key)
    }
  }
  private cost(candidate: Candidate, cid?: string): number {
    const now = this.now()
    const decay = Math.pow(.5, (now - candidate.decayed) / 120_000)
    candidate.successes *= decay; candidate.failures *= decay; candidate.decayed = now
    const probability = (1 + candidate.successes) / (2 + candidate.successes + candidate.failures)
    const stale = 1 + Math.max(0, now - candidate.sampled) / 30_000
    return (candidate.latency + candidate.deviation) * (1 + candidate.inFlight) /
      probability * (candidate.provider?.unknownProtocols ? 1.5 : 1) *
      (candidate.provider && cid && !candidate.cids.has(cid) ? 1.75 : 1) / stale
  }
  choose(excluded: Set<string>, concurrency: number, cid?: string): Candidate | undefined {
    this.prune()
    const eligible = [...this.candidates.values()].filter(candidate => !excluded.has(candidate.key) &&
      candidate.cooldown <= this.now() && candidate.inFlight < concurrency)
    return eligible.sort((a, b) => this.cost(a, cid) - this.cost(b, cid))[0]
  }
  private healthInterval(candidate: Candidate): number {
    return Math.min(300_000, 20_000 * 2 ** Math.min(3,
      Math.max(0, candidate.totalSuccesses - candidate.totalFailures)))
  }
  health(cid: string): Candidate | undefined {
    this.prune()
    const now = this.now()
    const due = [...this.candidates.values()].filter(candidate => !candidate.inFlight &&
      (candidate.gateway !== undefined || candidate.address?.kind === 'https') &&
      (candidate.gateway !== undefined || candidate.cids.has(cid)) && candidate.cooldown <= now
      && candidate.healthDue <= now)
    return due.sort((a, b) => Number(!a.cooldown) - Number(!b.cooldown)
      || a.healthChecked - b.healthChecked || a.healthDue - b.healthDue)[0]
  }
  checked(candidate: Candidate, delay = this.healthInterval(candidate)): void {
    const now = this.now()
    candidate.healthChecked = ++this.healthSequence
    candidate.healthDue = now + delay
    if (candidate.cooldown <= now) candidate.cooldown = 0
  }
  soft(candidate: Candidate): number { return Math.max(250, Math.min(10_000, candidate.latency + 2 * candidate.deviation)) }
  success(candidate: Candidate, elapsed: number, penalty: number): void {
    const sample = Math.max(1, elapsed)
    candidate.deviation = .8 * candidate.deviation + .2 * Math.abs(sample - candidate.latency)
    candidate.latency = .8 * candidate.latency + .2 * sample
    candidate.successes++; candidate.totalSuccesses++; candidate.sampled = this.now()
    candidate.healthDue = this.now() + this.healthInterval(candidate)
    if (candidate.penalty === penalty) candidate.cooldown = 0
  }
  failure(candidate: Candidate, error: GalleryError, elapsed?: number): void {
    if (['CANCELLED', 'NOT_FOUND', 'LIMIT'].includes(error.code)) return
    if (error.code === 'TIMEOUT' && elapsed !== undefined) {
      candidate.deviation = Math.max(candidate.deviation, .2 * Math.abs(elapsed - candidate.latency))
      candidate.latency = Math.max(candidate.latency, elapsed)
    }
    candidate.failures++; candidate.totalFailures++; candidate.penalty++; candidate.sampled = this.now()
    const duration = error.code === 'INTEGRITY' ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(candidate.failures, 5))
    candidate.cooldown = Math.max(candidate.cooldown, this.now() + duration)
    candidate.healthDue = Math.max(candidate.healthDue, candidate.cooldown)
  }
}

/** Actual attempts, including hedges, share six slots and a bounded byte reservation across bindings. */
class SourceBudget {
  private attempts = 0
  private bytes = 0
  private routing = 0
  private background = 0
  private primary = 0
  private probeTokens = MAINTENANCE_BLOCK_BYTES * 4
  private probeRefillAt = Date.now()
  private readonly listeners = new Set<() => void>()
  subscribe(wake: () => void): () => void { this.listeners.add(wake); return () => { this.listeners.delete(wake) } }
  private notify(): void { for (const wake of this.listeners) wake() }
  waiting(): () => void {
    this.primary++
    return () => { this.primary--; this.notify() }
  }
  attempt(bytes: number, hedge: boolean): (() => void) | undefined {
    if (this.attempts >= 6 || this.bytes + bytes > 64 * 1024 * 1024 || (hedge && this.primary > 0)) return
    this.attempts++; this.bytes += bytes
    return () => { this.attempts--; this.bytes -= bytes; this.notify() }
  }
  route(background: boolean): (() => void) | undefined {
    const bytes = 512 * 1024
    if (this.routing >= 2 || this.bytes + bytes > 64 * 1024 * 1024 ||
      (background && (this.background || this.primary || this.attempts >= 3))) return
    this.routing++; this.bytes += bytes; if (background) this.background++
    return () => { this.routing--; this.bytes -= bytes; if (background) this.background--; this.notify() }
  }
  probe(): (() => void) | undefined {
    const now = Date.now()
    if (now < this.probeRefillAt) {
      this.probeRefillAt = now
      this.probeTokens = MAINTENANCE_BLOCK_BYTES * 4
    } else {
      this.probeTokens = Math.min(MAINTENANCE_BLOCK_BYTES * 4,
        this.probeTokens + (now - this.probeRefillAt) * MAINTENANCE_BLOCK_BYTES / 20_000)
      this.probeRefillAt = now
    }
    const bytes = MAINTENANCE_BLOCK_BYTES * 2
    if (this.background || this.primary || this.attempts >= 3 || this.probeTokens < MAINTENANCE_BLOCK_BYTES
      || this.bytes + bytes > 64 * 1024 * 1024) return
    this.probeTokens -= MAINTENANCE_BLOCK_BYTES
    this.background++; this.attempts++; this.bytes += bytes
    return () => { this.background--; this.attempts--; this.bytes -= bytes; this.notify() }
  }
  usage() { return { attempts: this.attempts, bytes: this.bytes, routing: this.routing, background: this.background } }
}
export const sourceBudget = new SourceBudget()
