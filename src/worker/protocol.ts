import type {
  ContentRef,
  GalleryInput,
  ResourceLimits,
  SessionConfig,
  WorkerRequest,
} from '../shared/contracts'
import { GalleryDomainError } from '../shared/errors'
import { DEFAULT_LIMITS } from '../shared/limits'

export const MAX_PENDING_REQUESTS = 128
export const MAX_REQUEST_IDS = 100_000

export interface Normalizers {
  normalizeContentRef(value: string): ContentRef
  normalizeGateway(value: string): string
}

export function invalidInput(): never {
  throw new GalleryDomainError({
    code: 'INVALID_INPUT',
    message: 'Worker 请求格式或安全限制无效。',
    retryable: false,
  })
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) invalidInput()
}

export function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !hasControl(value)
}

function hasControl(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true
  }
  return false
}

export function identity(value: unknown): { sessionId: string; requestId: string } {
  return {
    sessionId: record(value) && validIdentity(value.sessionId) ? value.sessionId : '',
    requestId: record(value) && validIdentity(value.requestId) ? value.requestId : '',
  }
}

function contentRef(value: unknown, normalizers: Normalizers): ContentRef {
  shape(value, ['cid', 'path'])
  if (typeof value.cid !== 'string' || value.cid.length > 512 || !Array.isArray(value.path)
    || value.path.length > 64 || value.path.some((segment) => typeof segment !== 'string'
      || segment.length === 0 || segment.length > 255 || /[/\\]/u.test(segment) || hasControl(segment)
      || /[\ud800-\udfff]/u.test(segment)
      || segment === '.' || segment === '..')) invalidInput()
  if ((value.path as string[]).join('/').length > 4096 || /[/\\\s]/u.test(value.cid)) invalidInput()
  // These are already decoded path segments, not another URI to decode or trim.
  return { cid: normalizers.normalizeContentRef(value.cid).cid, path: [...value.path as string[]] }
}

export function parseSessionConfig(value: unknown, normalizers: Normalizers): SessionConfig {
  shape(value, ['gateways', 'limits'])
  const keys = Object.keys(DEFAULT_LIMITS) as (keyof ResourceLimits)[]
  shape(value.limits, keys)
  const limits = {} as ResourceLimits
  for (const key of keys) {
    const limit = value.limits[key]
    const interval = key === 'progressIntervalMs' || key === 'telemetryIntervalMs'
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0
      || (interval ? limit < DEFAULT_LIMITS[key] || limit > 60_000 : limit > DEFAULT_LIMITS[key])) {
      invalidInput()
    }
    limits[key] = limit
  }
  if (!Array.isArray(value.gateways) || value.gateways.length === 0
    || value.gateways.length > limits.maxGateways) invalidInput()
  const gateways = value.gateways.map((gateway: unknown) => {
    if (typeof gateway !== 'string' || gateway.length > 4096) invalidInput()
    return normalizers.normalizeGateway(gateway)
  })
  return { limits, gateways: [...new Set(gateways)] }
}

function input(value: unknown, limits: ResourceLimits, normalizers: Normalizers): GalleryInput {
  shape(value, ['source'])
  if (!record(value.source)) invalidInput()
  const source = value.source
  if (source.kind === 'manifest') {
    shape(source, ['kind', 'ref'])
    return { source: { kind: 'manifest', ref: contentRef(source.ref, normalizers) } }
  }
  if (source.kind !== 'unixfs' && source.kind !== 'cids') invalidInput()
  if (typeof source.browse !== 'boolean') invalidInput()
  if (source.kind === 'unixfs') {
    shape(source, ['kind', 'ref', 'browse'])
    return { source: { kind: 'unixfs', ref: contentRef(source.ref, normalizers), browse: source.browse } }
  }
  shape(source, ['kind', 'refs', 'browse'])
  if (!Array.isArray(source.refs) || source.refs.length === 0 || source.refs.length > limits.maxRoots) {
    invalidInput()
  }
  const refs = source.refs.map((ref: unknown) => contentRef(ref, normalizers))
  const unique = new Map(refs.map((ref) => [JSON.stringify(ref), ref]))
  return { source: { kind: 'cids', refs: [...unique.values()], browse: source.browse } }
}

export function parseRequest(value: unknown, normalizers: Normalizers): WorkerRequest {
  if (!record(value) || !validIdentity(value.sessionId) || !validIdentity(value.requestId)) invalidInput()
  const ids = { sessionId: value.sessionId, requestId: value.requestId }
  switch (value.type) {
    case 'discover': {
      shape(value, ['type', 'sessionId', 'requestId', 'input', 'config'])
      const normalizedConfig = parseSessionConfig(value.config, normalizers)
      return { type: 'discover', ...ids, config: normalizedConfig,
        input: input(value.input, normalizedConfig.limits, normalizers) }
    }
    case 'asset':
      shape(value, ['type', 'sessionId', 'requestId', 'ref'])
      return { type: 'asset', ...ids, ref: contentRef(value.ref, normalizers) }
    case 'cancel':
      shape(value, ['type', 'sessionId', 'requestId', 'targetRequestId'])
      if (!validIdentity(value.targetRequestId) || value.targetRequestId === value.requestId) invalidInput()
      return { type: 'cancel', ...ids, targetRequestId: value.targetRequestId }
    case 'release-session':
    case 'dispose':
      shape(value, ['type', 'sessionId', 'requestId'])
      return { type: value.type, ...ids }
    default:
      return invalidInput()
  }
}
