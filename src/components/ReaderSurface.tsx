import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftIcon, ArrowRightIcon, ArrowsInIcon, CopyIcon, DownloadSimpleIcon, InfoIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react'
import type { ReaderSurfaceProps } from '../app/readerAlbumTypes'
import { BUILD_POLICY } from '../shared/build-policy'
import { clampReaderPan, clampReaderZoom, ignoresReaderInteraction, ReaderGestureTracker, READER_ZOOM, type ReaderSize, type ReaderTransform } from '../hooks/readerInteraction'
import { contentAddress } from '../app/format'
import { ReaderDownloadScope } from './readerDownload'
import { ErrorDetail } from './Primitives'
import './reader.css'

const fitted: ReaderTransform = { scale: 1, pan: { x: 0, y: 0 } }

export function ReaderSurface(props: ReaderSurfaceProps) {
  const [gestures] = useState(() => new ReaderGestureTracker())
  return <ReaderSession key={`${props.sessionId}:${props.item.id}:${contentAddress(props.item.ref)}`} {...props} gestures={gestures} />
}

function ReaderSession({ item, items, asset: binding, service, sessionId, toolsHost, toolsPaintHost, modalOpen, onSelect, onOpenMenu, onOpenInfo, gestures }: ReaderSurfaceProps & { gestures: ReaderGestureTracker }) {
  const stage = useRef<HTMLElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const currentTransform = useRef<ReaderTransform>(fitted)
  const activeBox = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const downloadScope = useRef<ReaderDownloadScope | null>(null)
  const tools = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState<ReaderTransform>(fitted)
  const [decodedUrl, setDecodedUrl] = useState<string>()
  const [failedUrl, setFailedUrl] = useState<string>()
  const [decodeAttempt, setDecodeAttempt] = useState(0)
  const [notice, setNotice] = useState('')
  const [downloading, setDownloading] = useState(false)
  const instructionId = useId()
  const asset = binding.state.asset?.active ? binding.state.asset : undefined
  const url = asset?.url
  const failed = !!url && failedUrl === url
  const decoded = !!url && decodedUrl === url && !failed
  const error = binding.state.error
  const unavailable = !service || !sessionId
  const index = items.findIndex(value => value.id === item.id)
  const previous = index > 0 ? items[index - 1] : undefined
  const next = index >= 0 ? items[index + 1] : undefined

  useLayoutEffect(() => {
    const scope = new ReaderDownloadScope(service, item, setNotice, setDownloading)
    downloadScope.current = scope
    const cancelGesture = () => { activeBox.current = null; gestures.cancel() }
    window.addEventListener('blur', cancelGesture)
    return () => {
      window.removeEventListener('blur', cancelGesture)
      cancelGesture()
      scope.dispose()
      if (downloadScope.current === scope) downloadScope.current = null
    }
  }, [service, sessionId, item, gestures])

  useLayoutEffect(() => {
    if (modalOpen) {
      activeBox.current = null
      gestures.cancel()
    }
  }, [modalOpen, gestures])

  const toolsAvailable = !!toolsHost?.isConnected && !!toolsHost.closest('[role="dialog"][aria-hidden="false"]') && !toolsHost.closest('[inert],[hidden]')
  useLayoutEffect(() => {
    if (!toolsAvailable || !toolsHost) return
    const dialog = toolsHost.closest('[role="dialog"]')
    const focused = document.activeElement
    if (focused === dialog?.querySelector('[data-modal-close]') || focused === dialog?.querySelector('#gallery-panel-title') || focused === dialog) {
      tools.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    }
  }, [toolsHost, toolsAvailable])

  useLayoutEffect(() => {
    const node = tools.current
    if (!node || !toolsPaintHost || !toolsAvailable) return
    toolsPaintHost.replaceChildren()
    return () => {
      if (!toolsPaintHost.isConnected) return
      const paint = node.cloneNode(true) as HTMLElement
      paint.removeAttribute('data-reader-tools')
      toolsPaintHost.replaceChildren(paint)
    }
  }, [toolsPaintHost, toolsAvailable])

  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    if (!viewport) return
    const sides = ['top', 'right', 'bottom', 'left'] as const
    const previous = sides.map(side => root.style.getPropertyValue(`--overlay-${side}`))
    let rafId = 0
    let customModified = false
    // Native pinch moves the visible viewport without resizing fixed media.
    const updatePosition = () => {
      rafId = 0
      if (viewport.scale <= 1) {
        if (!customModified) return
        customModified = false
        sides.forEach((side, index) => {
          if (previous[index]) root.style.setProperty(`--overlay-${side}`, previous[index])
          else root.style.removeProperty(`--overlay-${side}`)
        })
        return
      }
      customModified = true
      const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1
      const offsets = {
        top: viewport.offsetTop,
        left: viewport.offsetLeft,
        right: Math.max(0, innerWidth - viewport.offsetLeft - viewport.width),
        bottom: Math.max(0, innerHeight - viewport.offsetTop - viewport.height),
      }
      for (const side of sides) root.style.setProperty(`--overlay-${side}`, `calc(var(--safe-${side}) + var(--overlay-inset) + ${offsets[side] / zoom}px)`)
    }
    const schedulePosition = () => {
      if (!rafId) rafId = requestAnimationFrame(updatePosition)
    }
    updatePosition()
    viewport.addEventListener('resize', schedulePosition)
    viewport.addEventListener('scroll', schedulePosition)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      viewport.removeEventListener('resize', schedulePosition)
      viewport.removeEventListener('scroll', schedulePosition)
      if (customModified) {
        sides.forEach((side, index) => {
          if (previous[index]) root.style.setProperty(`--overlay-${side}`, previous[index])
          else root.style.removeProperty(`--overlay-${side}`)
        })
      }
    }
  }, [])

  const geometry = (): { viewport: ReaderSize; media: ReaderSize } => {
    const box = activeBox.current ?? stage.current?.getBoundingClientRect()
    const viewport = { width: box?.width ?? 0, height: box?.height ?? 0 }
    const media = { width: image.current?.naturalWidth || asset?.width || viewport.width, height: image.current?.naturalHeight || asset?.height || viewport.height }
    return { viewport, media }
  }
  const applyTransform = (value: ReaderTransform) => {
    currentTransform.current = value
    setTransform(value)
  }
  const zoom = (value: number, fromTools = false) => {
    if ((modalOpen && !(fromTools && toolsAvailable)) || asset?.kind !== 'image' || !decoded) return
    activeBox.current = null
    gestures.cancel()
    const scale = clampReaderZoom(value)
    applyTransform({ scale, pan: { x: 0, y: 0 } })
  }

  useEffect(() => {
    const element = stage.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const box = element.getBoundingClientRect()
      const viewport = { width: box.width, height: box.height }
      const media = { width: image.current?.naturalWidth || viewport.width, height: image.current?.naturalHeight || viewport.height }
      const current = currentTransform.current
      const pan = clampReaderPan(current.pan, current.scale, viewport, media)
      if (pan.x !== current.pan.x || pan.y !== current.pan.y) {
        const value = { scale: current.scale, pan }
        currentTransform.current = value
        setTransform(value)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const point = (event: PointerEvent<HTMLElement>) => {
    const box = activeBox.current ?? event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }
  }
  const pointerDown = (event: PointerEvent<HTMLElement>) => {
    if (modalOpen || ignoresReaderInteraction(event.target) || event.button !== 0) return
    const box = event.currentTarget.getBoundingClientRect()
    activeBox.current = { left: box.left, top: box.top, width: box.width, height: box.height }
    gestures.start(event.pointerId, point(event), event.pointerType, event.timeStamp, currentTransform.current)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const pointerMove = (event: PointerEvent<HTMLElement>) => {
    if (modalOpen || ignoresReaderInteraction(event.target)) return
    const { viewport, media } = geometry()
    const value = gestures.move(event.pointerId, point(event), viewport, media)
    if (value && asset?.kind === 'image' && decoded) applyTransform(value)
  }
  const pointerUp = (event: PointerEvent<HTMLElement>) => {
    if (modalOpen || ignoresReaderInteraction(event.target)) return
    const kind = gestures.end(event.pointerId, point(event), event.timeStamp)
    activeBox.current = null
    if (kind === 'previous' && previous) onSelect(previous.id)
    if (kind === 'next' && next) onSelect(next.id)
  }
  const retry = () => {
    if (modalOpen) return
    activeBox.current = null
    gestures.cancel()
    applyTransform(fitted)
    setDecodedUrl(undefined)
    setFailedUrl(undefined)
    setDecodeAttempt(value => value + 1)
    setNotice('')
    binding.retry()
  }

  async function copy(value: string, label: string) {
    const scope = downloadScope.current
    if (!scope?.active || !toolsAvailable) return
    try {
      await navigator.clipboard.writeText(value)
      if (scope.active && downloadScope.current === scope) setNotice(`已复制${label}。`)
    } catch {
      if (!scope.active || downloadScope.current !== scope) return
      setNotice(`复制失败；请手动复制：${value}。也可打开信息面板查看。`)
    }
  }

  async function download(fromTools = false) {
    const scope = downloadScope.current
    if (!scope || !asset?.active || (modalOpen && !(fromTools && toolsAvailable))) return
    await scope.download(asset)
  }

  const showState = !decoded || failed || !!error || unavailable

  return <><div className={`reader-surface${asset?.kind === 'video' ? ' reader-surface--video' : ''}`} inert={modalOpen}>
    <section id="reader-surface" className={`reader-stage${transform.scale > 1 ? ' reader-stage--zoomed' : ''}${asset?.kind === 'video' ? ' reader-stage--video' : ''}`} ref={stage}
      aria-label={`阅读区：${item.title}`} aria-describedby={instructionId} aria-busy={!decoded && !failed && !error && !unavailable} tabIndex={0} data-reader-stage
      onKeyDown={event => {
        if (modalOpen || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || ignoresReaderInteraction(event.target) || gestures.active) return
        if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); event.stopPropagation(); onOpenMenu() }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation()
          const selected = event.key === 'ArrowLeft' ? previous : next
          if (selected) onSelect(selected.id)
        }
      }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={() => { activeBox.current = null; gestures.cancel() }}
      onLostPointerCapture={event => { activeBox.current = null; if (gestures.hasPointer(event.pointerId)) gestures.cancel() }}
      onContextMenu={() => { activeBox.current = null; gestures.cancel() }}
      onClick={event => {
        if (modalOpen || ignoresReaderInteraction(event.target)) return
        if (gestures.consumeClick()) { event.preventDefault(); event.stopPropagation(); return }
      }}
      onDoubleClick={event => {
        if (modalOpen || ignoresReaderInteraction(event.target) || asset?.kind !== 'image' || !decoded || gestures.consumeClick()) return
        event.preventDefault()
        zoom(currentTransform.current.scale > 1 ? READER_ZOOM.min : READER_ZOOM.min + READER_ZOOM.step * 2)
      }}>
      <span id={instructionId} className="reader-instructions">按 Enter 或 M 打开菜单，Tab 进入菜单按钮，左右方向键翻页。双击或多指缩放，放大后拖动查看；未放大时滑动翻页。普通轻触不执行操作。视频保留原生控制。</span>
      {asset && !failed && (asset.kind === 'image'
        ? <img key={`${url}:${decodeAttempt}`} ref={image} className="reader-media" data-reader-media src={asset.url} alt={item.alt || item.title}
          width={asset.width} height={asset.height} decoding="async" fetchPriority="high" draggable={false}
          style={{ transform: `translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.scale})` }}
          onLoad={event => { if (asset.active && event.currentTarget.isConnected) setDecodedUrl(asset.url) }}
          onError={event => { if (asset.active && event.currentTarget.isConnected) setFailedUrl(asset.url) }} />
        : <video key={`${url}:${decodeAttempt}`} className="reader-media" data-reader-media src={asset.url} aria-label={item.alt || item.title}
          width={asset.width} height={asset.height} controls playsInline preload="metadata"
          onLoadedMetadata={event => { if (asset.active && event.currentTarget.isConnected) setDecodedUrl(asset.url) }}
          onError={event => { if (asset.active && event.currentTarget.isConnected) setFailedUrl(asset.url) }} />)}
    </section>

    {showState && <section className="reader-state" aria-label="原始媒体状态" data-reader-state>
      {error ? <><h2>媒体读取失败</h2><ErrorDetail error={error} /></>
        : failed ? <><h2>无法解码此媒体</h2><p role="alert">该媒体暂无法直接显示，但可直接下载。</p></>
          : unavailable ? <><h2>媒体暂不可用</h2><p role="alert">媒体读取服务未就绪。</p></>
            : <p role="status">{asset ? '正在准备显示…' : (BUILD_POLICY.trustless ? '正在加载与校验媒体…' : '正在加载与检查媒体…')}</p>}
      {(error || failed || unavailable) && <div className="reader-state-actions">
        <button type="button" disabled={modalOpen || unavailable} onClick={retry}>重试加载</button>
        {asset && <button type="button" disabled={modalOpen || downloading} onClick={() => void download()}>下载原文件</button>}
        <button type="button" disabled={modalOpen} onClick={onOpenInfo}>查看详情</button>
      </div>}
      {notice && <p className="reader-notice" role="status">{notice}</p>}
    </section>}

  </div>
    {toolsAvailable && toolsHost && createPortal(<div ref={tools} className="reader-tools" data-reader-tools aria-label="阅读工具">
      <h3>{item.title}</h3>
      <nav className="reader-tool-row" aria-label="影像顺序">
        <button type="button" aria-label="上一项" disabled={!previous} onClick={() => previous && onSelect(previous.id)}><ArrowLeftIcon aria-hidden="true" /></button>
        <span className="reader-position">{index < 0 ? '当前项不在筛选结果中' : `${index + 1} / ${items.length}`}</span>
        <button type="button" aria-label="下一项" disabled={!next} onClick={() => next && onSelect(next.id)}><ArrowRightIcon aria-hidden="true" /></button>
      </nav>
      {asset?.kind === 'image' && <div className="reader-tool-row" role="group" aria-label="图片缩放">
        <button type="button" aria-label="缩小图片" disabled={!decoded || transform.scale <= READER_ZOOM.min} onClick={() => zoom(transform.scale - READER_ZOOM.step, true)}><MinusIcon aria-hidden="true" /></button>
        <output className="reader-position" aria-label="缩放比例">{Math.round(transform.scale * 100)}%</output>
        <button type="button" aria-label="放大图片" disabled={!decoded || transform.scale >= READER_ZOOM.max} onClick={() => zoom(transform.scale + READER_ZOOM.step, true)}><PlusIcon aria-hidden="true" /></button>
        <button type="button" aria-label="复位图片" disabled={!decoded || transform.scale === 1} onClick={() => zoom(1, true)}><ArrowsInIcon aria-hidden="true" /></button>
      </div>}
      <div className="reader-tool-row" role="group" aria-label="当前媒体操作">
        <button type="button" aria-label={BUILD_POLICY.trustless ? '下载经过验证的原始媒体' : '下载原始媒体'} disabled={!asset || unavailable || downloading} onClick={() => void download(true)}><DownloadSimpleIcon aria-hidden="true" /><span>下载</span></button>
        <button type="button" aria-label="复制 CID" onClick={() => void copy(item.ref.cid, ' CID')}><CopyIcon aria-hidden="true" /><span>CID</span></button>
        <button type="button" aria-label="复制原始地址" onClick={() => void copy(contentAddress(item.ref), '原始地址')}>地址</button>
        <button type="button" aria-label="影像详情" onClick={onOpenInfo}><InfoIcon aria-hidden="true" /><span>信息</span></button>
      </div>
      {notice && <p className="reader-notice" role="status">{notice}</p>}
      {!asset && <p className="reader-notice">{error || unavailable ? '原始媒体不可用，请关闭面板重试读取。' : (BUILD_POLICY.trustless ? '等待原始字节验证后可下载。' : '等待原始媒体准备后可下载。')}</p>}
    </div>, toolsHost)}
  </>
}
