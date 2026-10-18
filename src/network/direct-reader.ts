import { DirectCleanupError } from './direct-errors'

export function createReaderCancellation(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<void> {
  const terminal = reader.closed.then(() => ({ errored: false as const }), (error: unknown) => ({ errored: true as const, error }))
  return async () => {
    try { await reader.cancel() } catch (error) {
      // Cancelling a readable stream closes it before invoking its cancellation
      // algorithm. Only its exact stored terminal error can therefore be replay.
      const state = await terminal
      if (state.errored && Object.is(state.error, error)) return
      throw new DirectCleanupError()
    }
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return
  try {
    const reader = response.body.getReader()
    try { await createReaderCancellation(reader)() } finally { reader.releaseLock() }
  } catch { throw new DirectCleanupError() }
}
