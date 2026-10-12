export const READER_GESTURE_THRESHOLDS = {
  movement: 8,
  swipe: 64,
  axisRatio: 2,
  longPressMs: 500,
  doubleTapMs: 300,
} as const

export const READER_ZOOM = { min: 1, max: 4, step: 0.5 } as const
export interface ReaderPoint { x: number; y: number }
export interface ReaderSize { width: number; height: number }
export interface ReaderTransform { scale: number; pan: ReaderPoint }
export type ReaderGestureKind = 'tap' | 'drag' | 'pan' | 'pinch' | 'previous' | 'next' | 'cancelled' | 'longpress'

export function ignoresReaderInteraction(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && !!target.closest(
    'input,textarea,select,button,a,summary,video,audio,dialog,[role="button"],[role="slider"],[contenteditable]:not([contenteditable="false"])',
  )
}

export function clampReaderZoom(scale: number): number {
  return Number.isFinite(scale) ? Math.max(READER_ZOOM.min, Math.min(READER_ZOOM.max, scale)) : READER_ZOOM.min
}

export function containReaderSize(media: ReaderSize, viewport: ReaderSize): ReaderSize {
  if (!(media.width > 0 && media.height > 0)) return viewport
  const fit = Math.min(viewport.width / media.width, viewport.height / media.height)
  return { width: media.width * fit, height: media.height * fit }
}

export function clampReaderPan(pan: ReaderPoint, scale: number, viewport: ReaderSize, media: ReaderSize = viewport): ReaderPoint {
  const fitted = containReaderSize(media, viewport)
  const maxX = Math.max(0, (fitted.width * clampReaderZoom(scale) - viewport.width) / 2)
  const maxY = Math.max(0, (fitted.height * clampReaderZoom(scale) - viewport.height) / 2)
  return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) }
}

export function classifyReaderGesture({ dx, dy, scale, pointerCount = 1, cancelled = false, moved = false, durationMs = 0, pointerType = 'touch' }: {
  dx: number; dy: number; scale: number; pointerCount?: number; cancelled?: boolean; moved?: boolean; durationMs?: number; pointerType?: string
}): ReaderGestureKind {
  if (cancelled) return 'cancelled'
  if (pointerCount > 1) return 'pinch'
  const travelled = moved || Math.hypot(dx, dy) >= READER_GESTURE_THRESHOLDS.movement
  if (!travelled) return durationMs >= READER_GESTURE_THRESHOLDS.longPressMs ? 'longpress' : 'tap'
  if (scale > READER_ZOOM.min) return 'pan'
  if (pointerType === 'touch' && Math.abs(dx) >= READER_GESTURE_THRESHOLDS.swipe && Math.abs(dx) >= Math.abs(dy) * READER_GESTURE_THRESHOLDS.axisRatio) {
    return dx < 0 ? 'next' : 'previous'
  }
  return 'drag'
}

interface TrackedPointer { start: ReaderPoint; point: ReaderPoint; pointerType: string }
interface Pinch { distance: number; center: ReaderPoint; transform: ReaderTransform }
const distance = (a: ReaderPoint, b: ReaderPoint) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: ReaderPoint, b: ReaderPoint): ReaderPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** Suppression follows the pointer sequence, not a guessed click timeout. */
export class ReaderGestureTracker {
  private pointers = new Map<number, TrackedPointer>()
  private transform: ReaderTransform = { scale: 1, pan: { x: 0, y: 0 } }
  private origin: ReaderTransform = this.transform
  private pinch?: Pinch
  private startedAt = 0
  private moved = false
  private multiple = false
  private suppressed = false

  get active(): boolean { return this.pointers.size > 0 }
  hasPointer(id: number): boolean { return this.pointers.has(id) }

  start(id: number, point: ReaderPoint, pointerType: string, time: number, transform: ReaderTransform): void {
    if (!this.pointers.size) {
      this.startedAt = time
      this.moved = false
      this.multiple = false
      this.suppressed = false
      this.origin = transform
      this.transform = transform
    }
    this.pointers.set(id, { start: point, point, pointerType })
    if (this.pointers.size > 1) {
      this.multiple = true
      this.suppressed = true
      this.rebasePinch()
    }
  }

  move(id: number, point: ReaderPoint, viewport: ReaderSize, media: ReaderSize = viewport): ReaderTransform | undefined {
    const pointer = this.pointers.get(id)
    if (!pointer) return
    pointer.point = point
    if (distance(pointer.start, point) >= READER_GESTURE_THRESHOLDS.movement) { this.moved = true; this.suppressed = true }
    const pair = [...this.pointers.values()]
    const first = pair[0]
    const second = pair[1]
    if (first && second && this.pinch) {
      const center = midpoint(first.point, second.point)
      const scale = clampReaderZoom(this.pinch.transform.scale * distance(first.point, second.point) / this.pinch.distance)
      const ratio = scale / this.pinch.transform.scale
      const pan = {
        x: center.x + (this.pinch.transform.pan.x - this.pinch.center.x) * ratio,
        y: center.y + (this.pinch.transform.pan.y - this.pinch.center.y) * ratio,
      }
      this.transform = { scale, pan: clampReaderPan(pan, scale, viewport, media) }
      return this.transform
    }
    if (this.transform.scale > 1 && this.moved) {
      const pan = { x: this.origin.pan.x + point.x - pointer.start.x, y: this.origin.pan.y + point.y - pointer.start.y }
      this.transform = { scale: this.origin.scale, pan: clampReaderPan(pan, this.origin.scale, viewport, media) }
      return this.transform
    }
  }

  end(id: number, point: ReaderPoint, time: number): ReaderGestureKind {
    const pointer = this.pointers.get(id)
    if (!pointer) return 'cancelled'
    const kind = classifyReaderGesture({
      dx: point.x - pointer.start.x, dy: point.y - pointer.start.y, scale: this.transform.scale,
      pointerCount: this.multiple ? 2 : 1, moved: this.moved,
      durationMs: time - this.startedAt, pointerType: pointer.pointerType,
    })
    this.pointers.delete(id)
    this.suppressed ||= kind !== 'tap'
    this.pinch = undefined
    if (this.pointers.size) {
      this.origin = this.transform
      for (const remaining of this.pointers.values()) remaining.start = remaining.point
      this.rebasePinch()
    }
    return kind
  }

  cancel(): void {
    this.pointers.clear()
    this.pinch = undefined
    this.suppressed = true
  }

  consumeClick(): boolean {
    const suppressed = this.suppressed
    this.suppressed = false
    return suppressed
  }

  private rebasePinch(): void {
    const [first, second] = [...this.pointers.values()]
    if (first && second) this.pinch = {
      distance: Math.max(1, distance(first.point, second.point)),
      center: midpoint(first.point, second.point), transform: this.transform,
    }
  }
}
