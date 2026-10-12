import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReaderDownloadScope } from '../../src/components/readerDownload'
import type { AssetLease } from '../../src/hooks/assetService'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const item = { ref: { cid: 'opaque-reader-ref', path: [] }, title: '../unsafe\\name.png' }
const verified = (): AssetLease => ({ active: true, url: 'blob:verified-original', mime: 'image/png', kind: 'image', byteLength: 4, release: vi.fn() })
const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
beforeEach(() => {
  vi.useFakeTimers()
  anchor.href = ''; anchor.download = ''; anchor.click.mockReset(); anchor.remove.mockReset()
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { append: vi.fn() } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('ReaderSession download ownership', () => {
  it('acquires a separate priority-zero ticket only on explicit download and retains it for one second', async () => {
    const original = verified()
    const cancel = vi.fn()
    const acquire = vi.fn(() => ({ promise: Promise.resolve(original), cancel }))
    const notice = vi.fn(); const busy = vi.fn()
    const scope = new ReaderDownloadScope({ acquire }, item, notice, busy)
    expect(acquire).not.toHaveBeenCalled()
    await scope.download(original)
    expect(acquire).toHaveBeenCalledExactlyOnceWith(item.ref, 0)
    expect(anchor.href).toBe(original.url)
    expect(Array.from(anchor.download).some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32)).toBe(false)
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    await scope.download(original)
    expect(acquire).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(999)
    expect(cancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(busy.mock.calls).toEqual([[true], [false]])
    expect(original.release).not.toHaveBeenCalled()
    scope.dispose()
  })

  for (const outcome of ['success', 'failure'] as const) {
    it(`disposing an old item/session cancels its ticket and ignores late ${outcome} without dispatching or changing current state`, async () => {
      const original = verified()
      const pending = deferred<AssetLease>()
      const cancel = vi.fn()
      const notice = vi.fn(); const busy = vi.fn()
      const scope = new ReaderDownloadScope({ acquire: vi.fn(() => ({ promise: pending.promise, cancel })) }, item, notice, busy)
      const downloading = scope.download(original)
      scope.dispose()
      expect(cancel).toHaveBeenCalledOnce()
      const states = { notice: notice.mock.calls.slice(), busy: busy.mock.calls.slice() }
      if (outcome === 'success') pending.resolve(original)
      else pending.reject(new Error('late failure'))
      await downloading
      expect(anchor.click).not.toHaveBeenCalled()
      expect(notice.mock.calls).toEqual(states.notice)
      expect(busy.mock.calls).toEqual(states.busy)
      expect(original.release).not.toHaveBeenCalled()
    })
  }

  it('disposal during the browser handoff clears the short timer and cancels only the download ticket', async () => {
    const original = verified()
    const cancel = vi.fn()
    const scope = new ReaderDownloadScope({ acquire: vi.fn(() => ({ promise: Promise.resolve(original), cancel })) }, item, vi.fn(), vi.fn())
    await scope.download(original)
    scope.dispose()
    expect(cancel).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(cancel).toHaveBeenCalledOnce()
    expect(original.release).not.toHaveBeenCalled()
  })

  it('a dispatch failure removes the anchor, releases its ticket and permits an explicit retry', async () => {
    const original = verified()
    const cancel = vi.fn()
    const acquire = vi.fn(() => ({ promise: Promise.resolve(original), cancel }))
    const scope = new ReaderDownloadScope({ acquire }, item, vi.fn(), vi.fn())
    anchor.click.mockImplementationOnce(() => { throw new Error('denied') })
    await scope.download(original)
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    await scope.download(original)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(anchor.click).toHaveBeenCalledTimes(2)
    scope.dispose()
  })

  it('an invalidated verified lease cannot start a download', async () => {
    const acquire = vi.fn()
    const scope = new ReaderDownloadScope({ acquire }, item, vi.fn(), vi.fn())
    await scope.download({ ...verified(), active: false })
    expect(acquire).not.toHaveBeenCalled()
    expect(anchor.click).not.toHaveBeenCalled()
    scope.dispose()
  })
})
