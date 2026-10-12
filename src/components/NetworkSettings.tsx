import { useState } from 'react'
import { PlusIcon, XIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import type { GatewayStat, ParsedLocation } from '../shared/contracts'
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
    <p id="gateway-help">仅向当前实际启用的网关发送请求，自动负载均衡与失败回退。下方编辑需点应用，才会更新本地网关偏好并重新读取当前来源。</p>
    {location.gateways.length > 0 && <p className="help">当前网关来自分享地址，优先于本地偏好。开启保存或清除设置不会覆盖此地址；只有明确应用网关才会将编辑值设为本地偏好。</p>}
    <div className="gateway-editor">{rows.map((row, index) => <div className="gateway-row" key={row.id}>
      <label className="gateway-enable"><input type="checkbox" checked={row.enabled} aria-label={`启用网关 ${index + 1}`} onChange={event => setDraft(previous => ({ ...previous, rows: previous.rows.map(value => value.id === row.id ? { ...value, enabled: event.target.checked } : value) }))} />启用</label>
      <label className="gateway-url"><span className="sr-only">网关 {index + 1} HTTPS 地址</span><input type="url" value={row.url} placeholder="HTTPS 网关基地址" spellCheck={false} maxLength={4096} aria-invalid={!!error && row.enabled} aria-describedby={`gateway-help${error ? ' gateway-error' : ''}`} onChange={event => { setApplied(false); setError(''); setDraft(previous => ({ ...previous, rows: previous.rows.map(value => value.id === row.id ? { ...value, url: event.target.value } : value) })) }} /></label>
      <Action aria-label={`移除网关 ${index + 1}`} onClick={() => setDraft(previous => ({ ...previous, rows: previous.rows.filter(value => value.id !== row.id) }))}><XIcon aria-hidden="true" /></Action>
    </div>)}</div>
    <div className="actions"><Action disabled={rows.length >= DEFAULT_LIMITS.maxGateways} startIcon={<PlusIcon aria-hidden="true" />} onClick={() => setDraft(previous => ({ ...previous, rows: [...previous.rows, { id: previous.nextId, url: '', enabled: true }], nextId: previous.nextId + 1 }))}>添加网关</Action><Action startIcon={<ArrowCounterClockwiseIcon aria-hidden="true" />} onClick={() => apply(true)}>恢复默认并应用</Action></div>
    {error && <p id="gateway-error" className="error-text" role="alert">{error}</p>}
    {applied && <p role="status">网关已在本次访问中应用；浏览器保存结果见下方。</p>}
    <section aria-labelledby="preferences-title"><h3 id="preferences-title">此浏览器的偏好</h3>
      <label className="gateway-enable"><input type="checkbox" checked={preferences.remember} aria-describedby="preferences-help preferences-storage-status" onChange={event => preferences.setRemember(event.target.checked)} />保存设置到此浏览器</label>
      <p id="preferences-help" className="help">仅保存已有布局、桌面／手机侧栏和已应用的本地网关偏好，不保存来源、筛选、媒体或统计。布局与侧栏值保留，但不控制当前单幅阅读器、相册或工具显隐。保存开关与清除立即生效；取消仅放弃尚未应用的网关草稿。</p>
      <p id="preferences-storage-status" className={storageError ? 'error-text' : 'help'} role={storageError ? 'alert' : 'status'}>{preferences.storageMessage ?? storageLabels[preferences.storageStatus]}</p>
      <div className="actions">
        {preferences.remember && storageError && <Action onClick={() => preferences.setRemember(true)}>重试保存当前本地偏好</Action>}
        {!preferences.remember && (preferences.storageStatus === 'remove-failed' || preferences.storageStatus === 'unavailable') && <Action onClick={() => preferences.setRemember(false)}>重试删除已保存设置</Action>}
        <Action onClick={() => preferences.clearSavedPreferences()}>清除已保存设置并恢复默认</Action>
      </div>
    </section>
    <section><h3>当前来源的请求统计</h3><p className="help">仅代表本次浏览器请求；“未检查”不等于不可用，成功不代表 IPFS 全网在线。</p>
      <ul className="gateway-stats">{effectiveGateways.map(url => {
        const stat = stats.find(value => value.url === url)
        const measured = stat && stat.successes + stat.failures > 0
        const status = !stat || !measured ? (stat?.inFlight ? '检查中' : '未检查') : stat.state === 'cooldown' ? '暂时冷却' : stat.state === 'probing' ? '恢复检查中' : stat.successes ? '本次请求可用' : '无法确认'
        return <li key={url}><strong className="cid">{url}</strong><span>{status}</span>{stat && <span>成功 {stat.successes} · 失败 {stat.failures} · 在途 {stat.inFlight}{stat.ewmaMs === undefined ? '' : ` · 平均响应 ${Math.round(stat.ewmaMs)} ms`}{stat.cooldownUntil ? ` · 冷却至 ${new Date(stat.cooldownUntil).toLocaleTimeString('zh-CN')}` : ''}</span>}</li>
      })}</ul>
    </section>
    <section className="privacy-note"><h3>隐私与资源边界</h3><p>网关可看到请求的 CID、IP 地址与时间。完整性验证不等于保密或媒体安全审核。不发送分析，不保存媒体或 CID 历史；分享地址仍包含当前来源。</p><p>仅允许公共 HTTPS 网关；浏览器无法保证域名 DNS 不映射到私网。来源中的文本不会作为 HTML 执行。</p><p>单媒体最多 {DEFAULT_LIMITS.maxAssetBytes / 1024 / 1024} MiB，Blob 缓存 {DEFAULT_LIMITS.maxBlobCacheBytes / 1024 / 1024} MiB，同时最多 {DEFAULT_LIMITS.maxAssetConcurrency} 个媒体任务。单网关超时 {DEFAULT_LIMITS.gatewayTimeoutMs / 1000} 秒，来源超时 {DEFAULT_LIMITS.discoveryTimeoutMs / 1000} 秒，媒体超时 {DEFAULT_LIMITS.assetTimeoutMs / 1000} 秒。视频完整验证后才可播放。</p></section>
    <footer className="actions"><Action variant="contained" onClick={() => apply()}>应用并重新读取</Action><Action onClick={close}>取消</Action></footer>
  </div>
}
