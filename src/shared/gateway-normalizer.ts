import { GalleryDomainError } from './errors'

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

/** Normalize an HTTPS public-domain gateway base; DNS resolution is browser-owned. */
export function normalizeGateway(value: string): string {
  const input = value.trim()
  const invalid = () => new GalleryDomainError({
    code: 'INVALID_INPUT', message: '网关必须是无凭据、查询或片段的 HTTPS 公网域名地址。', retryable: false,
  })
  if (!/^https:\/\//i.test(input) || input.length > 4096 || /[\\\s?#]/u.test(input) || hasControlCharacters(input)) throw invalid()
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw invalid()
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || input.split('/')[2]?.includes('@')) throw invalid()
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.')
  if (
    labels.length < 2 || host.length > 253 || /^[\d.]+$/.test(host) || host.includes(':') ||
    labels.some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ||
    /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test|example|onion|alt)$/.test(host) ||
    /(?:^|\.)home\.arpa$/.test(host) ||
    !/[a-z]/.test(labels.at(-1) ?? '')
  ) throw invalid()
  // Inspect the supplied path before URL's dot-segment normalization.
  const path = input.match(/^https:\/\/[^/]+(\/.*)?$/i)?.[1] ?? ''
  const segments = path.split('/').slice(1)
  if (segments.at(-1) === '') segments.pop()
  for (const encoded of segments) {
    let segment: string
    try { segment = decodeURIComponent(encoded) } catch { throw invalid() }
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || hasControlCharacters(segment)) throw invalid()
  }
  url.hostname = host
  url.pathname = segments.length ? `/${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}` : '/'
  return url.href.replace(/\/$/, '')
}
