import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultGalleryPreferences, GALLERY_PREFERENCES_KEY, MAX_PREFERENCES_LENGTH,
  parseStoredGalleryPreferences, readGalleryPreferences, serializeGalleryPreferences, updateGalleryPreferences,
} from '../../src/hooks/galleryPreferences'
import type { GalleryPreferenceAction, GalleryPreferences, GalleryPreferencesState, PreferenceStorage, StorageAccess } from '../../src/hooks/galleryPreferences'
import { useGalleryPreferences } from '../../src/hooks/useGalleryPreferences'
import type { GalleryPreferencesController } from '../../src/hooks/useGalleryPreferences'
import { parseLocation } from '../../src/core/query'
import { DEFAULT_LIMITS } from '../../src/shared/limits'

const localGateway = 'https://local-gateway.tld'
const urlGateway = 'https://shared-gateway.tld'
const record = () => ({ version: 1, layout: 'dual', sidebar: { desktop: false, mobile: true }, gateways: [localGateway] })

function storageFixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    clear: vi.fn(() => { values.clear() }),
  }
  const access = vi.fn(() => storage)
  return { values, storage, access }
}

function preferencesSession(access: StorageAccess) {
  let state = readGalleryPreferences(access)
  return {
    get state() { return state },
    dispatch(action: GalleryPreferenceAction) {
      const next = updateGalleryPreferences(state, action, access)
      state = next.state
      return next.result
    },
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('preference record validation and privacy', () => {
  it('restores the complete whitelist and canonicalizes/deduplicates enabled gateways', () => {
    const value = { ...record(), gateways: [' HTTPS://Gateway.tld:443/prefix/ ', 'https://gateway.tld/prefix', localGateway] }
    expect(parseStoredGalleryPreferences(JSON.stringify(value))).toEqual({
      layout: 'dual', sidebar: { desktop: false, mobile: true }, gateways: ['https://gateway.tld/prefix', localGateway],
    })
    const defaults = parseStoredGalleryPreferences(serializeGalleryPreferences(defaultGalleryPreferences()))
    expect(defaults.gateways).toEqual([])
    expect(defaults).toEqual(defaultGalleryPreferences())
  })

  it.each([
    null, [], {}, { ...record(), version: 2 }, { ...record(), version: '1' },
    { ...record(), layout: 'grid' }, { ...record(), layout: null },
    { ...record(), sidebar: { desktop: true } }, { ...record(), sidebar: { desktop: 'true', mobile: false } },
    { ...record(), sidebar: { desktop: true, mobile: 0 } }, { ...record(), sidebar: [] },
    { ...record(), gateways: 'https://gateway.tld' }, { ...record(), gateways: [1] },
    { ...record(), gateways: [...Array<string>(DEFAULT_LIMITS.maxGateways + 1).fill(localGateway)] },
    { ...record(), gateways: [' '.repeat(4096) + localGateway] },
    { ...record(), gateways: [`https://gateway.tld/${'中'.repeat(500)}`] },
    { ...record(), sidebar: { desktop: false, mobile: true, layout: 'dual' } },
    { ...record(), remember: true }, { ...record(), input: {} }, { ...record(), media: 'blob:private' },
  ])('rejects an invalid record without partially restoring its fields: %j', value => {
    const { storage, access } = storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(value) })
    const state = readGalleryPreferences(access)
    expect(state.preferences).toEqual(defaultGalleryPreferences())
    expect(state.remember).toBe(false)
    expect(state.storageStatus).toBe('invalid')
    expect(state.storageMessage).toBeTruthy()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects a pollution key at either object boundary: %s', key => {
    const value = record()
    expect(() => parseStoredGalleryPreferences(JSON.stringify({ ...value, [key]: {} }))).toThrow()
    expect(() => parseStoredGalleryPreferences(JSON.stringify({ ...value, sidebar: { ...value.sidebar, [key]: {} } }))).toThrow()
  })

  it.each([
    'http://gateway.tld', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://user:secret@gateway.tld', 'https://gateway.tld/?token=secret', 'https://gateway.tld/#private',
    'https://gateway.tld/a/../b', 'https://gateway.tld/a%2fb', 'https://gateway.tld/%00', 'https://gateway.tld/%ZZ',
  ])('uses the shared public HTTPS gateway boundary: %s', gateway => {
    expect(() => parseStoredGalleryPreferences(JSON.stringify({ ...record(), gateways: [gateway] }))).toThrow()
  })

  it('checks the character budget before JSON parsing and accepts the exact budget', () => {
    const text = JSON.stringify(record())
    const parse = vi.spyOn(JSON, 'parse')
    expect(() => parseStoredGalleryPreferences(' '.repeat(MAX_PREFERENCES_LENGTH + 1))).toThrow()
    expect(parse).not.toHaveBeenCalled()
    expect(parseStoredGalleryPreferences(text.padEnd(MAX_PREFERENCES_LENGTH, ' '))).toEqual({ layout: 'dual', sidebar: record().sidebar, gateways: [localGateway] })
    const { access } = storageFixture({ [GALLERY_PREFERENCES_KEY]: '{not JSON' })
    expect(readGalleryPreferences(access).storageStatus).toBe('invalid')
  })

  it('roundtrips the maximum gateway count and per-gateway length within the record budget', () => {
    const prefix = 'https://gateway.tld/'
    const gateways = Array.from({ length: DEFAULT_LIMITS.maxGateways }, (_, index) => `${prefix}${index}${'a'.repeat(4096 - prefix.length - 1)}`)
    const text = serializeGalleryPreferences({ ...defaultGalleryPreferences(), gateways })
    expect(text.length).toBeLessThanOrEqual(MAX_PREFERENCES_LENGTH)
    expect(parseStoredGalleryPreferences(text).gateways).toEqual(gateways)
  })

  it('rebuilds only allowed fields rather than serializing URL, authentication, media or statistics', () => {
    const contaminated = {
      ...defaultGalleryPreferences(), layout: 'single' as const,
      input: { cid: 'private-cid', path: ['private-path'] }, view: { item: 'private-item', q: 'private-search', tags: ['private-tag'], sort: 'name' },
      history: ['private-source'], auth: 'private-auth', blob: 'private-media', stats: [{ successes: 10 }], remember: true,
    }
    expect(JSON.parse(serializeGalleryPreferences(contaminated))).toEqual({ version: 1, layout: 'single', sidebar: { desktop: true, mobile: false }, gateways: [] })
  })

  it('returns immutable snapshots that cannot alter preferences without a setter', () => {
    const value = parseStoredGalleryPreferences(JSON.stringify(record()))
    expect(() => { value.gateways.push(urlGateway) }).toThrow()
    expect(() => { value.sidebar.mobile = false }).toThrow()
    expect(() => { (value as GalleryPreferences).layout = 'single' }).toThrow()
    expect(defaultGalleryPreferences().sidebar).toEqual({ desktop: true, mobile: false })
  })
})

describe('explicit opt-in and preference actions', () => {
  it('starts synchronously with defaults, performs only reads on repeated loads and never writes while opted out', () => {
    const { access, storage } = storageFixture()
    const session = preferencesSession(access)
    expect(session.state).toEqual({ preferences: defaultGalleryPreferences(), remember: false, storageStatus: 'disabled' })
    readGalleryPreferences(access)
    expect(storage.getItem).toHaveBeenCalledTimes(2)
    expect(storage.getItem).toHaveBeenLastCalledWith(GALLERY_PREFERENCES_KEY)
    expect(session.dispatch({ type: 'layout', mode: 'single' })).toEqual({ ok: true })
    expect(session.dispatch({ type: 'sidebar', device: 'desktop', open: false })).toEqual({ ok: true })
    expect(session.dispatch({ type: 'sidebar', device: 'mobile', open: true })).toEqual({ ok: true })
    expect(session.dispatch({ type: 'gateways', gateways: [localGateway] })).toEqual({ ok: true })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(access).toHaveBeenCalledTimes(2)
    expect(readGalleryPreferences(access).preferences).toEqual(defaultGalleryPreferences())
  })

  it('writes the current local snapshot immediately on opt-in and restores all preference actions on reload', () => {
    const { access, storage, values } = storageFixture()
    const session = preferencesSession(access)
    session.dispatch({ type: 'layout', mode: 'dual' })
    session.dispatch({ type: 'sidebar', device: 'desktop', open: false })
    session.dispatch({ type: 'sidebar', device: 'mobile', open: true })
    session.dispatch({ type: 'gateways', gateways: ['https://LOCAL-Gateway.tld:443/', localGateway] })
    expect(session.dispatch({ type: 'remember', enabled: true })).toEqual({ ok: true })
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(values.get(GALLERY_PREFERENCES_KEY)!)).toEqual(record())
    expect(readGalleryPreferences(access)).toEqual({ preferences: session.state.preferences, remember: true, storageStatus: 'saved' })
    session.dispatch({ type: 'layout', mode: 'single' })
    session.dispatch({ type: 'sidebar', device: 'desktop', open: true })
    session.dispatch({ type: 'sidebar', device: 'mobile', open: false })
    session.dispatch({ type: 'gateways', gateways: [] })
    expect(storage.setItem).toHaveBeenCalledTimes(5)
    expect(readGalleryPreferences(access).preferences).toEqual({ layout: 'single', sidebar: { desktop: true, mobile: false }, gateways: [] })
    expect(new Set(storage.setItem.mock.calls.map(([key]) => key))).toEqual(new Set([GALLERY_PREFERENCES_KEY]))
  })

  it('preserves the gateway reference during layout/sidebar actions and equal gateway reapplication', () => {
    const session = preferencesSession(storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) }).access)
    const gateways = session.state.preferences.gateways
    session.dispatch({ type: 'layout', mode: 'single' })
    session.dispatch({ type: 'sidebar', device: 'desktop', open: true })
    session.dispatch({ type: 'gateways', gateways: ['https://LOCAL-GATEWAY.tld/'] })
    expect(session.state.preferences.gateways).toBe(gateways)
  })

  it('rejects invalid user actions without changing state or touching storage', () => {
    const { access, storage } = storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    const before = session.state
    for (const action of [
      { type: 'layout', mode: 'grid' }, { type: 'sidebar', device: 'tablet', open: true },
      { type: 'sidebar', device: 'mobile', open: 'false' }, { type: 'remember', enabled: 'true' },
      { type: 'gateways', gateways: ['https://user:secret@gateway.tld'] },
      { type: 'gateways', gateways: new Array<string>(1) },
      { type: 'gateways', gateways: [`https://gateway.tld/${'中'.repeat(500)}`] },
    ]) {
      expect(session.dispatch(action as GalleryPreferenceAction)).toMatchObject({ ok: false, reason: 'invalid' })
      expect(session.state).toBe(before)
    }
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(access).toHaveBeenCalledTimes(1)
  })

  it('turns saving off without losing session preferences and only removes the owned key', () => {
    const { access, storage, values } = storageFixture({ unrelated: 'keep', [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    const before = session.state.preferences
    expect(session.dispatch({ type: 'remember', enabled: false })).toEqual({ ok: true })
    expect(session.state.preferences).toBe(before)
    expect(session.state.remember).toBe(false)
    expect(session.state.storageStatus).toBe('disabled')
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(GALLERY_PREFERENCES_KEY)
    expect(values.get('unrelated')).toBe('keep')
    expect(values.has(GALLERY_PREFERENCES_KEY)).toBe(false)
    session.dispatch({ type: 'layout', mode: 'single' })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.clear).not.toHaveBeenCalled()
  })

  it('clears the owned record, restores every default and leaves other browser data untouched', () => {
    const { access, storage, values } = storageFixture({ unrelated: 'keep', [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    expect(session.dispatch({ type: 'clear' })).toEqual({ ok: true })
    expect(session.state).toEqual({ preferences: defaultGalleryPreferences(), remember: false, storageStatus: 'disabled' })
    expect(values).toEqual(new Map([['unrelated', 'keep']]))
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(GALLERY_PREFERENCES_KEY)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.clear).not.toHaveBeenCalled()
  })
})

describe('honest IO failures and explicit recovery', () => {
  it.each(['getter', 'getItem', 'missing'] as const)('keeps memory usable when storage is unavailable: %s', failure => {
    const { access, storage } = storageFixture()
    const unavailable: StorageAccess = failure === 'missing' ? () => undefined : access
    if (failure === 'getter') access.mockImplementation(() => { throw new Error('blocked getter') })
    if (failure === 'getItem') storage.getItem.mockImplementation(() => { throw new Error('blocked read') })
    const session = preferencesSession(unavailable)
    expect(session.state.storageStatus).toBe('unavailable')
    expect(session.state.remember).toBe(false)
    expect(session.dispatch({ type: 'layout', mode: 'single' })).toEqual({ ok: true })
    expect(session.state.preferences.layout).toBe('single')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('accepts memory changes and saving intent on write failure; a later explicit retry saves the latest snapshot', () => {
    const { access, storage, values } = storageFixture()
    const session = preferencesSession(access)
    storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    expect(session.dispatch({ type: 'remember', enabled: true })).toMatchObject({ ok: false, reason: 'storage' })
    expect(session.state.remember).toBe(true)
    expect(session.state.storageStatus).toBe('write-failed')
    expect(values.has(GALLERY_PREFERENCES_KEY)).toBe(false)
    storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    expect(session.dispatch({ type: 'gateways', gateways: [localGateway] })).toMatchObject({ ok: false, reason: 'storage' })
    expect(session.state.preferences.gateways).toEqual([localGateway])
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(session.dispatch({ type: 'remember', enabled: true })).toEqual({ ok: true })
    expect(session.state.storageStatus).toBe('saved')
    expect(session.state.storageMessage).toBeUndefined()
    expect(readGalleryPreferences(access).preferences.gateways).toEqual([localGateway])
  })

  it('retains accepted memory preferences and saving intent if storage access fails during a write', () => {
    const { access, storage } = storageFixture()
    const session = preferencesSession(access)
    session.dispatch({ type: 'gateways', gateways: [localGateway] })
    access.mockImplementation(() => { throw new Error('blocked getter') })
    expect(session.dispatch({ type: 'remember', enabled: true })).toMatchObject({ ok: false, reason: 'storage' })
    expect(session.state).toMatchObject({ preferences: { gateways: [localGateway] }, remember: true, storageStatus: 'unavailable' })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['remember', 'clear'] as const)('does not claim deletion success or keep writing when %s cannot delete', action => {
    const { access, storage, values } = storageFixture({ unrelated: 'keep', [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    const before = session.state.preferences
    storage.removeItem.mockImplementationOnce(() => { throw new Error('blocked removal') })
    expect(session.dispatch(action === 'clear' ? { type: 'clear' } : { type: 'remember', enabled: false })).toMatchObject({ ok: false, reason: 'storage' })
    expect(session.state.remember).toBe(false)
    expect(session.state.storageStatus).toBe('remove-failed')
    expect(session.state.storageMessage).toBeTruthy()
    expect(session.state.preferences).toEqual(action === 'clear' ? defaultGalleryPreferences() : before)
    expect(values.has(GALLERY_PREFERENCES_KEY)).toBe(true)
    expect(readGalleryPreferences(access).remember).toBe(true)
    session.dispatch({ type: 'layout', mode: 'single' })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(session.state.storageStatus).toBe('remove-failed')
    expect(session.dispatch({ type: 'remember', enabled: false })).toEqual({ ok: true })
    expect(session.state.storageStatus).toBe('disabled')
    expect(values).toEqual(new Map([['unrelated', 'keep']]))
  })

  it('reports failed clearing when storage access itself becomes unavailable', () => {
    const { access } = storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    access.mockImplementation(() => { throw new Error('blocked getter') })
    expect(session.dispatch({ type: 'clear' })).toMatchObject({ ok: false, reason: 'storage' })
    expect(session.state).toMatchObject({ preferences: defaultGalleryPreferences(), remember: false, storageStatus: 'unavailable' })
    expect(session.state.storageMessage).toBeTruthy()
  })

  it('does not rewrite a damaged record until explicitly asked to save or clear it', () => {
    const { access, storage } = storageFixture({ [GALLERY_PREFERENCES_KEY]: '{broken' })
    const session = preferencesSession(access)
    session.dispatch({ type: 'layout', mode: 'single' })
    expect(session.state.storageStatus).toBe('invalid')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(session.dispatch({ type: 'remember', enabled: true })).toEqual({ ok: true })
    expect(readGalleryPreferences(access).preferences.layout).toBe('single')
  })
})

describe('URL isolation and synchronous hook initialization', () => {
  it('keeps URL overrides separate while saving local layout/sidebar preferences, then promotes gateways only on explicit apply', () => {
    const { access, storage, values } = storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    const session = preferencesSession(access)
    const location = parseLocation(`?gateway=${encodeURIComponent(urlGateway)}&q=private&tag=private&item=private`)
    const originalLocation = structuredClone(location)
    expect(location.gateways).toEqual([urlGateway])
    expect(storage.setItem).not.toHaveBeenCalled()
    session.dispatch({ type: 'layout', mode: 'single' })
    session.dispatch({ type: 'sidebar', device: 'mobile', open: false })
    session.dispatch({ type: 'remember', enabled: true })
    expect(JSON.parse(values.get(GALLERY_PREFERENCES_KEY)!).gateways).toEqual([localGateway])
    expect(location).toEqual(originalLocation)
    session.dispatch({ type: 'gateways', gateways: location.gateways })
    expect(JSON.parse(values.get(GALLERY_PREFERENCES_KEY)!).gateways).toEqual([urlGateway])
    session.dispatch({ type: 'gateways', gateways: [] })
    expect(readGalleryPreferences(access).preferences.gateways).toEqual([])
    session.dispatch({ type: 'clear' })
    expect(location).toEqual(originalLocation)
    expect(session.state.preferences.gateways).toEqual([])
  })

  it('reads restored preferences before returning the hook without any render writes', () => {
    const { storage } = storageFixture({ [GALLERY_PREFERENCES_KEY]: JSON.stringify(record()) })
    vi.stubGlobal('window', { localStorage: storage })
    const observed: GalleryPreferencesController[] = []
    function Consumer() { observed.push(useGalleryPreferences()); return null }
    renderToString(createElement(Consumer))
    renderToString(createElement(Consumer))
    expect(observed).toHaveLength(2)
    for (const controller of observed) {
      expect(controller).toMatchObject({ preferences: { layout: 'dual', sidebar: record().sidebar, gateways: [localGateway] }, remember: true, storageStatus: 'saved' })
      expect(controller.setLayout).toBeTypeOf('function')
      expect(controller.setSidebar).toBeTypeOf('function')
      expect(controller.setRemember).toBeTypeOf('function')
      expect(controller.applyGateways).toBeTypeOf('function')
      expect(controller.clearSavedPreferences).toBeTypeOf('function')
    }
    expect(storage.getItem).toHaveBeenCalledTimes(2)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('handles the browser localStorage getter throwing during hook initialization', () => {
    vi.stubGlobal('window', { get localStorage(): PreferenceStorage { throw new Error('blocked browser storage') } })
    let observed: GalleryPreferencesState | undefined
    function Consumer() { observed = useGalleryPreferences(); return null }
    expect(() => renderToString(createElement(Consumer))).not.toThrow()
    expect(observed).toMatchObject({ preferences: defaultGalleryPreferences(), remember: false, storageStatus: 'unavailable' })
  })
})
