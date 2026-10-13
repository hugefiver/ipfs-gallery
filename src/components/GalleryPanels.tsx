import { lazy } from 'react'
import {
  BookOpenIcon,
  DownloadSimpleIcon,
  FolderIcon,
  GearIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  ShareNetworkIcon,
  SquaresFourIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
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
      {([['reader', '阅读'], ['album', '相册']] as const).map(([value, label]) => <ListItemButton disableRipple component="button" type="button" key={value} aria-pressed={mode === value} onClick={() => onMode(value)}>{value === 'reader' ? <BookOpenIcon aria-hidden="true" /> : <SquaresFourIcon aria-hidden="true" />}{label}{mode === value && ' · 当前模式'}</ListItemButton>)}
    </div>
    <Divider className="gallery-divider" />
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('source')}><FolderIcon aria-hidden="true" /><span>{partial ? '来源 (部分可用)' : '来源'}</span></ListItemButton>
    <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('filters')}><MagnifyingGlassIcon aria-hidden="true" /><span>搜索与筛选</span></ListItemButton>
    <ListItemButton disableRipple component="button" type="button" disabled={!hasItem} onClick={() => onPanel('info')}><InfoIcon aria-hidden="true" /><span>当前影像信息</span></ListItemButton>
    <ListItemButton disableRipple component="button" type="button" disabled={!hasItem} onClick={onDownload}><DownloadSimpleIcon aria-hidden="true" /><span>阅读工具与下载</span></ListItemButton>
    {!hasItem && <p className="help">选择影像后可查看详情与下载。</p>}
    <Divider className="gallery-divider" />
    <ListItemButton disableRipple component="button" type="button" disabled={!hasSource} onClick={onShare}><ShareNetworkIcon aria-hidden="true" /><span>复制分享链接</span></ListItemButton>
    <ListItemButton disableRipple component="button" type="button" aria-label="网络" onClick={() => onPanel('network')}><GearIcon aria-hidden="true" /><span>网络与偏好设置</span></ListItemButton>
    {warningCount > 0 && <ListItemButton disableRipple component="button" type="button" onClick={() => onPanel('source')}><WarningCircleIcon aria-hidden="true" /><span>来源提示 · {warningCount} 项</span></ListItemButton>}
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
    {offline && <p className="warning-text" role="status">当前网络处于离线状态。</p>}
    {location.notices.length > 0 && <ul className="notices">{location.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
    {location.input && <details className="source-details"><summary>来源详情</summary><ul>{sourceAddresses(location).map(address => <li className="cid" key={address}>{address}</li>)}</ul></details>}
    {snapshot.error && snapshot.error.code !== 'INVALID_INPUT' && <ErrorDetail error={snapshot.error} />}
    {snapshot.result && <section className="source-summary"><h3>{snapshot.result.title || '当前来源'}</h3>{snapshot.result.description && <p className="description">{snapshot.result.description}</p>}<p>共 {snapshot.result.items.length} 项{snapshot.result.partial ? ' (部分可用)' : ''}</p></section>}
    {!!snapshot.result?.warnings.length && <details className="warning-details"><summary>提示与警告 ({snapshot.result.warnings.length})</summary>{snapshot.result.warnings.map((error, index) => <ErrorDetail key={index} error={error} />)}</details>}
    <div className="actions panel-actions"><Action disabled={!location.input || snapshot.error?.code === 'INVALID_INPUT'} onClick={onRetry}>重新读取</Action><Action onClick={onNetwork}>网络设置</Action>{metadataError && location.input?.source.kind !== 'manifest' && <Action onClick={onBrowse}>按目录浏览</Action>}</div>
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
    <p className="help">{verified ? '已在本地完成哈希校验，可直接下载。' : '正在等待媒体验证。'}</p>
    <div className="actions panel-actions"><Action onClick={() => onCopy(item.ref.cid, ' CID')}>复制 CID</Action><Action onClick={() => onCopy(contentAddress(item.ref), '原始地址')}>复制原始地址</Action></div>
    {notice && <p className="panel-notice" role="status">{notice}</p>}
  </div>
}

export function GalleryNetworkPanel(props: { open: boolean; location: ParsedLocation; snapshot: GallerySnapshot; preferences: GalleryPreferencesController; effectiveGateways: readonly string[]; onApply: (next: ParsedLocation) => void; onClose: () => void }) {
  return <LazyDialog Content={LazyNetworkSettings} title="网络设置" componentProps={{ ...props, open: true, stats: props.snapshot.gateways }} />
}
