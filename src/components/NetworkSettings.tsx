import { useState } from 'react'
import { PlusIcon, XIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import type { GatewayStat, ParsedLocation } from '../shared/contracts'
import { BUILD_POLICY } from '../shared/build-policy'
import { DEFAULT_GATEWAYS } from '../shared/gateways'
import { DEFAULT_LIMITS } from '../shared/limits'
import { parseLocation, serializeLocation } from '../core/query'
import { toGalleryError } from '../shared/errors'
import { Action } from './Primitives'
import type { GalleryPreferencesController, StorageStatus } from '../hooks/useGalleryPreferences'
import { normalizeGateway } from '../network/gateways'

type GatewayRow = { id: number; url: string; enabled: boolean }
const gatewayRows = (gateways: readonly string[], firstId = 0): GatewayRow[] => gateways.map((url, index) => ({ id: firstId + index, url, enabled: true }))
const storageLabels: Record<StorageStatus, string> = {
  disabled: '未保存设置到此浏览器。', saved: '当前本地偏好已保存到此浏览器。',
  invalid: '已保存记录无效，已忽略此记录。', unavailable: '无法访问浏览器设置存储。',
  'write-failed': '保存失败，当前偏好仅在本次访问中有效。', 'remove-failed': '删除失败，已停止保存；磁盘记录可能在下次访问恢复。',
}

export function NetworkSettings({ open, location, stats, preferences, effectiveGateways, onApply, onClose }: {
  open: boolean; location: ParsedLocation; stats: GatewayStat[]; preferences: GalleryPreferencesController; effectiveGateways: readonly string[]; onApply: (next: ParsedLocation) => void; onClose: () => void
}) {
  const key = JSON.stringify(effectiveGateways)
  const [draft, setDraft] = useState(() => {
    const rows = gatewayRows(effectiveGateways)
    return { configuration: key, rows, committedRows: rows, nextId: rows.length }
  })
  const [error, setError] = useState('')
  const [applied, setApplied] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) { setDraft(previous => ({ ...previous, rows: previous.committedRows })); setError(''); setApplied(false) }
  }
  if (draft.configuration !== key) {
    const rows = gatewayRows(effectiveGateways, draft.nextId)
    setDraft({ configuration: key, rows, committedRows: rows, nextId: draft.nextId + rows.length })
    setError('')
  }
  const { rows } = draft
  const close = () => { setDraft(previous => ({ ...previous, rows: previous.committedRows })); setError(''); setApplied(false); onClose() }
  function apply(reset = false) {
    try {
      const enabled = rows.filter(row => row.enabled).map(row => row.url.trim())
      if (!reset && (!enabled.length || enabled.some(url => !url))) { setError('至少启用一个填写完整的 HTTPS 公共网关。'); return }
      const next = parseLocation(serializeLocation({ ...location, gateways: reset ? [...DEFAULT_GATEWAYS] : enabled }))
      const result = preferences.applyGateways(reset ? [] : next.gateways)
      if (!result.ok && result.reason === 'invalid') { setError(result.message); return }
      const seen = new Set<string>()
      const nextRows = reset ? gatewayRows(DEFAULT_GATEWAYS, draft.nextId) : rows.flatMap(row => {
        if (!row.enabled) return [row]
        const url = normalizeGateway(row.url)
        if (seen.has(url)) return []
        seen.add(url)
        return [{ ...row, url }]
      })
      setDraft({ configuration: JSON.stringify(reset ? DEFAULT_GATEWAYS : next.gateways), rows: nextRows, committedRows: nextRows, nextId: reset ? draft.nextId + nextRows.length : draft.nextId })
      setError('')
      onApply(next)
      if (result.ok) { setApplied(false); onClose() }
      else setApplied(true)
    } catch (value) { setError(toGalleryError(value).message) }
  }
  const storageError = preferences.storageStatus !== 'disabled' && preferences.storageStatus !== 'saved'
  return <div className="network-settings">
    <p id="gateway-help">请求将在勾选的网关间自动分发与重试。修改后点击“应用”生效。</p>
    {location.gateways.length > 0 && <p className="help">当前使用链接指定的网关。</p>}
    <div className="gateway-editor">{rows.map((row, index) => <div className="gateway-row" key={row.id}>
      <label className="gateway-enable"><input type="checkbox" checked={row.enabled} aria-label={`启用网关 ${index + 1}`} onChange={event => setDraft(previous => ({ ...previous, rows: previous.rows.map(value => value.id === row.id ? { ...value, enabled: event.target.checked } : value) }))} /></label>
      <label className="gateway-url"><span className="sr-only">网关 {index + 1} HTTPS 地址</span><input type="url" value={row.url} placeholder="HTTPS 网关基地址" spellCheck={false} maxLength={4096} aria-invalid={!!error && row.enabled} aria-describedby={`gateway-help${error ? ' gateway-error' : ''}`} onChange={event => { setApplied(false); setError(''); setDraft(previous => ({ ...previous, rows: previous.rows.map(value => value.id === row.id ? { ...value, url: event.target.value } : value) })) }} /></label>
      <Action aria-label={`移除网关 ${index + 1}`} onClick={() => setDraft(previous => ({ ...previous, rows: previous.rows.filter(value => value.id !== row.id) }))}><XIcon aria-hidden="true" /></Action>
    </div>)}</div>
    <div className="actions"><Action disabled={rows.length >= DEFAULT_LIMITS.maxGateways} startIcon={<PlusIcon aria-hidden="true" />} onClick={() => setDraft(previous => ({ ...previous, rows: [...previous.rows, { id: previous.nextId, url: '', enabled: true }], nextId: previous.nextId + 1 }))}>添加网关</Action><Action startIcon={<ArrowCounterClockwiseIcon aria-hidden="true" />} onClick={() => apply(true)}>恢复默认并应用</Action></div>
    {error && <p id="gateway-error" className="error-text" role="alert">{error}</p>}
    {applied && <p role="status">已在本次会话中应用网关。</p>}
    <section aria-labelledby="preferences-title"><h3 id="preferences-title">本地偏好</h3>
      <label className="gateway-enable"><input type="checkbox" checked={preferences.remember} aria-describedby="preferences-help preferences-storage-status" onChange={event => preferences.setRemember(event.target.checked)} />保存设置到此浏览器</label>
      <p id="preferences-help" className="help">仅保存在本地存储中，不会上传任何浏览数据。</p>
      <p id="preferences-storage-status" className={storageError ? 'error-text' : 'help'} role={storageError ? 'alert' : 'status'}>{preferences.storageMessage ?? storageLabels[preferences.storageStatus]}</p>
      <div className="actions">
        {preferences.remember && storageError && <Action onClick={() => preferences.setRemember(true)}>重试保存当前本地偏好</Action>}
        {!preferences.remember && (preferences.storageStatus === 'remove-failed' || preferences.storageStatus === 'unavailable') && <Action onClick={() => preferences.setRemember(false)}>重试删除已保存设置</Action>}
        <Action onClick={() => preferences.clearSavedPreferences()}>清除已保存设置并恢复默认</Action>
      </div>
    </section>
    <section><h3>网关连接状态</h3><p className="help">统计本次会话的请求响应情况。</p>
      <ul className="gateway-stats">{effectiveGateways.map(url => {
        const stat = stats.find(value => value.url === url)
        const measured = stat && stat.successes + stat.failures > 0
        const status = !stat || !measured ? (stat?.inFlight ? '检测中' : '未检测') : stat.state === 'cooldown' ? '暂时冷却' : stat.state === 'probing' ? '恢复中' : stat.successes ? '正常可用' : '响应失败'
        return <li key={url}><strong className="cid">{url}</strong><span>{status}</span>{stat && <span>成功 {stat.successes} · 失败 {stat.failures} · 在途 {stat.inFlight}{stat.ewmaMs === undefined ? '' : ` · 延迟 ${Math.round(stat.ewmaMs)} ms`}</span>}</li>
      })}</ul>
    </section>
    <div className="privacy-note"><p>{BUILD_POLICY.trustless ? '所有影像均在浏览器端进行内容哈希校验。' : '本构建信任当前配置的 HTTPS 网关，不比较其返回块与 CID 的内容哈希；网关可替换清单、目录或媒体内容。动态发现的 WSS／HTTPS provider 仍执行 CID 哈希校验。'}读取时由 Service Worker 优先尝试动态发现的 WSS／HTTPS provider，再回退到配置的 HTTPS 网关。</p></div>
    <footer className="actions"><Action variant="contained" onClick={() => apply()}>应用并重新读取</Action><Action onClick={close}>取消</Action></footer>
  </div>
}
