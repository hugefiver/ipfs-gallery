import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import { galleryTheme } from '../theme/theme'
import { useGallery } from '../hooks/useGallery'
import { useGalleryPreferences } from '../hooks/useGalleryPreferences'
import { useReaderAsset } from '../hooks/useReaderAsset'
import { ignoresReaderInteraction } from '../hooks/readerInteraction'
import type { ParsedLocation, ViewState } from '../shared/contracts'
import type { AlbumBookmark, GalleryMode, GalleryPanel } from './readerAlbumTypes'
import { serializeLocation } from '../core/query'
import { ReaderSurface } from '../components/ReaderSurface'
import { AlbumGrid } from '../components/AlbumGrid'
import { GalleryChrome } from '../components/GalleryChrome'
import { GalleryFiltersPanel, GalleryInfoPanel, GalleryMenu, GalleryNetworkPanel, GallerySourcePanel } from '../components/GalleryPanels'
import { GalleryDrawer } from '../components/GalleryDrawer'
import { Action, ErrorDetail } from '../components/Primitives'
import { filterItems } from './format'
import '../theme/tokens.css'
import './app.css'

const nameCollator = new Intl.Collator('zh-CN')
const panelTitles = { menu: '菜单', source: '影像来源', filters: '搜索与筛选', info: '影像信息', network: '网络与浏览器偏好', readerTools: '阅读工具' } as const
const blocksShortcuts = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),video')
const usableFocus = (target: HTMLElement | null) => !!target?.isConnected && !target.closest('[hidden],[inert]') && target.getClientRects().length > 0
function StatePanel({ title, busy, children }: { title: string; busy?: boolean; children?: ReactNode }) {
  return <section className="gallery-main-state" aria-busy={busy}><h2>{title}</h2>{children}</section>
}

export default function App() {
  const preferences = useGalleryPreferences()
  const gallery = useGallery({ gatewayPreference: preferences.preferences.gateways })
  const { location, snapshot, controller, updateView, openItem } = gallery
  const [mode, setMode] = useState<GalleryMode>('reader')
  const [chromeVisible, setChromeVisible] = useState(false)
  const [panel, setPanel] = useState<GalleryPanel>(null)
  const [paintPanel, setPaintPanel] = useState<GalleryPanel>(null)
  if (panel && paintPanel !== panel) setPaintPanel(panel)
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null)
  const publishToolsHost = useCallback((element: HTMLDivElement | null) => setToolsHost(element), [])
  const [toolsPaintHost, setToolsPaintHost] = useState<HTMLElement | null>(null)
  const publishToolsPaintHost = useCallback((element: HTMLDivElement | null) => setToolsPaintHost(element), [])
  const [sourceVisited, setSourceVisited] = useState(false)
  const [networkVisited, setNetworkVisited] = useState(false)
  const [sort, setSort] = useState('source')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [notice, setNotice] = useState<{ key: string; message: string; value?: string }>({ key: '', message: '' })
  const [offline, setOffline] = useState(() => !navigator.onLine)
  const main = useRef<HTMLElement>(null)
  const returnTarget = useRef<HTMLElement | null>(null)
  const previousPanel = useRef<GalleryPanel>(null)
  const bookmark = useRef<AlbumBookmark | undefined>(undefined)
  const [albumEntryBookmark, setAlbumEntryBookmark] = useState<AlbumBookmark>()
  const chromeFocus = useRef<'first' | 'last' | null>(null)
  const modeFocus = useRef(false)
  const readerFocus = useRef<{ sessionKey: string; itemId: string; origin: HTMLElement } | null>(null)
  const result = snapshot.result
  const sourcePending = snapshot.status === 'loading' || (snapshot.status === 'empty' && !!location.input)
  const invalidInput = snapshot.error?.code === 'INVALID_INPUT'
  const resetKey = `${snapshot.sessionId}:${historyRevision}:${snapshot.status === 'cancelled' ? 'cancelled' : invalidInput ? 'invalid' : ''}`
  const [sessionKey, setSessionKey] = useState(resetKey)
  const [entryKey, setEntryKey] = useState<string>()
  const sourceEntry = invalidInput ? `${resetKey}:invalid` : !location.input ? `${historyRevision}:empty` : undefined
  if (sessionKey !== resetKey) {
    setSessionKey(resetKey)
    setNotice({ key: '', message: '' })
    setSort('source')
    setAlbumEntryBookmark(undefined)
    setMode('reader')
    setChromeVisible(panel === 'network')
    if (panel !== 'network' && panel !== 'source') setPanel(null)
  }
  if (entryKey !== sourceEntry) {
    setEntryKey(sourceEntry)
    if (sourceEntry && (panel !== 'network' || invalidInput)) { setPanel('source'); setSourceVisited(true) }
  }
  const items = result?.items ?? []
  const filtered = useMemo(() => {
    const values = filterItems(result?.items ?? [], location.view)
    return sort === 'name' ? values.sort((a, b) => nameCollator.compare(a.title, b.title)) : values
  }, [result, location.view, sort])
  const invalidSelection = !!location.view.item && !filtered.some(item => item.id === location.view.item)
  const activeItem = invalidSelection ? undefined : location.view.item ? filtered.find(item => item.id === location.view.item) : filtered[0]
  if (panel === 'readerTools' && (mode !== 'reader' || !activeItem)) setPanel(null)
  const mediaContext = { service: controller?.assets, sessionId: snapshot.sessionId }
  const readerAsset = useReaderAsset(mediaContext, activeItem, mode === 'reader' && !!activeItem)
  const collectionKey = JSON.stringify([snapshot.sessionId, location.view.q, location.view.type ?? null, location.view.tags, sort])
  const albumSessionPrefix = `[${JSON.stringify(snapshot.sessionId)},`
  const noticeKey = JSON.stringify([resetKey, activeItem?.id])
  const currentNotice = notice.key === noticeKey ? notice.message : ''
  const copyFallback = notice.key === noticeKey ? notice.value : undefined
  const noticeScope = useRef(noticeKey)
  useLayoutEffect(() => { noticeScope.current = noticeKey }, [noticeKey])
  const metadataError = snapshot.error?.code === 'INVALID_METADATA' || result?.warnings.some(error => error.code === 'INVALID_METADATA')

  const focusMain = useCallback(() => {
    const target = main.current?.querySelector<HTMLElement>('[data-reader-stage], .album-grid') ?? main.current
    target?.focus({ preventScroll: true })
  }, [])
  const hideChrome = useCallback(() => { focusMain(); setChromeVisible(false) }, [focusMain])
  const toggleChrome = useCallback(() => {
    if (panel) return
    if (chromeVisible) hideChrome()
    else setChromeVisible(true)
  }, [panel, chromeVisible, hideChrome])
  const openPanel = useCallback((next: Exclude<GalleryPanel, null>) => {
    if (!panel) returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setChromeVisible(true)
    if (next === 'source') setSourceVisited(true)
    if (next === 'network') setNetworkVisited(true)
    setPanel(next)
  }, [panel])
  const closePanel = useCallback(() => setPanel(null), [])
  const changeFilters = useCallback((patch: Partial<ViewState>) => {
    const view = { ...location.view, ...patch }
    const matches = filterItems(result?.items ?? [], view)
    if (sort === 'name') matches.sort((a, b) => nameCollator.compare(a.title, b.title))
    const item = matches.find(item => item.id === activeItem?.id) ?? matches[0]
    updateView({ ...patch, item: item?.id })
  }, [location.view, result, sort, activeItem?.id, updateView])
  const changeSort = (value: string) => {
    if (activeItem && !location.view.item) openItem(activeItem.id)
    setSort(value)
  }
  const selectReaderItem = useCallback((id: string) => {
    const focused = document.activeElement
    readerFocus.current = null
    if (id !== activeItem?.id && mode === 'reader' && focused instanceof HTMLElement && (focused.matches('[data-reader-stage]') || panel === 'readerTools')) {
      readerFocus.current = { sessionKey: resetKey, itemId: id, origin: focused }
      if (panel === 'readerTools') { setPanel(null); returnTarget.current = null; modeFocus.current = true }
    }
    openItem(id)
  }, [activeItem?.id, panel, mode, resetKey, openItem])
  const selectAlbumItem = useCallback((id: string) => {
    openItem(id)
    setMode('reader')
    setChromeVisible(false)
    modeFocus.current = true
    returnTarget.current = null
  }, [openItem])
  const rememberBookmark = useCallback((next: AlbumBookmark) => { bookmark.current = next }, [])
  const changeMode = (next: GalleryMode) => {
    if (next === 'album') setAlbumEntryBookmark(bookmark.current)
    setMode(next)
    setPanel(null)
    setChromeVisible(true)
    modeFocus.current = true
    returnTarget.current = null
  }
  const openReaderTools = () => {
    if (!activeItem) return
    setMode('reader')
    modeFocus.current = false
    returnTarget.current = null
    setPanel('readerTools')
  }
  const submitSource = (next: ParsedLocation) => {
    returnTarget.current = null
    setPanel(null)
    setChromeVisible(false)
    gallery.navigate(next, 'push')
    modeFocus.current = true
  }
  const rejectInput = (error: unknown) => {
    returnTarget.current = null
    gallery.rejectInput(error)
    setPanel('source')
  }
  function browse() {
    const source = location.input?.source
    if (!source || source.kind === 'manifest') return
    submitSource({ ...location, input: { source: { ...source, browse: true } }, view: { q: '', tags: [] } })
  }
  async function copy(value: string, label: string) {
    const key = noticeKey
    try { await navigator.clipboard.writeText(value); if (noticeScope.current === key) setNotice({ key, message: `已复制${label}。` }) }
    catch { if (noticeScope.current === key) setNotice({ key, message: '复制失败；请选择面板内的完整地址手动复制。', value }) }
  }
  function share() {
    const url = new URL(window.location.href)
    url.search = serializeLocation({ ...location, view: { ...location.view, item: location.view.item ?? activeItem?.id } })
    void copy(url.href, '分享链接')
  }

  useEffect(() => {
    const onOnline = () => setOffline(!navigator.onLine)
    const onHistory = () => {
      bookmark.current = undefined
      returnTarget.current = null
      modeFocus.current = true
      setHistoryRevision(previous => previous + 1)
      setMode('reader')
      setChromeVisible(false)
      setPanel(null)
      setSourceVisited(false)
      setNetworkVisited(false)
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    window.addEventListener('popstate', onHistory)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOnline); window.removeEventListener('popstate', onHistory) }
  }, [])
  useEffect(() => { document.title = result?.title ? `${result.title} · 影像档案` : '影像档案 · IPFS Gallery' }, [result?.title])
  useLayoutEffect(() => { bookmark.current = undefined; returnTarget.current = null; readerFocus.current = null }, [resetKey])
  useLayoutEffect(() => {
    if (previousPanel.current && !panel) {
      const menu = document.querySelector<HTMLElement>('[data-menu-trigger]')
      if (modeFocus.current) focusMain()
      else if (mode === 'reader' && usableFocus(menu)) menu?.focus({ preventScroll: true })
      else if (usableFocus(returnTarget.current)) returnTarget.current?.focus({ preventScroll: true })
      else if (!modeFocus.current && chromeVisible && usableFocus(menu)) menu?.focus({ preventScroll: true })
      else focusMain()
    }
    previousPanel.current = panel
    if (modeFocus.current && !panel) { modeFocus.current = false; focusMain() }
    if (chromeFocus.current && chromeVisible && !panel) {
      const controls = [...document.querySelectorAll<HTMLElement>('[data-gallery-chrome] button')]
        .filter(element => !element.matches(':disabled') && usableFocus(element))
      const direction = chromeFocus.current
      const target = direction === 'last' ? controls.at(-1) : controls[0]
      const entry = target ?? controls[0]
      entry?.focus({ preventScroll: true })
      chromeFocus.current = null
    }
    const selection = readerFocus.current
    if (selection) {
      readerFocus.current = null
      const focused = document.activeElement
      if (selection.sessionKey === resetKey && selection.itemId === activeItem?.id && mode === 'reader' && !panel
        && (focused === selection.origin || focused === document.body || focused === document.documentElement)) {
        const target = main.current?.querySelector<HTMLElement>('[data-reader-stage]')
        target?.focus({ preventScroll: true })
      }
    }
  }, [panel, chromeVisible, mode, focusMain, resetKey, activeItem?.id])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
      if (panel) {
        if (event.key === 'Escape') { event.preventDefault(); closePanel() }
        return
      }
      if (event.key === 'Escape') { if (!blocksShortcuts(event.target)) { event.preventDefault(); hideChrome() } return }
      if (blocksShortcuts(event.target)) return
      if (event.key.toLowerCase() === 'm') {
        if (event.repeat) return
        if (ignoresReaderInteraction(event.target)) return
        event.preventDefault(); if (mode === 'reader') openPanel('menu'); else toggleChrome()
      } else if (event.key === 'Tab' && mode === 'album' && !chromeVisible) {
        event.preventDefault()
        chromeFocus.current = event.shiftKey ? 'last' : 'first'
        setChromeVisible(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel, chromeVisible, mode, openPanel, closePanel, hideChrome, toggleChrome])

  const stateContent = sourcePending ? <StatePanel title="正在读取来源…" busy><p role="status">{snapshot.progress ? `已处理 ${snapshot.progress.completed} 项${snapshot.progress.total === undefined ? '' : ` / ${snapshot.progress.total}`}` : '正在验证内容并读取目录或描述文件。'}</p><div className="actions"><Action onClick={gallery.cancel}>取消读取</Action><Action onClick={() => openPanel('source')}>修改来源</Action><Action onClick={() => openPanel('network')}>网络设置</Action></div></StatePanel>
    : snapshot.status === 'cancelled' ? <StatePanel title="读取已取消"><p>旧媒体已释放，可修改地址或重新读取。</p><div className="actions"><Action onClick={gallery.retry}>重新读取</Action><Action onClick={() => openPanel('source')}>编辑来源</Action></div></StatePanel>
    : snapshot.status === 'error' && !invalidInput ? <StatePanel title="暂时无法读取这个来源">{snapshot.error && <ErrorDetail error={snapshot.error} />}<div className="actions"><Action onClick={gallery.retry}>重试来源</Action><Action onClick={() => openPanel('source')}>编辑地址</Action><Action onClick={() => openPanel('network')}>切换或检查网关</Action>{metadataError && location.input?.source.kind !== 'manifest' && <Action onClick={browse}>按目录浏览</Action>}</div></StatePanel>
    : invalidSelection ? <StatePanel title="未找到深链接中的影像"><p>该稳定 ID 不在当前筛选结果中；来源与筛选保持不变。</p><div className="actions"><Action onClick={gallery.closeItem}>关闭提示</Action><Action onClick={() => openPanel('filters')}>搜索与筛选</Action></div></StatePanel>
    : result && !items.length ? <StatePanel title="这个来源中没有可预览的影像。"><Action onClick={() => openPanel('source')}>编辑来源</Action></StatePanel>
    : result && !filtered.length ? <StatePanel title="没有符合筛选的影像。"><Action onClick={() => changeFilters({ q: '', tags: [], type: undefined })}>清除筛选</Action></StatePanel>
    : !location.input ? <StatePanel title="打开一个影像来源"><p>粘贴 CID 或 IPFS 地址，开始浏览。</p><Action onClick={() => openPanel('source')}>打开来源</Action></StatePanel> : null

  return <ThemeProvider theme={galleryTheme}>
    <div className="app-shell" inert={!!panel}>
      <main className="gallery-main" ref={main} tabIndex={0} aria-label={mode === 'reader' ? '影像阅读区' : '影像相册'} aria-describedby="gallery-instructions" aria-busy={sourcePending}
        onKeyDown={event => { if (!event.defaultPrevented && event.target === event.currentTarget && event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (mode === 'reader') openPanel('menu'); else toggleChrome() } }}>
        <p id="gallery-instructions" className="sr-only">{mode === 'reader' ? '按Enter或M打开菜单，Tab进入持续菜单。Escape关闭面板并返回菜单，左右键在阅读区翻页。' : '按Enter或M显示或隐藏工具，Tab显示工具并进入菜单，Escape关闭面板或隐藏工具。'}</p>
        {mode === 'reader' && activeItem && <ReaderSurface key={`${snapshot.sessionId}:${historyRevision}:${activeItem.id}`} {...mediaContext} item={activeItem} items={filtered} asset={readerAsset} toolsHost={panel === 'readerTools' ? toolsHost : null} toolsPaintHost={toolsPaintHost} modalOpen={!!panel} onSelect={selectReaderItem} onOpenMenu={() => openPanel('menu')} onOpenInfo={() => openPanel('info')} />}
        {mode === 'album' && result && <AlbumGrid {...mediaContext} items={filtered} activeId={activeItem?.id} collectionKey={collectionKey} bookmark={albumEntryBookmark?.collectionKey.startsWith(albumSessionPrefix) ? albumEntryBookmark : undefined} modalOpen={!!panel} onSelect={selectAlbumItem} onBookmark={rememberBookmark} onToggleChrome={toggleChrome} />}
        {stateContent && panel !== 'source' && <div className="gallery-state-overlay">{stateContent}</div>}
      </main>
    </div>
    {!panel && (mode === 'reader' || chromeVisible) && <GalleryChrome mode={mode} menuOpen={false} onMenu={() => openPanel('menu')} onHide={hideChrome} />}
    <GalleryDrawer open={!!panel} onClose={closePanel} title={paintPanel ? panelTitles[paintPanel] : '工具面板'} labelledBy="gallery-panel-title" focusKey={panel} focusTarget={panel === 'source' ? '#source-input' : panel === 'filters' ? 'input[type="search"]' : panel === 'menu' ? '.gallery-menu button' : undefined}>
      {paintPanel === 'menu' && <><GalleryMenu mode={mode} hasItem={!!activeItem} hasSource={!!location.input && !invalidInput} partial={!!result?.partial} warningCount={result?.warnings.length ?? 0} onMode={changeMode} onPanel={openPanel} onDownload={openReaderTools} onShare={share} />{currentNotice && <p className="panel-notice" role="status">{currentNotice}</p>}{copyFallback && <p className="cid">{copyFallback}</p>}</>}
      {panel === 'readerTools' && mode === 'reader' && activeItem && <div ref={publishToolsHost} data-reader-tools-host />}
      {paintPanel === 'readerTools' && <div ref={publishToolsPaintHost} className="reader-tools-exit-paint" hidden={panel === 'readerTools'} aria-hidden="true" inert />}
      {sourceVisited && <div hidden={paintPanel !== 'source'}><GallerySourcePanel location={location} snapshot={snapshot} pending={sourcePending} offline={offline} onSubmit={submitSource} onInvalid={rejectInput} onCancel={gallery.cancel} onRetry={gallery.retry} onNetwork={() => openPanel('network')} onBrowse={browse} /></div>}
      {paintPanel === 'filters' && <GalleryFiltersPanel items={items} view={location.view} count={filtered.length} partial={!!result?.partial} disabled={!result} sort={sort} onSort={changeSort} onChange={changeFilters} viewError={gallery.viewError} />}
      {paintPanel === 'info' && <GalleryInfoPanel item={activeItem} asset={readerAsset} notice={currentNotice} onCopy={(value, label) => void copy(value, label)} />}
      {networkVisited && <div hidden={paintPanel !== 'network'}><GalleryNetworkPanel open={panel === 'network'} location={location} snapshot={snapshot} preferences={preferences} effectiveGateways={gallery.effectiveGateways} onApply={next => { returnTarget.current = null; gallery.navigate(next, 'replace', true) }} onClose={closePanel} /></div>}
    </GalleryDrawer>
  </ThemeProvider>
}
