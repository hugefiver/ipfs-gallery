import { describe, expect, it } from 'vitest'
import { SourceScheduler, sourceBudget } from '../../src/network/source-scheduler'
import { DirectBudget } from '../../src/network/direct-budget'

const error = (code: 'INTEGRITY' | 'NETWORK' | 'NOT_FOUND' | 'CANCELLED' | 'TIMEOUT') => ({ code, message: '', retryable: false })
describe('binding-local adaptive candidate scheduling', () => {
  it('changes ranking with latency, load and aged exploration rather than an attempt ordinal', () => {
    let now = 0
    const scheduler = new SourceScheduler(['https://a.example', 'https://b.example'], () => now)
    const a = scheduler.choose(new Set(), 2)!
    const b = scheduler.choose(new Set([a.key]), 2)!
    scheduler.success(a, 8000, a.penalty)
    expect(scheduler.choose(new Set(), 2)).toBe(b)
    scheduler.success(b, 100, b.penalty)
    b.inFlight = 2
    expect(scheduler.choose(new Set(), 2)).toBe(a)
    b.inFlight = 0
    now = 600_000
    for (let i = 0; i < 5; i++) scheduler.success(b, 100, b.penalty)
    expect(scheduler.choose(new Set(), 2)).toBe(a)
  })
  it('keeps integrity cooldown despite an older concurrent success, then admits recovery', () => {
    let now = 0
    const scheduler = new SourceScheduler(['https://a.example'], () => now)
    const candidate = scheduler.choose(new Set(), 2)!
    const old = candidate.penalty
    scheduler.failure(candidate, error('INTEGRITY'))
    scheduler.success(candidate, 10, old)
    expect(scheduler.choose(new Set(), 2)).toBeUndefined()
    now = 60_001
    expect(scheduler.choose(new Set(), 2)).toBe(candidate)
    scheduler.success(candidate, 20, candidate.penalty)
    expect(candidate.cooldown).toBe(0)
  })
  it('does not punish a healthy peer for CID-local absence or a cancelled hedge loser', () => {
    const scheduler = new SourceScheduler(['https://a.example'])
    const candidate = scheduler.choose(new Set(), 2)!
    scheduler.failure(candidate, error('NOT_FOUND'))
    scheduler.failure(candidate, error('CANCELLED'))
    expect(candidate).toMatchObject({ failures: 0, totalFailures: 0, cooldown: 0 })
  })
  it('ranks verified slow success ahead of recently timed-out unknown latency after cooldown', () => {
    let now = 0
    const scheduler = new SourceScheduler(['https://a.example', 'https://b.example'], () => now)
    const timedOut = scheduler.choose(new Set(), 2)!
    const slow = scheduler.choose(new Set([timedOut.key]), 2)!
    scheduler.failure(timedOut, error('TIMEOUT'), 30_000)
    scheduler.success(slow, 15_000, slow.penalty)
    now = 3000
    expect(scheduler.choose(new Set(), 2)).toBe(slow)
    expect(timedOut.latency).toBeGreaterThanOrEqual(30_000)
  })
  it('rotates due health probes after a CID-local or oversized observation', () => {
    let now = 0
    const scheduler = new SourceScheduler(['https://a.example', 'https://b.example'], () => now)
    now = 20_000
    const first = scheduler.health('cid')!
    scheduler.checked(first)
    expect(scheduler.health('cid')?.key).not.toBe(first.key)
    const second = scheduler.health('cid')!
    scheduler.checked(second, 60_000)
    now = 40_000
    expect(scheduler.health('cid')).toBe(first)
  })
  it('prioritizes a cooled candidate once, then returns it to fair health rotation', () => {
    let now = 0
    const scheduler = new SourceScheduler(['https://a.example', 'https://b.example'], () => now)
    const recovering = scheduler.candidates.get('gateway:https://a.example')!
    scheduler.failure(recovering, error('NETWORK'))
    now = 20_000
    expect(scheduler.health('cid')).toBe(recovering)
    scheduler.checked(recovering)
    expect(scheduler.health('cid')?.key).toBe('gateway:https://b.example')
  })
  it('admits only one global background probe and none while foreground waits', () => {
    const stopWaiting = sourceBudget.waiting()
    expect(sourceBudget.probe()).toBeUndefined()
    stopWaiting()
    const release = sourceBudget.probe()
    expect(release).toBeTypeOf('function')
    expect(sourceBudget.probe()).toBeUndefined()
    expect(sourceBudget.usage()).toMatchObject({ attempts: 1, bytes: 512 * 1024, background: 1 })
    release!()
    expect(sourceBudget.usage()).toMatchObject({ attempts: 0, bytes: 0, background: 0 })
  })
  it('reserves only three shared idle connections inside the six physical connection slots', () => {
    const budget = new DirectBudget()
    const idle = Array.from({ length: 3 }, () => ({ physical: budget.acquire('connection'), lease: budget.retainIdle()! }))
    expect(budget.retainIdle()).toBeUndefined()
    const foreground = Array.from({ length: 3 }, () => budget.acquire('connection'))
    expect(() => budget.acquire('connection')).toThrow()
    idle[0]!.lease()
    expect(() => budget.acquire('connection')).toThrow()
    for (const retained of idle) { retained.physical(); retained.lease() }
    for (const release of foreground) release()
    expect(budget.snapshot().connections).toBe(0)
  })
})
