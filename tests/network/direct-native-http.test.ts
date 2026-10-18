import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fetchBounded } from '../../src/network/direct-http'
import { createIpfsBlockSourceWithOptions } from '../../src/network/ipfs-source'
import { publicProviderAddress } from '../../src/network/provider-policy'
import { config, deferred, rawBlock } from './helpers'
import { providerRecord } from './provider-helpers'

interface Evidence { pending: ReturnType<typeof deferred<void>>; readError?: unknown; cancelError?: unknown }
function observeBody(response: Response, evidence: Evidence): Response {
  const body = response.body!
  const getReader = body.getReader.bind(body)
  body.getReader = (() => {
    const reader = getReader()
    const read = reader.read.bind(reader)
    const cancel = reader.cancel.bind(reader)
    let reads = 0
    reader.read = () => {
      if (++reads === 2) evidence.pending.resolve()
      return read().catch((error: unknown) => { evidence.readError = error; throw error })
    }
    reader.cancel = reason => cancel(reason).catch((error: unknown) => { evidence.cancelError = error; throw error })
    return reader
  }) as typeof body.getReader
  return response
}

async function setup(phase: 'provider' | 'gateway', settings: { holdB?: boolean; gatewayTimeoutMs?: number; delayedResponse?: boolean } = {}) {
  const a = await rawBlock('native A body')
  const b = await rawBlock('native B body')
  const c = await rawBlock('native fresh load')
  const blocks = new Map([a, b, c].map(block => [block.cid, block.bytes]))
  const held = new Map<string, ServerResponse>()
  const evidence = new Map<string, Evidence>([a, b].map(block => [block.cid, { pending: deferred<void>() }]))
  const ready = deferred<void>()
  const deliver = deferred<void>()
  const server = createServer((request, response) => {
    const [, mode, cid] = request.url!.split('/')
    const bytes = blocks.get(cid!)!
    response.setHeader('content-type', 'application/vnd.ipld.raw')
    if (mode === 'hold') {
      held.set(cid!, response)
      response.write(bytes.subarray(0, 1))
    } else response.end(bytes)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const source = createIpfsBlockSourceWithOptions(config(undefined, { gatewayTimeoutMs: settings.gatewayTimeoutMs ?? 10000 }), {
    router: 'https://delegated-ipfs.dev', policy: publicProviderAddress,
    fetch: async (input, init) => {
      const url = new URL(input.toString())
      if (url.hostname === 'delegated-ipfs.dev') return new Response(JSON.stringify({ Providers: phase === 'provider'
        ? [providerRecord(['/dns4/provider.ipfs.tech/tcp/443/https'])] : [] }), { headers: { 'content-type': 'application/json' } })
      const cid = url.pathname.split('/').at(-1)!
      const hold = (settings.holdB && cid === b.cid) || (cid === a.cid &&
        (phase === 'provider' ? url.hostname === 'provider.ipfs.tech' : url.hostname === 'a.gateway.net'))
      const response = await fetch(`${base}/${hold ? 'hold' : 'good'}/${cid}`, init)
      if (!hold) return response
      observeBody(response, evidence.get(cid)!)
      if (settings.delayedResponse && cid === a.cid) { ready.resolve(); await deliver.promise }
      return response
    },
  })
  const finish = (cid: string) => held.get(cid)?.end(blocks.get(cid)!.subarray(1))
  return { source, a, b, c, base, evidence, held, ready, deliver, finish, async close() {
    deliver.resolve()
    source.dispose()
    await source.settled().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

describe('native HTTP terminal body errors', () => {
  it('preserves the native AbortError replay from read and cancel after the first chunk', async () => {
    const fixture = await setup('provider')
    const controller = new AbortController()
    const evidence: Evidence = { pending: deferred<void>() }
    const read = fetchBounded(async (input, init) => observeBody(await fetch(input, init), evidence),
      `${fixture.base}/hold/${fixture.a.cid}`, 'application/vnd.ipld.raw', 1024, controller.signal)
    const outcome = read.catch((error: unknown) => error)
    try {
      await evidence.pending.promise
      controller.abort()
      const error = await outcome
      expect(evidence.readError).toMatchObject({ name: 'AbortError' })
      expect(evidence.cancelError).toBe(evidence.readError)
      expect(error).toBe(evidence.readError)
    } finally { await fixture.close(); await read.catch(() => {}) }
  })

  it.each(['provider', 'gateway'] as const)('does not quarantine %s abort or an independent pending B', async phase => {
    const fixture = await setup(phase, { holdB: true })
    const controller = new AbortController()
    const readA = fixture.source.get(fixture.a.cid, controller.signal)
    const outcomeA = readA.catch((error: unknown) => error)
    let readB: Promise<Uint8Array> | undefined
    try {
      await fixture.evidence.get(fixture.a.cid)!.pending.promise
      readB = fixture.source.get(fixture.b.cid, new AbortController().signal)
      void readB.catch(() => {})
      await fixture.evidence.get(fixture.b.cid)!.pending.promise
      controller.abort()
      const error = await outcomeA
      const evidence = fixture.evidence.get(fixture.a.cid)!
      expect(evidence.readError).toBeDefined()
      expect(evidence.cancelError).toBe(evidence.readError)
      expect(error).toMatchObject({ error: { code: 'CANCELLED' } })
      fixture.finish(fixture.b.cid)
      expect(await readB).toEqual(fixture.b.bytes)
      await fixture.source.settled()
      expect(await fixture.source.get(fixture.c.cid, new AbortController().signal)).toEqual(fixture.c.bytes)
    } finally { await fixture.close(); await Promise.allSettled([readA, readB]) }
  })

  it('uses gateway fallback after the direct deadline aborts a pending native body', async () => {
    const fixture = await setup('provider')
    const readA = fixture.source.get(fixture.a.cid, new AbortController().signal)
    void readA.catch(() => {})
    try {
      await fixture.evidence.get(fixture.a.cid)!.pending.promise
      expect(await readA).toEqual(fixture.a.bytes)
      const evidence = fixture.evidence.get(fixture.a.cid)!
      expect(evidence.readError).toBeDefined()
      expect(evidence.cancelError).toBe(evidence.readError)
      expect(fixture.source.snapshot().reduce((total, gateway) => total + gateway.successes, 0)).toBe(1)
      await fixture.source.settled()
      expect(await fixture.source.get(fixture.c.cid, new AbortController().signal)).toEqual(fixture.c.bytes)
    } finally { await fixture.close(); await readA.catch(() => {}) }
  }, 15000)

  it('preserves a strict gateway timeout and tries the remaining gateway', async () => {
    const fixture = await setup('gateway', { gatewayTimeoutMs: 100 })
    const readA = fixture.source.get(fixture.a.cid, new AbortController().signal)
    void readA.catch(() => {})
    try {
      await fixture.evidence.get(fixture.a.cid)!.pending.promise
      expect(await readA).toEqual(fixture.a.bytes)
      expect(fixture.evidence.get(fixture.a.cid)!.readError).toBeDefined()
      expect(fixture.evidence.get(fixture.a.cid)!.cancelError).toBe(fixture.evidence.get(fixture.a.cid)!.readError)
      expect(fixture.source.snapshot()).toMatchObject([{ failures: 1 }, { successes: 1 }])
      await fixture.source.settled()
      expect(await fixture.source.get(fixture.c.cid, new AbortController().signal)).toEqual(fixture.c.bytes)
    } finally { await fixture.close(); await readA.catch(() => {}) }
  })

  it('treats an errored native stream as a candidate failure, not cancellation failure', async () => {
    const fixture = await setup('provider')
    const readA = fixture.source.get(fixture.a.cid, new AbortController().signal)
    void readA.catch(() => {})
    try {
      await fixture.evidence.get(fixture.a.cid)!.pending.promise
      fixture.held.get(fixture.a.cid)!.destroy()
      expect(await readA).toEqual(fixture.a.bytes)
      const evidence = fixture.evidence.get(fixture.a.cid)!
      expect(evidence.readError).toBeDefined()
      expect(evidence.cancelError).toBe(evidence.readError)
      await fixture.source.settled()
    } finally { await fixture.close(); await readA.catch(() => {}) }
  })

  it('handles terminal error replay while discarding a late already-aborted response body', async () => {
    const fixture = await setup('provider', { delayedResponse: true })
    const controller = new AbortController()
    const readA = fixture.source.get(fixture.a.cid, controller.signal)
    const outcome = readA.catch((error: unknown) => error)
    try {
      await fixture.ready.promise
      controller.abort()
      fixture.deliver.resolve()
      expect(await outcome).toMatchObject({ error: { code: 'CANCELLED' } })
      expect(fixture.evidence.get(fixture.a.cid)!.cancelError).toBeDefined()
      await fixture.source.settled()
      expect(await fixture.source.get(fixture.c.cid, new AbortController().signal)).toEqual(fixture.c.bytes)
    } finally { await fixture.close(); await readA.catch(() => {}) }
  })
})
