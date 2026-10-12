import type { AssetService, MainAssetState } from '../hooks/assetService'
import type { GalleryItem } from '../shared/contracts'

export type GalleryMode = 'reader' | 'album'
export type GalleryPanel = 'menu' | 'source' | 'filters' | 'info' | 'network' | 'readerTools' | null

export interface MediaContext {
  service: AssetService | undefined
  sessionId: string
}

export interface ReaderAssetBinding {
  state: MainAssetState
  retry: () => void
}

export interface ReaderSurfaceProps extends MediaContext {
  item: GalleryItem
  items: readonly GalleryItem[]
  asset: ReaderAssetBinding
  toolsHost: HTMLElement | null
  toolsPaintHost: HTMLElement | null
  modalOpen: boolean
  onSelect: (id: string) => void
  onOpenMenu: () => void
  onOpenInfo: () => void
}

export interface AlbumBookmark {
  collectionKey: string
  scrollTop: number
  anchorId?: string
  anchorOffset?: number
  focusId?: string
}

export interface AlbumGridProps extends MediaContext {
  items: readonly GalleryItem[]
  activeId?: string
  collectionKey: string
  bookmark?: AlbumBookmark
  modalOpen: boolean
  onSelect: (id: string) => void
  onBookmark: (bookmark: AlbumBookmark) => void
  onToggleChrome: () => void
}

export interface MasonryBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}
