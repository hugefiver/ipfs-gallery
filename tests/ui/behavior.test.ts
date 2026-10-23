import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetService, MainAssetSet, type MainAssetSnapshot } from '../../src/hooks/assetService'
import { GalleryController } from '../../src/hooks/galleryController'
import { filterItems, safeFilename } from '../../src/app/format'
import { DEFAULT_LIMITS } from '../../src/shared/limits'
import { resolveGalleryGateways } from '../../src/hooks/useGallery'
import { DEFAULT_GATEWAYS } from '../../src/shared/gateways'
import { GalleryDomainError } from '../../src/shared/errors'
import type { GalleryClient, GalleryResult, ParsedLocation, VerifiedAsset, WorkerRequest, WorkerResponse } from '../../src/shared/contracts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const pending: Array<{ request: Extract<WorkerRequest, { type: 'asset' }>; response: ReturnType<typeof deferred<VerifiedAsset>> }> = []
  const discoveries: Array<{ request: Extract<WorkerRequest, { type: 'discover' }>; response: ReturnType<typeof deferred<GalleryResult>> }> = []
  let listener: ((event: Extract<WorkerResponse, { type: 'progress' | 'telemetry' }>) => void) | undefined
  const client: GalleryClient = {
    loadAsset: vi.fn(request => { const response = deferred<VerifiedAsset>(); pending.push({ request, response }); return response.promise }),
    discover: vi.fn(request => { const response = deferred<GalleryResult>(); discoveries.push({ request, response }); return response.promise }),
    cancel: vi.fn(async () => {}), releaseSession: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    subscribe: vi.fn(value => { listener = value; return () => { listener = undefined } }),
  }
  return { client, pending, discoveries, event: (value: Extract<WorkerResponse, { type: 'progress' | 'telemetry' }>) => listener?.(value) }
}
const ref = (index: number) => ({ cid: `test-ref-${index}`, path: [] }) // Opaque references: these tests do not parse or request IPFS content.
const asset = (size = 4): VerifiedAsset => ({ bytes: new ArrayBuffer(size), byteLength: size, mime: 'image/png', kind: 'image' })
const result = (title: string): GalleryResult => ({ title, description: '', items: [], warnings: [], partial: false })
const location = (index: number): ParsedLocation => ({ input: { source: { kind: 'unixfs', ref: ref(index), browse: false } }, view: { q: '', tags: [] }, gateways: [], notices: [] })
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
let next = 0
let urls = 0
beforeEach(() => {
  next = 0; urls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++urls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('main-thread asset ownership', () => {
  it('invalidates every old lease immediately when the source session changes', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('old')
    const ticket = service.acquire(ref(1), 0)
    pending[0]!.response.resolve(asset())
    const lease = await ticket.promise
    service.setSession('new')
    expect(lease.active).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(lease.url)
    ticket.cancel(); service.dispose()
  })
  it('releases low-priority pinned previews to admit an original without raising the cache budget', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const original = service.acquire(ref(1), 0)
    pending[0]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes))
    const main = await original.promise
    const thumbnail = service.acquire(ref(2), 1)
    pending[1]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes))
    const preview = await thumbnail.promise
    const entering = service.acquire(ref(3), 0)
    pending[2]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes))
    const incoming = await entering.promise
    expect(main.active).toBe(true)
    expect(incoming.active).toBe(true)
    expect(preview.active).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(preview.url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(main.url)
    original.cancel(); entering.cancel(); service.dispose()
  })
  it('keeps three outstanding slots across cancellation/session changes and never creates stale blobs', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('old')
    const tickets = [1, 2, 3, 4].map(value => service.acquire(ref(value)))
    tickets.forEach(ticket => void ticket.promise.catch(() => {}))
    expect(pending).toHaveLength(3)
    service.setSession('new')
    const current = service.acquire(ref(5))
    expect(pending).toHaveLength(3)
    pending[0]!.response.resolve(asset())
    await settle()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(pending).toHaveLength(4)
    expect(pending[3]!.request.sessionId).toBe('new')
    pending[3]!.response.resolve(asset())
    const lease = await current.promise
    expect(lease.url).toBe('blob:test-1')
    current.cancel()
    pending[1]!.response.resolve(asset()); pending[2]!.response.resolve(asset())
    await settle()
    service.dispose()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(lease.url)
  })
  it('deduplicates shared references and cancels only after the last consumer releases', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const first = service.acquire(ref(1)); const second = service.acquire(ref(1), 0)
    void first.promise.catch(() => {})
    first.cancel()
    expect(client.cancel).not.toHaveBeenCalled()
    expect(pending).toHaveLength(1)
    pending[0]!.response.resolve(asset())
    const lease = await second.promise
    expect(lease.active).toBe(true)
    second.cancel(); expect(lease.active).toBe(false)
    service.dispose()
  })
  it('starts queued viewer requests before queued gallery requests', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const tickets = [1, 2, 3, 4].map(value => service.acquire(ref(value)))
    const viewer = service.acquire(ref(5), 0)
    tickets.forEach(ticket => void ticket.promise.catch(() => {})); void viewer.promise.catch(() => {})
    pending[0]!.response.resolve(asset())
    await settle()
    expect(pending[3]!.request.ref).toEqual(ref(5))
    service.dispose()
    pending.forEach(value => value.response.resolve(asset())); await settle()
  })
  it('uses exact bytes and holds referenced blobs instead of exceeding 128 MiB', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const first = service.acquire(ref(1)); pending[0]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes)); const a = await first.promise
    const second = service.acquire(ref(2)); pending[1]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes)); const b = await second.promise
    const third = service.acquire(ref(3)); const rejected = expect(third.promise).rejects.toMatchObject({ error: { code: 'LIMIT' } })
    pending[2]!.response.resolve(asset(1)); await rejected
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    first.cancel()
    const retry = service.acquire(ref(3)); pending[3]!.response.resolve(asset(1)); await retry.promise
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(a.url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(b.url)
    service.dispose(); second.cancel(); retry.cancel()
  })
  it('does not create a blob from inconsistent transferred buffers', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const ticket = service.acquire(ref(1)); const rejected = expect(ticket.promise).rejects.toMatchObject({ error: { code: 'INTERNAL' } })
    pending[0]!.response.resolve({ ...asset(4), byteLength: 3 }); await rejected
    expect(URL.createObjectURL).not.toHaveBeenCalled(); service.dispose()
  })
})

describe('main asset set ownership', () => {
  it('waits for cancelled sidebar jobs to settle without releasing their outstanding slots early', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const previews = [1, 2, 3].map(value => service.acquire(ref(value), 1))
    previews.forEach(ticket => void ticket.promise.catch(() => {}))
    const publish = vi.fn()
    const main = new MainAssetSet(service, publish)
    main.update([ref(4), ref(5)])
    expect(client.cancel).toHaveBeenCalledTimes(3)
    expect(pending).toHaveLength(3)
    pending[0]!.response.resolve(asset()); await settle()
    expect(pending[3]!.request.ref).toEqual(ref(4))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    pending[1]!.response.resolve(asset()); await settle()
    expect(pending[4]!.request.ref).toEqual(ref(5))
    pending[2]!.response.resolve(asset())
    pending[3]!.response.resolve(asset()); pending[4]!.response.resolve(asset()); await settle()
    expect((publish.mock.calls.at(-1)![0] as MainAssetSnapshot).settled).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    main.dispose(); service.dispose()
  })
  it('registers originals before sidebar work and enables sidebar only after both originals settle', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const snapshots: MainAssetSnapshot[] = []
    const main = new MainAssetSet(service, snapshot => snapshots.push(snapshot))
    main.update([ref(1), ref(2)])
    expect(pending.map(value => value.request.ref)).toEqual([ref(1), ref(2)])
    expect(snapshots.at(-1)?.settled).toBe(false)
    pending[0]!.response.resolve(asset()); await settle()
    expect(snapshots.at(-1)?.settled).toBe(false)
    pending[1]!.response.reject(new GalleryDomainError({ code: 'UNSUPPORTED', message: 'Not an allowed media type', retryable: false })); await settle()
    expect(snapshots.at(-1)?.settled).toBe(true)
    expect(snapshots.at(-1)?.states.size).toBe(2)
    expect([...snapshots.at(-1)!.states.values()].filter(state => state.asset)).toHaveLength(1)
    expect([...snapshots.at(-1)!.states.values()][1]?.error?.code).toBe('UNSUPPORTED')
    const sidebar = service.acquire(ref(3), 1)
    expect(pending[2]!.request.ref).toEqual(ref(3))
    pending[2]!.response.resolve(asset()); await sidebar.promise
    main.dispose(); sidebar.cancel(); service.dispose()
  })
  it('retains the overlapping original and releases exiting/sidebar leases before loading the entering item', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    let current!: MainAssetSnapshot
    const main = new MainAssetSet(service, snapshot => { current = snapshot })
    main.update([ref(1), ref(2)])
    pending[0]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes))
    pending[1]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes)); await settle()
    const [first, overlap] = [...current.states.values()].map(state => state.asset!)
    const sidebar = service.acquire(ref(2), 2)
    const sidebarLease = await sidebar.promise
    main.update([ref(2), ref(3)])
    expect(first!.active).toBe(false)
    expect(overlap!.active).toBe(true)
    expect(sidebarLease.active).toBe(false)
    expect(pending).toHaveLength(3)
    expect(current.settled).toBe(false)
    expect([...current.states.values()][0]!.asset).toBe(overlap)
    pending[2]!.response.resolve(asset(DEFAULT_LIMITS.maxAssetBytes)); await settle()
    expect(current.settled).toBe(true)
    expect(current.byteLength).toBe(DEFAULT_LIMITS.maxBlobCacheBytes)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first!.url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(overlap!.url)
    const fullscreen = service.acquire(ref(2), 0)
    expect((await fullscreen.promise).url).toBe(overlap!.url)
    expect(pending).toHaveLength(3)
    main.dispose(); fullscreen.cancel(); service.dispose()
  })
  it('settles failures, retries only the failed original and ignores completion after disposal', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const publish = vi.fn()
    const main = new MainAssetSet(service, publish)
    main.update([ref(1), ref(2)])
    pending[0]!.response.resolve(asset())
    pending[1]!.response.reject(new Error('read failure')); await settle()
    const ready = publish.mock.calls.at(-1)![0] as MainAssetSnapshot
    expect(ready.settled).toBe(true)
    main.retry(ref(2))
    expect((publish.mock.calls.at(-1)![0] as MainAssetSnapshot).settled).toBe(false)
    expect(pending).toHaveLength(3)
    main.dispose()
    const calls = publish.mock.calls.length
    pending[2]!.response.resolve(asset()); await settle()
    expect(publish).toHaveBeenCalledTimes(calls)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    service.dispose()
  })
  it('hands modes over without resetting the session, refetching resident bytes or cancelling new album tickets', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const setSession = vi.spyOn(service, 'setSession')
    let snapshot!: MainAssetSnapshot
    const reader = new MainAssetSet(service, value => { snapshot = value })
    reader.update([ref(1)])
    pending[0]!.response.resolve(asset()); await settle()
    const original = [...snapshot.states.values()][0]!.asset!
    reader.dispose()
    expect(original.active).toBe(false)
    const thumbnail = service.acquire(ref(2), 1)
    void thumbnail.promise.catch(() => {})
    expect(pending).toHaveLength(2)
    expect(client.cancel).not.toHaveBeenCalled()
    pending[1]!.response.resolve(asset()); const albumLease = await thumbnail.promise
    expect(albumLease.active).toBe(true)
    thumbnail.cancel()
    const returning = new MainAssetSet(service, value => { snapshot = value })
    returning.update([ref(1)])
    await settle()
    const current = [...snapshot.states.values()][0]!.asset!
    expect(current.active).toBe(true)
    expect(current.url).toBe(original.url)
    expect(pending).toHaveLength(2)
    expect(setSession).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    returning.dispose(); service.dispose()
  })
  it('starts reader originals before queued visible thumbnails and fallback originals while keeping three actual jobs', async () => {
    const { client, pending } = fixture()
    const service = new AssetService(client, () => `r${++next}`)
    service.setSession('a')
    const busy = [1, 2, 3].map(index => service.acquire(ref(index), 1))
    const fallback = service.acquire(ref(4), 2)
    const visible = service.acquire(ref(5), 1)
    const reader = service.acquire(ref(6), 0)
    ;[...busy, fallback, visible, reader].forEach(ticket => void ticket.promise.catch(() => {}))
    busy.forEach(ticket => ticket.cancel())
    expect(pending).toHaveLength(3)
    pending[0]!.response.resolve(asset()); await settle()
    expect(pending[3]!.request.ref).toEqual(ref(6))
    pending[1]!.response.resolve(asset()); await settle()
    expect(pending[4]!.request.ref).toEqual(ref(5))
    pending[2]!.response.resolve(asset()); await settle()
    expect(pending[5]!.request.ref).toEqual(ref(4))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    service.dispose()
    pending.slice(3).forEach(job => job.response.resolve(asset())); await settle()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe('gallery session controller', () => {
  it('discovers once with final effective gateways for startup, explicit apply and default reset', async () => {
    const { client, discoveries } = fixture()
    const controller = new GalleryController(client)
    const source = location(1)
    const saved = ['https://saved.example/']
    const start = (url: ParsedLocation, preference: readonly string[]) => controller.start({ ...url, gateways: [...resolveGalleryGateways(url, preference)] })
    start(source, saved)
    start(source, [...saved])
    expect(discoveries).toHaveLength(1)
    expect(discoveries[0]!.request.config.gateways).toEqual(saved)
    const applied = { ...source, gateways: ['https://shared.example/'] }
    start(applied, saved)
    start(applied, applied.gateways)
    expect(discoveries).toHaveLength(2)
    expect(discoveries[1]!.request.config.gateways).toEqual(applied.gateways)
    const reset = { ...source, gateways: [...DEFAULT_GATEWAYS] }
    start(reset, applied.gateways)
    start(reset, [])
    expect(discoveries).toHaveLength(3)
    expect(discoveries[2]!.request.config.gateways).toEqual(DEFAULT_GATEWAYS)
    expect(source.gateways).toEqual([])
    controller.dispose(); await settle()
  })
  it('clears old results immediately and ignores stale promises and telemetry', async () => {
    const { client, discoveries, event } = fixture()
    const controller = new GalleryController(client)
    controller.start(location(1)); discoveries[0]!.response.resolve(result('old')); await settle()
    expect(controller.snapshot.result?.title).toBe('old')
    controller.start(location(2))
    expect(controller.snapshot.status).toBe('loading'); expect(controller.snapshot.result).toBeUndefined()
    event({ type: 'telemetry', sessionId: discoveries[0]!.request.sessionId, requestId: discoveries[0]!.request.requestId, gateways: [{ url: 'test', state: 'healthy', successes: 9, failures: 0, inFlight: 0 }] })
    expect(controller.snapshot.gateways).toEqual([])
    controller.start(location(3)); discoveries[1]!.response.resolve(result('stale')); await settle()
    expect(controller.snapshot.result).toBeUndefined()
    discoveries[2]!.response.resolve(result('current')); await settle()
    expect(controller.snapshot.result?.title).toBe('current')
    controller.dispose(); expect(client.dispose).toHaveBeenCalledTimes(1)
  })
  it('does not discover on view-only changes and allocates unique identities for cancellation/retry', async () => {
    const { client, discoveries } = fixture()
    const controller = new GalleryController(client)
    const source = location(1); controller.start(source)
    controller.start({ ...source, view: { q: '照片', tags: ['山'], item: 'item' } })
    expect(discoveries).toHaveLength(1)
    controller.cancel(); discoveries[0]!.response.resolve(result('cancelled')); await settle()
    expect(controller.snapshot.status).toBe('cancelled')
    controller.start(source, true); expect(discoveries).toHaveLength(2)
    expect(discoveries[1]!.request.requestId).not.toBe(discoveries[0]!.request.requestId)
    controller.dispose()
    expect(client.releaseSession).toHaveBeenCalled()
  })
})

describe('local filtering and safe downloads', () => {
  it('normalizes Unicode and searches paths, tags and alt while combining tags with AND', () => {
    const item = { id: 'x', ref: { cid: 'opaque', path: ['原片'] }, title: 'ＡＢＣ照片', alt: '风景', tags: ['山', '秋'], kind: 'image' as const, sourceLabel: '' }
    expect(filterItems([item], { q: 'abc', tags: ['山', '秋'] })).toEqual([item])
    expect(filterItems([item], { q: '原片', tags: ['山'] })).toEqual([item])
    expect(filterItems([item], { q: '风景', tags: ['海'] })).toEqual([])
    expect(filterItems([item], { q: '', tags: [], type: 'video' })).toEqual([])
  })
  it('removes path/control/bidi hazards, reserved names and uses verified MIME extensions', () => {
    const name = safeFilename('../dir\\图\u0000\u202E片.exe', 'image/png')
    expect(name).not.toContain('/'); expect(name).not.toContain('\\'); expect(name).not.toContain('\u0000'); expect(name).not.toContain('\u202E'); expect(name.endsWith('.png')).toBe(true)
    expect(safeFilename('CON', 'video/mp4')).toBe('影像.mp4')
    expect(safeFilename('', 'image/jpeg')).toBe('影像.jpg')
  })
})
