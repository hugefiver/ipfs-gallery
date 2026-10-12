import type { MasonryBox } from '../app/readerAlbumTypes'

export function layoutMasonry(
  items: readonly { id: string; ratio: number }[],
  width: number,
  columns: number,
  gap: number,
): { boxes: MasonryBox[]; height: number } {
  if (!items.length || !Number.isFinite(width) || width <= 0) return { boxes: [], height: 0 }
  const count = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 0
  const tileWidth = (width - spacing * (count - 1)) / count
  if (tileWidth <= 0) return { boxes: [], height: 0 }
  const heights = Array<number>(count).fill(0)
  const boxes = items.map(({ id, ratio }) => {
    let column = 0
    for (let index = 1; index < count; index++) {
      if (heights[index]! < heights[column]!) column = index
    }
    const validRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3
    // The 44px control minimum also applies to unusually wide photographs.
    const mediaHeight = tileWidth / validRatio
    const height = Math.max(44, Number.isFinite(mediaHeight) ? mediaHeight : tileWidth / (4 / 3))
    const box = { id, x: column * (tileWidth + spacing), y: heights[column]!, width: tileWidth, height }
    heights[column] = heights[column]! + height + spacing
    return box
  })
  return { boxes, height: Math.max(...heights) - spacing }
}
