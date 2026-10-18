import { checkSignal, networkError } from './errors'
import { cancelResponseBody, createReaderCancellation } from './direct-reader'

/** The returned promise owns the fetch and reader until both actually exit. */
export async function fetchBounded(
  fetch: typeof globalThis.fetch, url: string, accept: string, maxBytes: number, signal: AbortSignal,
  consume?: (chunk: Uint8Array, response: Response) => boolean,
): Promise<Uint8Array> {
  checkSignal(signal)
  const response = await fetch(url, {
    method: 'GET', headers: { Accept: accept }, signal,
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
  })
  const reject = async () => {
    await cancelResponseBody(response)
    checkSignal(signal)
    throw networkError(response.status === 404 ? 'NOT_FOUND' : 'NETWORK', '服务未返回受支持的响应。')
  }
  let headerBytes = 0
  let headerCount = 0
  for (const [name, value] of response.headers) {
    headerBytes += name.length + value.length
    if (++headerCount > 64 || headerBytes > 16 * 1024) return reject()
  }
  if (signal.aborted || response.redirected || !response.ok || response.type === 'opaqueredirect' || response.type === 'opaque') return reject()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) return reject()
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType && !accept.split(',').map(value => value.trim()).includes(contentType)) return reject()
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const cancelReader = createReaderCancellation(reader)
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    cancellation ??= cancelReader()
    void cancellation.catch(() => {})
    return cancellation
  }
  const abort = () => { void cancel() }
  signal.addEventListener('abort', abort, { once: true })
  let buffer = new Uint8Array(consume ? 0 : Math.min(maxBytes, 65536))
  let total = 0
  let complete = false
  try {
    while (true) {
      checkSignal(signal)
      const { value, done } = await reader.read()
      checkSignal(signal)
      if (done) { complete = true; break }
      total += value.byteLength
      if (total > maxBytes) throw networkError('NETWORK', '候选响应超过字节上限。')
      if (consume) {
        if (!consume(value, response)) break
      } else {
        if (total > buffer.byteLength) {
          const grown = new Uint8Array(Math.min(maxBytes, Math.max(total, buffer.byteLength * 2)))
          grown.set(buffer)
          buffer = grown
        }
        buffer.set(value, total - value.byteLength)
      }
    }
    if (complete && declared !== null && Number(declared) !== total) throw networkError('NETWORK', '响应长度不匹配。')
    return consume ? new Uint8Array() : buffer.slice(0, total)
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      if (!complete) await cancel()
      if (cancellation) await cancellation
    } finally { reader.releaseLock() }
  }
}
