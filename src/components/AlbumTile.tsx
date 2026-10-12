import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { CheckIcon, PlayIcon } from '@phosphor-icons/react'
import type { MasonryBox, MediaContext } from '../app/readerAlbumTypes'
import type { GalleryItem } from '../shared/contracts'
import { contentAddress } from '../app/format'
import { useAsset } from '../hooks/useAsset'

interface AlbumTileProps extends MediaContext {
  item: GalleryItem
  box: MasonryBox
  active: boolean
  modalOpen: boolean
  scrollRoot: RefObject<HTMLElement | null>
  onSelect: (id: string) => void
  onRatio: (id: string, ratio: number) => void
  onVideoItem: (id: string) => void
  onFocusItem: (id: string) => void
}

function AlbumPreview({ item, service, sessionId, visible, onRatio, onVideo }: MediaContext & {
  item: GalleryItem
  visible: boolean
  onRatio: (id: string, ratio: number) => void
  onVideo: (video: boolean) => void
}) {
  const [original, setOriginal] = useState(!item.thumbnail)
  const [revision, setRevision] = useState(0)
  const [decodeFailureKey, setDecodeFailureKey] = useState<string>()
  const thumbnail = useAsset(service, sessionId, item.thumbnail ?? item.ref, visible && !original && !!item.thumbnail, 1, revision)
  const fallback = original || (!!thumbnail.error && thumbnail.error.code !== 'LIMIT' && thumbnail.error.code !== 'CANCELLED')
  const main = useAsset(service, sessionId, item.ref, visible && fallback, 2, revision)
  const state = fallback ? main : thumbnail
  const asset = state.asset
  const invalidMime = !!asset && !asset.mime.startsWith(`${asset.kind}/`)
  const failed = !!state.error || decodeFailureKey === state.key || invalidMime
  const video = !!asset && asset.kind === 'video' && !failed

  useEffect(() => { onVideo(video) }, [video, onVideo])
  useEffect(() => {
    if (!asset || failed) return
    if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0 || !Number.isFinite(asset.width) || !Number.isFinite(asset.height)) return
    const ratio = asset.width / asset.height
    if (Number.isFinite(ratio) && ratio > 0) onRatio(item.id, ratio)
  }, [asset, failed, item.id, onRatio])
  if (invalidMime && !fallback) setOriginal(true)

  const decodeFailure = () => {
    if (!fallback) setOriginal(true)
    else setDecodeFailureKey(state.key)
  }
  const reportSize = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    const ratio = width / height
    if (asset?.active && Number.isFinite(ratio) && ratio > 0) onRatio(item.id, ratio)
  }

  return <>
    {asset && !failed ? asset.kind === 'image'
      ? <img className="album-media" src={asset.url} alt="" width={asset.width} height={asset.height}
          decoding="async" onError={decodeFailure}
          onLoad={event => reportSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
      : <video className="album-media album-video" src={asset.url} controls playsInline preload="metadata"
          onError={decodeFailure} onLoadedMetadata={event => reportSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          aria-label={`视频预览：${item.title}`} onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()} />
      : <span className="album-placeholder" aria-hidden={failed || undefined} aria-busy={visible && !!service && !failed}>
          <span>{failed ? '预览不可用' : visible && service ? '正在验证…' : '影像待载入'}</span>
        </span>}
    {failed && <span className="album-failure">
      <span role="status" aria-label={state.error?.message ?? '预览不可用：媒体无法解码'} title={state.error?.message ?? '媒体无法解码'}>
        {state.error?.code === 'LIMIT' ? '已满' : state.error?.code === 'CANCELLED' ? '取消' : '失败'}
      </span>
      <button type="button" className="album-retry" aria-label={`重试 ${item.title}`} title={state.error?.message ?? '媒体无法解码'}
        onClick={event => {
          event.stopPropagation()
          setOriginal(!item.thumbnail)
          setDecodeFailureKey(undefined)
          setRevision(value => value + 1)
        }}>重试</button>
    </span>}
  </>
}

export const AlbumTile = memo(function AlbumTile({
  item, box, active, modalOpen, service, sessionId, scrollRoot, onSelect, onRatio, onVideoItem, onFocusItem,
}: AlbumTileProps) {
  const elementRef = useRef<HTMLLIElement>(null)
  const [visible, setVisible] = useState(false)
  const [video, setVideo] = useState(false)
  const reportVideo = useCallback((value: boolean) => {
    setVideo(value)
    if (value) onVideoItem(item.id)
  }, [item.id, onVideoItem])
  useEffect(() => {
    const element = elementRef.current
    const container = scrollRoot.current
    if (!element || !container) return
    if (typeof IntersectionObserver !== 'undefined') {
      let observing = true
      const observer = new IntersectionObserver(entries => {
        if (observing) setVisible(!!entries[0]?.isIntersecting)
      }, { root: container, rootMargin: '0px' })
      observer.observe(element)
      return () => { observing = false; observer.disconnect() }
    }
    const measure = () => {
      const bounds = container.getBoundingClientRect()
      const tile = element.getBoundingClientRect()
      setVisible(tile.bottom > bounds.top && tile.top < bounds.bottom && tile.right > bounds.left && tile.left < bounds.right)
    }
    const frame = requestAnimationFrame(measure)
    container.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [scrollRoot, box.x, box.y, box.width, box.height])

  return <li ref={elementRef} className="album-tile" data-album-id={item.id}
    style={{ left: box.x, top: box.y, width: box.width, height: box.height }} onFocus={() => {
      if (modalOpen) return
      onFocusItem(item.id)
    }}>
    <AlbumPreview key={`${sessionId}:${contentAddress(item.ref)}:${item.thumbnail ? contentAddress(item.thumbnail) : ''}`}
      item={item} service={service} sessionId={sessionId} visible={visible} onRatio={onRatio} onVideo={reportVideo} />
    <button type="button" className={`album-select${video ? ' album-select-video' : ''}`}
      data-album-select={item.id} aria-label={`打开 ${item.title}`} aria-current={active ? 'true' : undefined}
      aria-disabled={modalOpen || undefined} onClick={event => {
        event.stopPropagation()
        if (!modalOpen) onSelect(item.id)
      }}>
      {video && <span className="album-video-open"><PlayIcon aria-hidden="true" />打开视频</span>}
      {active && <span className="album-current"><CheckIcon aria-hidden="true" /><span className="album-sr-only">当前影像</span></span>}
    </button>
  </li>
})
