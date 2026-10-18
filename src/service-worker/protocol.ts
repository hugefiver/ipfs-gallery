import type { ErrorCode, GalleryError, GatewayStat, SessionConfig } from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { matchesBuildPolicy } from '../shared/build-policy'
import { normalizeGateway } from '../network/gateways'
import { parseBlockCid } from '../network/verify'
import { invalidInput, parseSessionConfig, record, validIdentity } from '../worker/protocol'

export const VERSION = 1
export const SCRIPT = 'ipfs-service-worker.js'
export const BLOCK_PATH = '__ipfs_gallery__/blocks/'
export const BOUNDS = Object.freeze({ bindings: 8, flights: 6, consumers: 24, perBinding: 6,
  owners: 8, management: 4,
  responses: 6, responseBytes: 24 * 1024 * 1024, workingBytes: 64 * 1024 * 1024,
  cachePerBinding: 2 * 1024 * 1024, ticketMs: 5000, bodyMs: 10_000, idleMs: 60_000,
  handshakeMs: 10_000, controls: 16 })
export const HEADERS = { version: 'X-Ipfs-Gallery-Version', bindingId: 'X-Ipfs-Gallery-Binding',
  epoch: 'X-Ipfs-Gallery-Epoch', capability: 'X-Ipfs-Gallery-Capability',
  blockRequestId: 'X-Ipfs-Gallery-Request', ticket: 'X-Ipfs-Gallery-Ticket' } as const

export function domain(code: ErrorCode, message = 'IPFS Service Worker 请求失败。'): GalleryDomainError {
  return new GalleryDomainError({ code, message, retryable: ['NETWORK', 'TIMEOUT', 'INTERNAL'].includes(code) })
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) invalidInput()
}
/** Compare fixed realm builds, never negotiate a request-controlled trust mode. */
export function matchingBuildPolicy(value: unknown): void {
  if (!matchesBuildPolicy(value)) throw domain('INVALID_INPUT')
}
export function noPorts(event: MessageEvent): void {
  if (event.ports.length === 0) return
  for (const port of event.ports) port.close()
  throw domain('INVALID_INPUT')
}
export function sessionConfig(value: unknown): SessionConfig {
  return parseSessionConfig(value, { normalizeGateway, normalizeContentRef: () => invalidInput() })
}
export function canonicalCid(value: unknown, max: number): string {
  if (typeof value !== 'string') invalidInput()
  const cid = parseBlockCid(value, max)
  if (cid.multihash.code === 0 || cid.toV1().toString() !== value) invalidInput()
  return value
}
export function galleryError(value: unknown): GalleryError {
  exact(value, ['code', 'message', 'retryable'])
  const codes: ErrorCode[] = ['INVALID_INPUT', 'INVALID_METADATA', 'UNSUPPORTED', 'NOT_FOUND', 'NETWORK',
    'INTEGRITY', 'TIMEOUT', 'LIMIT', 'CANCELLED', 'INTERNAL']
  if (!codes.includes(value.code as ErrorCode) || typeof value.message !== 'string'
    || value.message.length > 1024 || typeof value.retryable !== 'boolean') invalidInput()
  return value as unknown as GalleryError
}
export function stats(value: unknown, config: SessionConfig): GatewayStat[] {
  if (!Array.isArray(value) || value.length > config.gateways.length) invalidInput()
  return value.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['url', 'state', 'ewmaMs', 'inFlight',
      'successes', 'failures', 'cooldownUntil'].includes(key)) || !config.gateways.includes(item.url as string)
      || !['healthy', 'cooldown', 'probing'].includes(item.state as string)) invalidInput()
    for (const key of ['inFlight', 'successes', 'failures']) {
      if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0) invalidInput()
    }
    for (const key of ['ewmaMs', 'cooldownUntil']) {
      if (item[key] !== undefined && (typeof item[key] !== 'number'
        || !Number.isFinite(item[key]) || item[key] < 0)) invalidInput()
    }
    return { ...item } as unknown as GatewayStat
  })
}
export interface BindingIdentity { sessionId: string; bindingId: string; epoch: string }
export interface OwnerIdentity { ownerId: string; attempt: number; secret: string }
export function openAdmission(value: unknown, expected: { boot: unknown; ownerId: unknown; attempt: unknown }): void {
  exact(value, ['boot', 'ownerId', 'attempt', 'state'])
  if (value.boot !== expected.boot || value.ownerId !== expected.ownerId || value.attempt !== expected.attempt
    || value.state !== 'settled') throw domain('INVALID_INPUT')
}
export function ownerIdentity(value: Record<string, unknown>): OwnerIdentity {
  if (typeof value.ownerId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.ownerId)
    || typeof value.secret !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.secret)
    || !Number.isSafeInteger(value.attempt) || (value.attempt as number) <= 0) throw domain('INVALID_INPUT')
  return { ownerId: value.ownerId, attempt: value.attempt as number, secret: value.secret }
}
export interface Open extends Record<string, unknown>, OwnerIdentity { v: 1; type: 'open'; sessionId: string; config: SessionConfig; boot: string }
export function parseOpen(value: unknown): Open {
  exact(value, ['v', 'type', 'sessionId', 'config', 'ownerId', 'attempt', 'secret', 'boot', 'policy'])
  if (value.v !== VERSION || value.type !== 'open' || !validIdentity(value.sessionId) || !validIdentity(value.boot)) invalidInput()
  matchingBuildPolicy(value.policy)
  return { v: VERSION, type: 'open', sessionId: value.sessionId, config: sessionConfig(value.config),
    ...ownerIdentity(value), boot: value.boot }
}
export function parseControl(value: unknown, identity: BindingIdentity, previous: number): Record<string, unknown> {
  if (!record(value) || value.v !== VERSION || value.sessionId !== identity.sessionId
    || value.bindingId !== identity.bindingId || value.epoch !== identity.epoch
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= previous) invalidInput()
  const fields = ['v', 'type', 'sessionId', 'bindingId', 'epoch', 'sequence']
  if (value.type === 'prepare-block') fields.push('blockRequestId', 'cid')
  else if (['read-block', 'cancel-block', 'consume', 'discard'].includes(value.type as string)) fields.push('blockRequestId')
  else if (value.type !== 'snapshot' && value.type !== 'close') invalidInput()
  exact(value, fields)
  if (fields.includes('blockRequestId') && (!Number.isSafeInteger(value.blockRequestId)
    || (value.blockRequestId as number) <= 0)) invalidInput()
  return value
}
export function responseHeaders(identity: BindingIdentity, id: number): Headers {
  return new Headers({ 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', [HEADERS.version]: String(VERSION),
    [HEADERS.bindingId]: identity.bindingId, [HEADERS.epoch]: identity.epoch,
    [HEADERS.blockRequestId]: String(id) })
}
