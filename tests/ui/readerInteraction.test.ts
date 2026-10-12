import { describe, expect, it } from 'vitest'
import { classifyReaderGesture, clampReaderPan, clampReaderZoom, containReaderSize, ReaderGestureTracker, READER_GESTURE_THRESHOLDS as thresholds } from '../../src/hooks/readerInteraction'

const fitted = { scale: 1, pan: { x: 0, y: 0 } }
const viewport = { width: 200, height: 200 }

describe('reader gesture decisions', () => {
  it('separates a tap from movement at the exact movement boundary', () => {
    expect(classifyReaderGesture({ dx: thresholds.movement - 0.001, dy: 0, scale: 1 })).toBe('tap')
    expect(classifyReaderGesture({ dx: thresholds.movement, dy: 0, scale: 1 })).toBe('drag')
    expect(classifyReaderGesture({ dx: 0, dy: 0, scale: 1, moved: true })).toBe('drag')
    expect(classifyReaderGesture({ dx: 0, dy: 0, scale: 1, durationMs: thresholds.longPressMs - 1 })).toBe('tap')
    expect(classifyReaderGesture({ dx: 0, dy: 0, scale: 1, durationMs: thresholds.longPressMs })).toBe('longpress')
  })

  it('requires a touch swipe with sufficient horizontal distance and axis dominance', () => {
    expect(classifyReaderGesture({ dx: -thresholds.swipe, dy: thresholds.swipe / thresholds.axisRatio, scale: 1 })).toBe('next')
    expect(classifyReaderGesture({ dx: thresholds.swipe, dy: 0, scale: 1 })).toBe('previous')
    expect(classifyReaderGesture({ dx: thresholds.swipe - 0.001, dy: 0, scale: 1 })).toBe('drag')
    expect(classifyReaderGesture({ dx: thresholds.swipe, dy: thresholds.swipe / thresholds.axisRatio + 0.001, scale: 1 })).toBe('drag')
    expect(classifyReaderGesture({ dx: -thresholds.swipe * 2, dy: 0, scale: 1, pointerType: 'mouse' })).toBe('drag')
  })

  it('gives cancellation, multi-touch and zoomed panning precedence over selection', () => {
    expect(classifyReaderGesture({ dx: -200, dy: 0, scale: 2 })).toBe('pan')
    expect(classifyReaderGesture({ dx: -200, dy: 0, scale: 1, pointerCount: 2 })).toBe('pinch')
    expect(classifyReaderGesture({ dx: -200, dy: 0, scale: 2, pointerCount: 2, cancelled: true })).toBe('cancelled')
  })

  it('suppresses the click after a moved sequence even when its final point returns to the origin', () => {
    const tracker = new ReaderGestureTracker()
    tracker.start(1, { x: 0, y: 0 }, 'touch', 0, fitted)
    tracker.move(1, { x: 20, y: 0 }, viewport)
    tracker.move(1, { x: 0, y: 0 }, viewport)
    expect(tracker.end(1, { x: 0, y: 0 }, 100)).toBe('drag')
    expect(tracker.active).toBe(false)
    expect(tracker.consumeClick()).toBe(true)
    expect(tracker.consumeClick()).toBe(false)
    tracker.start(2, { x: 0, y: 0 }, 'touch', 200, fitted)
    expect(tracker.end(2, { x: 1, y: 0 }, 250)).toBe('tap')
    expect(tracker.consumeClick()).toBe(false)
  })

  it('keeps the entire multi-pointer sequence non-selecting, including the last finger', () => {
    const tracker = new ReaderGestureTracker()
    tracker.start(1, { x: -50, y: 0 }, 'touch', 0, fitted)
    tracker.start(2, { x: 50, y: 0 }, 'touch', 10, fitted)
    tracker.move(1, { x: -100, y: 0 }, viewport)
    expect(tracker.move(2, { x: 100, y: 0 }, viewport)).toEqual({ scale: 2, pan: { x: 0, y: 0 } })
    expect(tracker.end(1, { x: -100, y: 0 }, 100)).toBe('pinch')
    expect(tracker.active).toBe(true)
    expect(tracker.end(2, { x: -100, y: 0 }, 200)).toBe('pinch')
    expect(tracker.consumeClick()).toBe(true)
    expect(tracker.active).toBe(false)
  })

  it('cancels all captured pointers and prevents the following synthetic click', () => {
    const tracker = new ReaderGestureTracker()
    tracker.start(9, { x: 0, y: 0 }, 'touch', 0, fitted)
    expect(tracker.hasPointer(9)).toBe(true)
    tracker.cancel()
    expect(tracker.hasPointer(9)).toBe(false)
    expect(tracker.move(9, { x: 100, y: 0 }, viewport)).toBeUndefined()
    expect(tracker.end(9, { x: 100, y: 0 }, 20)).toBe('cancelled')
    expect(tracker.consumeClick()).toBe(true)
  })

  it.each([
    [thresholds.longPressMs - 1, 'tap', false],
    [thresholds.longPressMs, 'longpress', true],
  ] as const)('consumes the album click after a %ims stationary pointer sequence', (duration, kind, suppressed) => {
    const tracker = new ReaderGestureTracker()
    tracker.start(1, { x: 20, y: 20 }, 'mouse', 100, fitted)
    expect(tracker.end(1, { x: 20, y: 20 }, 100 + duration)).toBe(kind)
    expect(tracker.consumeClick()).toBe(suppressed)
    tracker.start(2, { x: 20, y: 20 }, 'mouse', 1000, fitted)
    expect(tracker.end(2, { x: 20, y: 20 }, 1050)).toBe('tap')
    expect(tracker.consumeClick()).toBe(false)
  })

  it('tracks an album swipe at fit scale without producing an image transform', () => {
    const tracker = new ReaderGestureTracker()
    tracker.start(1, { x: 150, y: 20 }, 'touch', 0, fitted)
    expect(tracker.move(1, { x: 40, y: 20 }, viewport)).toBeUndefined()
    expect(tracker.end(1, { x: 40, y: 20 }, 150)).toBe('next')
    expect(tracker.consumeClick()).toBe(true)
  })

  it('suppresses stationary multi-touch as well as moving pinch sequences', () => {
    const tracker = new ReaderGestureTracker()
    tracker.start(1, { x: 20, y: 20 }, 'touch', 0, fitted)
    tracker.start(2, { x: 80, y: 20 }, 'touch', 1, fitted)
    expect(tracker.end(1, { x: 20, y: 20 }, 40)).toBe('pinch')
    expect(tracker.end(2, { x: 80, y: 20 }, 41)).toBe('pinch')
    expect(tracker.consumeClick()).toBe(true)
  })
})

describe('contained media and bounded image transforms', () => {
  it('preserves both portrait and landscape ratios within the viewport', () => {
    expect(containReaderSize({ width: 400, height: 100 }, viewport)).toEqual({ width: 200, height: 50 })
    expect(containReaderSize({ width: 100, height: 400 }, viewport)).toEqual({ width: 50, height: 200 })
    expect(containReaderSize({ width: 0, height: 0 }, viewport)).toEqual(viewport)
  })

  it('clamps zoom and pan to the displayed contained media instead of stretching its letterbox', () => {
    expect(clampReaderZoom(Number.NaN)).toBe(1)
    expect(clampReaderZoom(0.5)).toBe(1)
    expect(clampReaderZoom(5)).toBe(4)
    const landscapePan = clampReaderPan({ x: 1000, y: -1000 }, 2, viewport, { width: 400, height: 100 })
    expect(landscapePan.x).toBe(100)
    expect(Math.abs(landscapePan.y)).toBe(0)
    const resetPan = clampReaderPan({ x: 1000, y: -1000 }, 1, viewport)
    expect(Math.abs(resetPan.x) + Math.abs(resetPan.y)).toBe(0)
  })
})
