import type { BrowserContext, Request, Route } from '@playwright/test'
import type { ContentRef } from '../../src/shared/contracts'
import { contentUri } from '../fixtures/unixfs'
import type { TrustlessGateway } from '../support/trustless-gateway'

export const FIXTURE_GATEWAYS = {
  slow: 'https://slow.gallery-fixture.net',
  fast: 'https://fast.gallery-fixture.net',
} as const

export function sourceUrl(
  source: 'unixfs' | 'meta' | 'cid',
  refs: ContentRef | ContentRef[],
  view: Record<string, string | string[]> = {},
  gateways: string[] = [FIXTURE_GATEWAYS.slow, FIXTURE_GATEWAYS.fast],
): string {
  const query = new URLSearchParams()
  for (const ref of Array.isArray(refs) ? refs : [refs]) query.append(source, contentUri(ref))
  for (const gateway of gateways) query.append('gateway', gateway)
  for (const [key, values] of Object.entries(view)) {
    for (const value of Array.isArray(values) ? values : [values]) query.append(key, value)
  }
  return `/?${query}`
}

/** Replaces HTTPS transport only; the application receives original raw blocks. */
export async function routeFixtureGateways(
  context: BrowserContext,
  gateways: { slow: TrustlessGateway; fast: TrustlessGateway },
  additionalOrigins: readonly string[] = [],
) {
  const routes: { url: string; method: string; resourceType: string; headers: Record<string, string> }[] = []
  const errors: unknown[] = []
  const pending = new Map<Request, AbortController>()
  const work = new Set<Promise<void>>()
  let closing = false
  const allowedOrigins = new Set<string>([...Object.values(FIXTURE_GATEWAYS), ...additionalOrigins])
  const pattern = (url: URL) => allowedOrigins.has(url.origin) && url.pathname.startsWith('/ipfs/')
  const requestFailed = (request: Request) => pending.get(request)?.abort()
  context.on('requestfailed', requestFailed)
  const handler = (route: Route): Promise<void> => {
    const task = (async () => {
      const request = route.request()
      const url = new URL(request.url())
      const gateway = url.origin === FIXTURE_GATEWAYS.slow ? gateways.slow : gateways.fast
      const controller = new AbortController()
      pending.set(request, controller)
      try {
        const headers = await request.allHeaders()
        routes.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), headers: { ...headers } })
        delete headers.host
        delete headers.connection
        delete headers['content-length']
        const response = await fetch(`${gateway.origin}${url.pathname}${url.search}`, {
          method: request.method(), headers, redirect: 'manual',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        })
        const body = Buffer.from(await response.arrayBuffer())
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body })
      } catch (error) {
        if (!closing && !controller.signal.aborted) {
          // A source switch can destroy the original request while fulfillment is in flight.
          if (!/Target closed|Target page, context or browser has been closed|Invalid InterceptionId/i.test(String(error))) errors.push(error)
        }
        await route.abort('failed').catch(() => undefined)
      } finally {
        pending.delete(request)
      }
    })()
    work.add(task)
    void task.then(() => work.delete(task), () => work.delete(task))
    return task
  }
  await context.route(pattern, handler)
  return {
    routes,
    errors,
    close: async () => {
      closing = true
      context.off('requestfailed', requestFailed)
      for (const controller of pending.values()) controller.abort()
      await context.unroute(pattern, handler)
      await Promise.allSettled(work)
    },
  }
}
