import { normalizeGateway } from '../network/gateways'
import { DEFAULT_LIMITS } from '../shared/limits'

export type LayoutMode = 'auto' | 'single' | 'dual'
export type DeviceClass = 'desktop' | 'mobile'
export type GalleryPreferences = {
  layout: LayoutMode
  sidebar: { desktop: boolean; mobile: boolean }
  gateways: string[]
}
export type StoredGalleryPreferencesV1 = GalleryPreferences & { version: 1 }
export type StorageStatus = 'disabled' | 'saved' | 'invalid' | 'unavailable' | 'write-failed' | 'remove-failed'
export type PreferenceResult = { ok: true } | { ok: false; reason: 'invalid' | 'storage'; message: string }

export interface GalleryPreferencesController {
  preferences: Readonly<GalleryPreferences>
  remember: boolean
  storageStatus: StorageStatus
  storageMessage?: string
  setLayout(mode: LayoutMode): PreferenceResult
  setSidebar(device: DeviceClass, open: boolean): PreferenceResult
  setRemember(enabled: boolean): PreferenceResult
  applyGateways(gateways: readonly string[]): PreferenceResult
  clearSavedPreferences(): PreferenceResult
}

export const GALLERY_PREFERENCES_KEY = 'ipfs-gallery.preferences.v1'
export const MAX_PREFERENCES_LENGTH = 40 * 1024
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type StorageAccess = () => PreferenceStorage | undefined
export type GalleryPreferencesState = Pick<GalleryPreferencesController, 'preferences' | 'remember' | 'storageStatus' | 'storageMessage'>
export type GalleryPreferenceAction =
  | { type: 'layout'; mode: LayoutMode }
  | { type: 'sidebar'; device: DeviceClass; open: boolean }
  | { type: 'remember'; enabled: boolean }
  | { type: 'gateways'; gateways: readonly string[] }
  | { type: 'clear' }

type StorageOutcome = { status: StorageStatus; result: PreferenceResult }
const browserStorage: StorageAccess = () => typeof window === 'undefined' ? undefined : window.localStorage
const invalidMessage = '设置记录无效，已忽略；当前偏好仅在本次访问中有效。可开启保存以替换记录，或清除已保存设置。'
const accessMessage = '无法访问浏览器设置存储；当前偏好仅在本次访问中有效。'
const writeMessage = '保存失败；当前偏好仅在本次访问中有效，可重试保存。'
const removeMessage = '无法删除已保存设置；本次访问已停止保存，磁盘记录可能在下次访问恢复，请重试删除。'

function freezePreferences(preferences: GalleryPreferences): Readonly<GalleryPreferences> {
  Object.freeze(preferences.sidebar)
  Object.freeze(preferences.gateways)
  return Object.freeze(preferences)
}

export function defaultGalleryPreferences(): Readonly<GalleryPreferences> {
  return freezePreferences({ layout: 'auto', sidebar: { desktop: true, mobile: false }, gateways: [] })
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

function validLayout(value: unknown): value is LayoutMode {
  return value === 'auto' || value === 'single' || value === 'dual'
}

function normalizedGateways(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > DEFAULT_LIMITS.maxGateways) throw new Error('网关数量或类型无效。')
  const gateways = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('网关地址类型无效或超过长度限制。')
    const normalized = normalizeGateway(value)
    if (normalized.length > 4096) throw new Error('规范化的网关地址超过长度限制。')
    gateways.add(normalized)
  }
  return [...gateways]
}

function normalizedPreferences(value: GalleryPreferences): Readonly<GalleryPreferences> {
  if (!validLayout(value.layout) || !exactFields(value.sidebar, ['desktop', 'mobile']) ||
    typeof value.sidebar.desktop !== 'boolean' || typeof value.sidebar.mobile !== 'boolean') throw new Error(invalidMessage)
  return freezePreferences({ layout: value.layout, sidebar: { desktop: value.sidebar.desktop, mobile: value.sidebar.mobile }, gateways: normalizedGateways(value.gateways) })
}

export function parseStoredGalleryPreferences(text: string): Readonly<GalleryPreferences> {
  if (text.length > MAX_PREFERENCES_LENGTH) throw new Error(invalidMessage)
  const value: unknown = JSON.parse(text)
  if (!exactFields(value, ['version', 'layout', 'sidebar', 'gateways']) || value.version !== 1) throw new Error(invalidMessage)
  return normalizedPreferences(value as StoredGalleryPreferencesV1)
}

export function serializeGalleryPreferences(preferences: Readonly<GalleryPreferences>): string {
  const value = normalizedPreferences(preferences)
  const record: StoredGalleryPreferencesV1 = {
    version: 1, layout: value.layout,
    sidebar: { desktop: value.sidebar.desktop, mobile: value.sidebar.mobile }, gateways: [...value.gateways],
  }
  const text = JSON.stringify(record)
  if (text.length > MAX_PREFERENCES_LENGTH) throw new Error(invalidMessage)
  return text
}

export function readGalleryPreferences(access: StorageAccess = browserStorage): GalleryPreferencesState {
  const defaults = defaultGalleryPreferences()
  let text: string | null
  try {
    const storage = access()
    if (!storage) return { preferences: defaults, remember: false, storageStatus: 'unavailable', storageMessage: accessMessage }
    text = storage.getItem(GALLERY_PREFERENCES_KEY)
  } catch {
    return { preferences: defaults, remember: false, storageStatus: 'unavailable', storageMessage: accessMessage }
  }
  if (text === null) return { preferences: defaults, remember: false, storageStatus: 'disabled' }
  try { return { preferences: parseStoredGalleryPreferences(text), remember: true, storageStatus: 'saved' } }
  catch { return { preferences: defaults, remember: false, storageStatus: 'invalid', storageMessage: invalidMessage } }
}

function storageFailure(status: StorageStatus, message: string): StorageOutcome {
  return { status, result: { ok: false, reason: 'storage', message } }
}

export function writeGalleryPreferences(preferences: Readonly<GalleryPreferences>, access: StorageAccess = browserStorage): StorageOutcome {
  let text: string
  try { text = serializeGalleryPreferences(preferences) }
  catch { return { status: 'invalid', result: { ok: false, reason: 'invalid', message: invalidMessage } } }
  let storage: PreferenceStorage | undefined
  try { storage = access() }
  catch { return storageFailure('unavailable', accessMessage) }
  if (!storage) return storageFailure('unavailable', accessMessage)
  try { storage.setItem(GALLERY_PREFERENCES_KEY, text); return { status: 'saved', result: { ok: true } } }
  catch { return storageFailure('write-failed', writeMessage) }
}

export function removeGalleryPreferences(access: StorageAccess = browserStorage): StorageOutcome {
  let storage: PreferenceStorage | undefined
  try { storage = access() }
  catch { return storageFailure('unavailable', removeMessage) }
  if (!storage) return storageFailure('unavailable', removeMessage)
  try { storage.removeItem(GALLERY_PREFERENCES_KEY); return { status: 'disabled', result: { ok: true } } }
  catch { return storageFailure('remove-failed', removeMessage) }
}

function completed(preferences: Readonly<GalleryPreferences>, remember: boolean, outcome: StorageOutcome): { state: GalleryPreferencesState; result: PreferenceResult } {
  return {
    state: { preferences, remember, storageStatus: outcome.status, ...(!outcome.result.ok ? { storageMessage: outcome.result.message } : {}) },
    result: outcome.result,
  }
}

/** Only explicit user actions enter this transition; reads and responsive/URL state do not. */
export function updateGalleryPreferences(state: GalleryPreferencesState, action: GalleryPreferenceAction, access: StorageAccess = browserStorage): { state: GalleryPreferencesState; result: PreferenceResult } {
  let preferences = state.preferences
  switch (action.type) {
    case 'layout':
      if (!validLayout(action.mode)) return { state, result: { ok: false, reason: 'invalid', message: '请选择有效的布局模式。' } }
      if (preferences.layout !== action.mode) preferences = freezePreferences({ ...preferences, layout: action.mode })
      break
    case 'sidebar':
      if ((action.device !== 'desktop' && action.device !== 'mobile') || typeof action.open !== 'boolean') return { state, result: { ok: false, reason: 'invalid', message: '侧栏偏好无效。' } }
      if (preferences.sidebar[action.device] !== action.open) preferences = freezePreferences({ ...preferences, sidebar: { ...preferences.sidebar, [action.device]: action.open } })
      break
    case 'gateways': {
      let gateways: string[]
      try { gateways = normalizedGateways(action.gateways) }
      catch { return { state, result: { ok: false, reason: 'invalid', message: '请提供数量及长度符合限制的公共 HTTPS 网关，不得包含凭据、查询、片段或不安全路径。' } } }
      if (gateways.length !== preferences.gateways.length || gateways.some((url, index) => url !== preferences.gateways[index])) preferences = freezePreferences({ ...preferences, gateways })
      break
    }
    case 'remember':
      if (typeof action.enabled !== 'boolean') return { state, result: { ok: false, reason: 'invalid', message: '保存选项无效。' } }
      return completed(preferences, action.enabled, action.enabled ? writeGalleryPreferences(preferences, access) : removeGalleryPreferences(access))
    case 'clear':
      return completed(defaultGalleryPreferences(), false, removeGalleryPreferences(access))
  }
  return state.remember ? completed(preferences, true, writeGalleryPreferences(preferences, access)) : { state: { ...state, preferences }, result: { ok: true } }
}
