import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AlbumBookmark, AlbumGridProps, MasonryBox } from '../app/readerAlbumTypes'
import { layoutMasonry } from '../hooks/masonryLayout'
import { ReaderGestureTracker } from '../hooks/readerInteraction'
import { AlbumTile } from './AlbumTile'
import './album.css'

interface Geometry {
  width: number
  columns: number
  gap: number
  fallbackRatio: number
  minimum: number
  videoMinimum: number
  viewportHeight: number
}

function restoreScroll(root: HTMLElement, list: HTMLElement, height: number, inset: number, target: number): number {
  const bottom = Number.parseFloat(getComputedStyle(root).paddingBottom)
  list.style.height = `${Math.max(height, target + root.clientHeight - inset - bottom)}px`
  root.scrollTop = target
  return root.scrollTop
}

function dimensionRatio(width?: number, height?: number): number | undefined {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  const ratio = width / height
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}

function belongsToSession(bookmark: AlbumBookmark | undefined, sessionId: string): boolean {
  if (!bookmark) return false
  try {
    const key: unknown = JSON.parse(bookmark.collectionKey)
    return Array.isArray(key) && key[0] === sessionId
  } catch { return false }
}

function readBookmark(root: HTMLElement, boxes: readonly MasonryBox[], inset: number, collectionKey: string): AlbumBookmark {
  const top = root.scrollTop - inset
  const visible = boxes.filter(box => box.y + box.height > top && box.y < top + root.clientHeight)
  const anchor = visible.reduce<MasonryBox | undefined>((best, box) => {
    return !best || Math.abs(box.y - top) < Math.abs(best.y - top) ? box : best
  }, undefined)
  const focused = root.ownerDocument.activeElement?.closest<HTMLElement>('[data-album-id]')
  return {
    collectionKey,
    scrollTop: root.scrollTop,
    ...(anchor ? { anchorId: anchor.id, anchorOffset: root.scrollTop - inset - anchor.y } : {}),
    ...(focused && root.contains(focused) ? { focusId: focused.dataset.albumId } : {}),
  }
}

export function AlbumGrid({
  items, activeId, collectionKey, bookmark, modalOpen, service, sessionId, onSelect, onBookmark, onToggleChrome,
}: AlbumGridProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLUListElement>(null)
  const previous = useRef<{ sessionId: string; key: string; boxes: MasonryBox[]; height: number; inset: number; modalOpen: boolean } | undefined>(undefined)
  const bookmarkedLayout = useRef<typeof previous.current>(undefined)
  const saved = useRef<AlbumBookmark | undefined>(undefined)
  const appliedScroll = useRef<number | undefined>(undefined)
  const applyingFocus = useRef(false)
  const pendingFocus = useRef<{ key: string; id?: string } | undefined>(undefined)
  const entryFocusClaimed = useRef(false)
  const [gestures] = useState(() => new ReaderGestureTracker())
  const callbacks = useRef({ onSelect, onBookmark, modalOpen })
  const initialBookmark = useRef(bookmark)
  const [geometry, setGeometry] = useState<Geometry>({ width: 0, columns: 2, gap: 0, fallbackRatio: 4 / 3, minimum: 44, videoMinimum: 96, viewportHeight: 0 })
  const [hints, setHints] = useState<{ session: string; values: ReadonlyMap<string, { ratio?: number; video?: boolean }> }>({ session: sessionId, values: new Map() })
  const instructionId = useId()

  useLayoutEffect(() => { callbacks.current = { onSelect, onBookmark, modalOpen } })
  useLayoutEffect(() => {
    const root = rootRef.current
    const list = layoutRef.current
    if (!root || !list) return
    const measure = () => {
      const style = getComputedStyle(root)
      const number = (token: string) => Number.parseFloat(style.getPropertyValue(token))
      // Computed content width excludes the root scrollbar and stays in layout CSS pixels under zoom.
      const width = Number.parseFloat(getComputedStyle(list).width)
      const columns = width >= number('--album-column-5-min') ? 5 : width >= number('--album-column-4-min') ? 4 : width >= number('--album-column-3-min') ? 3 : 2
      const gap = number(columns >= 4 ? '--album-gap-large' : columns === 3 ? '--album-gap-medium' : '--album-gap-small')
      const [numerator, denominator = '1'] = style.getPropertyValue('--album-fallback-ratio').trim().split('/')
      const fallbackRatio = Number(numerator) / Number(denominator)
      const next = { width, columns, gap, fallbackRatio, minimum: number('--masonry-tile-min-height'), videoMinimum: number('--control-height') * 2, viewportHeight: root.clientHeight }
      setGeometry(old => Object.keys(next).every(key => old[key as keyof Geometry] === next[key as keyof Geometry]) ? old : next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(list)
    observer?.observe(root)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const layout = useMemo(() => layoutMasonry(items.map(item => {
    const hint = hints.session === sessionId ? hints.values.get(item.id) : undefined
    const ratio = hint?.ratio ?? dimensionRatio(item.width, item.height) ?? geometry.fallbackRatio
    const tileWidth = (geometry.width - geometry.gap * (geometry.columns - 1)) / geometry.columns
    const minimum = hint?.video || item.kind === 'video' ? geometry.videoMinimum : geometry.minimum
    return { id: item.id, ratio: Math.min(ratio, tileWidth / minimum) }
  }), geometry.width, geometry.columns, geometry.gap), [items, hints, sessionId, geometry])

  const publishBookmark = useCallback((focusId?: string) => {
    const root = rootRef.current
    const list = layoutRef.current
    const current = previous.current
    if (!root || !list || !current || callbacks.current.modalOpen) return
    if (focusId && !applyingFocus.current) pendingFocus.current = undefined
    const moved = appliedScroll.current === undefined || Math.abs(root.scrollTop - appliedScroll.current) > 1
    if (!moved && !focusId) return
    // Layout-generated scroll events do not select a new logical anchor.
    const next = !moved && belongsToSession(saved.current, current.sessionId)
      ? { ...saved.current!, collectionKey: current.key, scrollTop: root.scrollTop }
      : readBookmark(root, current.boxes, current.inset, current.key)
    if (!next.focusId && belongsToSession(saved.current, current.sessionId) && current.boxes.some(box => box.id === saved.current?.focusId)) next.focusId = saved.current?.focusId
    if (focusId) next.focusId = focusId
    appliedScroll.current = restoreScroll(root, list, current.height, current.inset, root.scrollTop)
    saved.current = next
    bookmarkedLayout.current = current
    callbacks.current.onBookmark(next)
  }, [])

  const focusItem = useCallback((id: string) => {
    if (applyingFocus.current || callbacks.current.modalOpen) return
    if (!previous.current) entryFocusClaimed.current = true
    const root = rootRef.current
    const current = previous.current
    const box = current?.boxes.find(box => box.id === id)
    if (root && current && box) {
      const top = current.inset + box.y
      const bottom = top + box.height
      if (top < root.scrollTop) root.scrollTop = top
      else if (bottom > root.scrollTop + root.clientHeight) root.scrollTop = Math.min(top, bottom - root.clientHeight)
    }
    publishBookmark(id)
  }, [publishBookmark])

  useLayoutEffect(() => {
    const root = rootRef.current
    const list = layoutRef.current
    if (!root || !list || geometry.width <= 0) return
    const old = previous.current
    const inset = Number.parseFloat(getComputedStyle(root).paddingTop)
    const sameSession = old?.sessionId === sessionId
    const entry = belongsToSession(initialBookmark.current, sessionId) ? initialBookmark.current : undefined
    const restore = old ? sameSession ? saved.current : undefined : entry
    const byId = new Map(layout.boxes.map(box => [box.id, box]))
    const materialChange = !old || old.boxes !== layout.boxes || old.key !== collectionKey || !sameSession || old.inset !== inset || (old.modalOpen && !modalOpen)
    if (materialChange) {
      let anchor = restore?.anchorId ? byId.get(restore.anchorId) : undefined
      const anchorRemoved = !!restore?.anchorId && !anchor
      if (anchorRemoved && sameSession && old) {
        const prior = bookmarkedLayout.current?.sessionId === sessionId ? bookmarkedLayout.current : old
        const oldY = prior.boxes.find(box => box.id === restore.anchorId)?.y ?? restore.scrollTop - prior.inset
        const nearest = prior.boxes.reduce<MasonryBox | undefined>((best, box) =>
          byId.has(box.id) && (!best || Math.abs(box.y - oldY) < Math.abs(best.y - oldY)) ? box : best, undefined)
        anchor = nearest ? byId.get(nearest.id) : undefined
      }
      if (anchorRemoved && !anchor) anchor = (activeId ? byId.get(activeId) : undefined) ?? layout.boxes[0]
      const offset = restore?.anchorOffset ?? 0
      const target = Math.max(0, anchor ? inset + anchor.y + offset : restore && !restore.anchorId ? restore.scrollTop : sameSession ? root.scrollTop : 0)
      appliedScroll.current = restoreScroll(root, list, layout.height, inset, target)
      const current = { sessionId, key: collectionKey, boxes: layout.boxes, height: layout.height, inset, modalOpen }
      previous.current = current
      // Modal reflow may reposition pixels, but the pre-modal bookmark stays frozen.
      if (!modalOpen || !saved.current || !sameSession) {
        const next: AlbumBookmark = { collectionKey, scrollTop: root.scrollTop,
          ...(anchor ? { anchorId: anchor.id, anchorOffset: offset } : {}),
          ...(restore?.focusId && byId.has(restore.focusId) ? { focusId: restore.focusId } : {}),
        }
        saved.current = next
        bookmarkedLayout.current = current
        if (!modalOpen) callbacks.current.onBookmark(next)
      }

      if (!old || !sameSession || old.key !== collectionKey || anchorRemoved) {
        const entryFocus = !old && activeId ? byId.get(activeId) : undefined
        const focus = restore?.focusId ? byId.get(restore.focusId) : undefined
        const visibleFocus = focus && focus.y + focus.height > root.scrollTop - inset && focus.y < root.scrollTop - inset + root.clientHeight
        pendingFocus.current = !old && entryFocusClaimed.current ? undefined
          : { key: collectionKey, id: entryFocus?.id ?? (visibleFocus ? focus.id : anchor?.id ?? (activeId && byId.has(activeId) ? activeId : undefined)) }
      }
    }
    if (previous.current) previous.current.modalOpen = modalOpen
    if (modalOpen || !pendingFocus.current) return
    const frame = requestAnimationFrame(() => {
      const request = pendingFocus.current
      if (!request || request.key !== previous.current?.key || !root.isConnected || root.closest('[inert]') || callbacks.current.modalOpen) return
      pendingFocus.current = undefined
      const focused = root.ownerDocument.activeElement
      if (focused instanceof HTMLElement && focused !== root.ownerDocument.body && !root.contains(focused)
        && !focused.closest('dialog,[inert],[hidden]') && focused.getClientRects().length) return
      const target = request.id ? Array.from(list.querySelectorAll<HTMLButtonElement>('[data-album-select]')).find(button => button.dataset.albumSelect === request.id) : undefined
      const current = previous.current
      const box = current?.boxes.find(box => box.id === request.id)
      if (box && current && (current.inset + box.y + box.height <= root.scrollTop || current.inset + box.y >= root.scrollTop + root.clientHeight)) {
        focusItem(box.id)
      } else if (request.id) publishBookmark(request.id)
      applyingFocus.current = true
      try { (target ?? root).focus({ preventScroll: true }) }
      finally { applyingFocus.current = false }
    })
    return () => cancelAnimationFrame(frame)
  }, [layout, geometry.width, collectionKey, sessionId, activeId, modalOpen, focusItem, publishBookmark])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const scroll = () => publishBookmark()
    root.addEventListener('scroll', scroll, { passive: true })
    return () => { root.removeEventListener('scroll', scroll) }
  }, [publishBookmark])

  const select = useCallback((id: string) => {
    if (callbacks.current.modalOpen) return
    publishBookmark(id)
    callbacks.current.onSelect(id)
  }, [publishBookmark])
  const reportRatio = useCallback((id: string, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return
    setHints(old => {
      if (old.session === sessionId && old.values.get(id)?.ratio === ratio) return old
      const values = new Map(old.session === sessionId ? old.values : [])
      values.set(id, { ...values.get(id), ratio })
      return { session: sessionId, values }
    })
  }, [sessionId])
  const reportVideoItem = useCallback((id: string) => {
    setHints(old => {
      if (old.session === sessionId && old.values.get(id)?.video) return old
      const values = new Map(old.session === sessionId ? old.values : [])
      values.set(id, { ...values.get(id), video: true })
      return { session: sessionId, values }
    })
  }, [sessionId])

  return <div ref={rootRef} className="album-grid" role="region" aria-label="影像相册" aria-describedby={instructionId} tabIndex={-1}
    style={{ '--album-gap': `${geometry.gap}px` } as CSSProperties}
    onPointerDownCapture={event => {
      if (!modalOpen) {
        if (!previous.current) entryFocusClaimed.current = true
        pendingFocus.current = undefined
      }
      if (modalOpen || event.button !== 0 || (event.target as Element).closest('video, .album-retry')) {
        gestures.cancel()
        return
      }
      if (!event.isPrimary && !gestures.active) { gestures.cancel(); return }
      if (event.isPrimary && gestures.active) gestures.cancel()
      gestures.start(event.pointerId, { x: event.clientX, y: event.clientY }, event.pointerType, event.timeStamp,
        { scale: 1, pan: { x: 0, y: 0 } })
    }} onPointerMoveCapture={event => {
      if (!gestures.hasPointer(event.pointerId)) return
      gestures.move(event.pointerId, { x: event.clientX, y: event.clientY },
        { width: event.currentTarget.clientWidth, height: event.currentTarget.clientHeight })
    }} onPointerUpCapture={event => {
      if (gestures.hasPointer(event.pointerId)) gestures.end(event.pointerId, { x: event.clientX, y: event.clientY }, event.timeStamp)
    }} onPointerCancelCapture={event => {
      if (gestures.hasPointer(event.pointerId)) gestures.cancel()
    }} onContextMenu={event => {
      if (!(event.target as Element).closest('video, .album-retry')) gestures.cancel()
    }}
    onClickCapture={event => {
      if (event.detail > 0 && !(event.target as Element).closest('video, .album-retry') && gestures.consumeClick()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }}
    onClick={event => {
      if (!modalOpen && !(event.target as Element).closest('button, video')) onToggleChrome()
    }} onKeyDownCapture={() => {
      if (!modalOpen) {
        if (!previous.current) entryFocusClaimed.current = true
        pendingFocus.current = undefined
      }
    }} onKeyDown={event => {
      if (event.target === event.currentTarget && event.key === 'Enter' && !event.nativeEvent.isComposing && !modalOpen) {
        event.preventDefault()
        event.stopPropagation()
        onToggleChrome()
      }
    }}>
    <span id={instructionId} className="album-sr-only">按 Enter 或 M 显示工具。按 Tab 按来源顺序访问影像，打开影像进入阅读。</span>
    <ul ref={layoutRef} className="album-layout" style={{ height: layout.height }}>
      {layout.boxes.map((box, index) => <AlbumTile key={box.id} item={items[index]!} box={box}
        active={box.id === activeId} modalOpen={modalOpen} service={service} sessionId={sessionId}
        scrollRoot={rootRef} onSelect={select} onRatio={reportRatio} onVideoItem={reportVideoItem} onFocusItem={focusItem} />)}
    </ul>
    {!items.length && <p className="album-empty" role="status">没有符合筛选的影像。可从菜单调整筛选或打开其他来源。</p>}
  </div>
}
