import { lazy } from 'react'
import { CheckIcon } from '@phosphor-icons/react'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Divider from '@mui/material/Divider'
import type { GalleryMode, GalleryPanel, ReaderAssetBinding } from '../app/readerAlbumTypes'
import type { GalleryItem, ParsedLocation, ViewState } from '../shared/contracts'
import type { GallerySnapshot } from '../hooks/galleryController'
import type { GalleryPreferencesController } from '../hooks/useGalleryPreferences'
import { contentAddress, sourceAddresses } from '../app/format'
import { Action, ErrorDetail } from './Primitives'
import { SourceForm } from './SourceForm'
import { Filters } from './Filters'
import { LazyDialog } from './LazyDialog'

const LazyNetworkSettings = lazy(() => import('./NetworkSettings').then(module => ({ default: module.NetworkSettings })))

export function GalleryMenu({ mode, hasItem, hasSource, partial, warningCount, onMode, onPanel, onDownload, onShare }: {
  mode: GalleryMode; hasItem: boolean; hasSource: boolean; partial: boolean; warningCount: number
  onMode: (mode: GalleryMode) => void; onPanel: (panel: Exclude<GalleryPanel, null>) => void; onDownload: () => void; onShare: () => void
}) {
  return <List component="div" disablePadding className="gallery-menu">
    <div role="group" aria-label="观看模式">
      {([['reader', '阅读'], ['album', '相册']] as const).map(([value, label]) => <ListItemButton disableRipple component="button" type="button" key={value} aria-pressed={mode === value} onClick={() => onMode(value)}>{mode === value && <CheckIcon aria-hidden="true" />}{label}{mode === value && ' · 当前模式'}</ListItemButton>)}
    </div>
    <Divider className="gallery-divider" />
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('source')}>{partial ? '来源 · 部分内容可用' : '来源'}</ListItemButton>
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('filters')}>搜索与筛选</ListItemButton>
    <ListItemButton disableRipple component="button" type="button" disabled={!hasItem} onClick={() => onPanel('info')}>当前影像信息</ListItemButton>
    <ListItemButton disableRipple component="button" type="button" disabled={!hasItem} onClick={onDownload}>阅读工具与下载</ListItemButton>
    {!hasItem && <p className="help">选中影像后可查看信息与下载。</p>}
    <Divider className="gallery-divider" />
    <ListItemButton disableRipple component="button" type="button" disabled={!hasSource} onClick={onShare}>复制分享链接</ListItemButton>
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('network')}>网络</ListItemButton>
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('network')}>此浏览器的偏好</ListItemButton>
    {warningCount > 0 && <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('source')}>来源提示与失败 · {warningCount} 项</ListItemButton>}
  </List>
}

export function GallerySourcePanel({ location, snapshot, pending, offline, onSubmit, onInvalid, onCancel, onRetry, onNetwork, onBrowse }: {
  location: ParsedLocation; snapshot: GallerySnapshot; pending: boolean; offline: boolean
  onSubmit: (next: ParsedLocation) => void; onInvalid: (error: unknown) => void; onCancel: () => void; onRetry: () => void; onNetwork: () => void; onBrowse: () => void
}) {
  const metadataError = snapshot.error?.code === 'INVALID_METADATA' || snapshot.result?.warnings.some(error => error.code === 'INVALID_METADATA')
  return <div>
    {pending && <p className="source-progress" role="status">正在读取来源…{snapshot.progress && ` 已处理 ${snapshot.progress.completed} 项${snapshot.progress.total === undefined ? '' : ` / ${snapshot.progress.total}`}`}</p>}
    <SourceForm key={JSON.stringify(location.input)} location={location} loading={pending} compact={false} expanded onExpand={() => {}} onRetry={onRetry} onCancel={onCancel} onSubmit={onSubmit} onInvalid={onInvalid} inputError={snapshot.error?.code === 'INVALID_INPUT' ? snapshot.error.message : undefined} />
    {offline && <p className="warning-text" role="status">浏览器报告离线；这不代表网关实测状态。</p>}
    {location.notices.length > 0 && <ul className="notices">{location.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
    {location.input && <details className="source-details"><summary>当前来源</summary><ul>{sourceAddresses(location).map(address => <li className="cid" key={address}>{address}</li>)}</ul></details>}
    {snapshot.error && snapshot.error.code !== 'INVALID_INPUT' && <ErrorDetail error={snapshot.error} />}
    {snapshot.result && <section className="source-summary"><h3>{snapshot.result.title || '当前来源'}</h3>{snapshot.result.description && <p className="description">{snapshot.result.description}</p>}<p>{snapshot.result.partial ? '已读取' : '共'} {snapshot.result.items.length} 项{snapshot.result.partial ? ' · 部分内容可用' : ''}</p></section>}
    {!!snapshot.result?.warnings.length && <details className="warning-details"><summary>来源提示与失败 · {snapshot.result.warnings.length} 项</summary>{snapshot.result.warnings.map((error, index) => <ErrorDetail key={index} error={error} />)}</details>}
    <div className="actions panel-actions"><Action disabled={!location.input || snapshot.error?.code === 'INVALID_INPUT'} onClick={onRetry}>重新读取来源</Action><Action onClick={onNetwork}>检查网络与网关</Action>{metadataError && location.input?.source.kind !== 'manifest' && <Action onClick={onBrowse}>按目录浏览</Action>}</div>
  </div>
}

export function GalleryFiltersPanel(props: {
  items: GalleryItem[]; view: ViewState; count: number; partial: boolean; disabled: boolean; sort: string; onSort: (sort: string) => void; onChange: (patch: Partial<ViewState>) => void; viewError: string
}) {
  return <><Filters {...props} />{props.viewError && <p className="error-text" role="alert">{props.viewError}</p>}</>
}

export function GalleryInfoPanel({ item, asset, notice, onCopy }: { item: GalleryItem | undefined; asset: ReaderAssetBinding; notice: string; onCopy: (value: string, label: string) => void }) {
  if (!item) return <p>当前没有选中的影像。</p>
  const verified = asset.state.asset?.active ? asset.state.asset : undefined
  return <div className="gallery-info"><h3>{item.title}</h3>{item.alt && <p className="description">{item.alt}</p>}
    <dl><dt>来源</dt><dd>{item.sourceLabel}</dd><dt>原始内容地址</dt><dd className="cid">{contentAddress(item.ref)}</dd><dt>CID</dt><dd className="cid">{item.ref.cid}</dd>
      {!!item.tags.length && <><dt>标签</dt><dd>{item.tags.join(' / ')}</dd></>}
      {verified && <><dt>已验证原始媒体</dt><dd>{verified.mime} · {verified.byteLength.toLocaleString('zh-CN')} 字节{verified.width && verified.height ? ` · ${verified.width} × ${verified.height}` : ''}</dd></>}
    </dl>
    <p className="help">{verified ? '信息借用当前阅读器的验证结果；下载使用相同验证字节。' : '原始媒体尚未在当前阅读器中验证；这里不会另行下载媒体。'}</p>
    <div className="actions panel-actions"><Action onClick={() => onCopy(item.ref.cid, ' CID')}>复制 CID</Action><Action onClick={() => onCopy(contentAddress(item.ref), '原始地址')}>复制原始地址</Action></div>
    {notice && <p className="panel-notice" role="status">{notice}</p>}
  </div>
}

export function GalleryNetworkPanel(props: { open: boolean; location: ParsedLocation; snapshot: GallerySnapshot; preferences: GalleryPreferencesController; effectiveGateways: readonly string[]; onApply: (next: ParsedLocation) => void; onClose: () => void }) {
  return <LazyDialog Content={LazyNetworkSettings} title="网络设置" componentProps={{ ...props, open: true, stats: props.snapshot.gateways }} />
}
