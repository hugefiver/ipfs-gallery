import { describe, expect, it } from 'vitest'
import { layoutMasonry } from '../../src/hooks/masonryLayout'

describe('shortest-column album geometry', () => {
  it('places each next item in the shortest column, breaking ties from the left', () => {
    const items = Object.freeze([
      { id: 'portrait', ratio: 0.5 },
      { id: 'landscape', ratio: 2 },
      { id: 'square', ratio: 1 },
      { id: 'wide', ratio: 3 },
      { id: 'last', ratio: 1 },
    ].map(item => Object.freeze(item)))
    const { boxes, height } = layoutMasonry(items, 208, 2, 8)
    expect(boxes).toEqual([
      { id: 'portrait', x: 0, y: 0, width: 100, height: 200 },
      { id: 'landscape', x: 108, y: 0, width: 100, height: 50 },
      { id: 'square', x: 108, y: 58, width: 100, height: 100 },
      { id: 'wide', x: 108, y: 166, width: 100, height: 44 },
      { id: 'last', x: 0, y: 208, width: 100, height: 100 },
    ])
    expect(height).toBe(308)
    expect(boxes.map(box => box.id)).toEqual(items.map(item => item.id))
  })

  it.each([
    [375, 8, 2, 8],
    [768, 16, 3, 12],
    [1280, 24, 4, 16],
    [1600, 24, 5, 16],
  ])('fits %ipx with honest ratios and %i px inset', (viewport, inset, columns, gap) => {
    const width = viewport - inset * 2
    const items = Array.from({ length: 37 }, (_, index) => ({ id: String(index), ratio: [0.5, 1, 1.5, 2.8][index % 4]! }))
    const before = structuredClone(items)
    const { boxes, height } = layoutMasonry(items, width, columns, gap)
    const columnWidth = (width - gap * (columns - 1)) / columns
    expect(items).toEqual(before)
    expect(boxes.map(box => box.id)).toEqual(items.map(item => item.id))
    const bottoms = Array<number>(columns).fill(0)
    boxes.forEach((box, index) => {
      const shortest = bottoms.indexOf(Math.min(...bottoms))
      expect(box.x).toBeCloseTo(shortest * (columnWidth + gap), 6)
      expect(box.y).toBeCloseTo(bottoms[shortest]!, 6)
      expect(box.width).toBeCloseTo(columnWidth, 6)
      expect(box.height).toBeCloseTo(Math.max(44, columnWidth / items[index]!.ratio), 6)
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.001)
      bottoms[shortest] = box.y + box.height + gap
      for (const other of boxes.slice(0, index)) {
        const overlapX = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
        const overlapY = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
        expect(overlapX > 0.001 && overlapY > 0.001).toBe(false)
      }
    })
    expect(height).toBeCloseTo(Math.max(...boxes.map(box => box.y + box.height)), 6)
  })

  it('uses stable 4:3 fallback for invalid ratios and a 44px target for extremely wide media', () => {
    const items = [0, -1, Number.NaN, Infinity, 1000].map((ratio, index) => ({ id: String(index), ratio }))
    const { boxes } = layoutMasonry(items, 408, 2, 8)
    expect(boxes.slice(0, 4).map(box => box.height)).toEqual([150, 150, 150, 150])
    expect(boxes.at(-1)?.height).toBe(44)
    expect(layoutMasonry([], 359, 2, 8)).toEqual({ boxes: [], height: 0 })
  })
})
