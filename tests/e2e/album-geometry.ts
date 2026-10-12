import { expect, type Locator } from '@playwright/test'

export async function albumGeometry(root: Locator, tiles: Locator) {
  const container = await root.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      gap: parseFloat(style.getPropertyValue('--album-gap')),
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflow: element.scrollWidth > element.clientWidth,
    }
  })
  const boxes = await tiles.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    const image = element.parentElement?.querySelector('img')
    return { x: box.x, y: box.y, width: box.width, height: box.height, name: element.getAttribute('aria-label'), naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight, fit: image ? getComputedStyle(image).objectFit : undefined }
  }))
  return { container, boxes }
}

export async function expectShortestColumns(root: Locator, tiles: Locator, columns: number) {
  await root.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const geometry = await albumGeometry(root, tiles)
  const { boxes, container } = geometry
  expect(boxes.length).toBeGreaterThan(columns)
  expect(container.overflow).toBe(false)
  const left = Math.min(...boxes.map(box => box.x))
  const top = Math.min(...boxes.map(box => box.y))
  const columnWidth = (container.width - container.gap * (columns - 1)) / columns
  const bottoms = Array<number>(columns).fill(0)
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]!
    const shortest = bottoms.indexOf(Math.min(...bottoms))
    expect(box.x - left).toBeCloseTo(shortest * (columnWidth + container.gap), 0)
    expect(box.y - top).toBeCloseTo(bottoms[shortest]!, 0)
    expect(box.width).toBeCloseTo(columnWidth, 0)
    expect(box.height).toBeGreaterThanOrEqual(44)
    if (box.naturalWidth && box.naturalHeight) {
      expect(box.fit).toBe('contain')
      expect(box.height).toBeCloseTo(Math.max(44, box.width * box.naturalHeight / box.naturalWidth), 0)
    }
    bottoms[shortest] = box.y - top + box.height + container.gap
    for (const other of boxes.slice(0, index)) {
      const overlapX = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
      const overlapY = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
      expect(overlapX > 1 && overlapY > 1).toBe(false)
    }
  }
  return geometry
}
