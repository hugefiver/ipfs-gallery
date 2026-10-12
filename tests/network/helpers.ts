import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import type { ResourceLimits, SessionConfig } from '../../src/shared/contracts'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

export function config(gateways = ['https://a.gateway.net', 'https://b.gateway.net'], overrides: Partial<ResourceLimits> = {}): SessionConfig {
  return { gateways, limits: { ...DEFAULT_LIMITS, ...overrides } }
}

export async function rawBlock(value: string) {
  const bytes = new TextEncoder().encode(value)
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
  return { bytes, cid }
}

export function response(bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer)
}

export function cidFromRequest(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : input.toString()).pathname.split('/').at(-1) ?? ''
}

export async function collect<T>(iterable: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable) values.push(value)
  return values
}

export async function collectBytes(iterable: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  const chunks = await collect(iterable)
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export const signal = () => new AbortController().signal
