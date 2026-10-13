import { ListIcon } from '@phosphor-icons/react'
import { useLayoutEffect, useRef } from 'react'
import type { GalleryMode } from '../app/readerAlbumTypes'
import { Action } from './Primitives'
import { READER_GESTURE_THRESHOLDS } from '../hooks/readerInteraction'

export function GalleryChrome({ mode, menuOpen, onMenu }: { mode: GalleryMode; menuOpen: boolean; onMenu: () => void; onHide: () => void }) {
  const chrome = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuAction = useRef(onMenu)
  useLayoutEffect(() => { menuAction.current = onMenu }, [onMenu])
  useLayoutEffect(() => {
    const element = trigger.current
    if (!element || mode !== 'reader') return
    let tap: { id: number; x: number; y: number; started: number } | undefined
    const start = (event: TouchEvent) => {
      const touch = event.touches[0]
      tap = event.touches.length === 1 && touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, started: event.timeStamp } : undefined
    }
    const move = (event: TouchEvent) => {
      const touch = Array.from(event.touches).find(touch => touch.identifier === tap?.id)
      if (!touch || event.touches.length !== 1 || (tap && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > READER_GESTURE_THRESHOLDS.movement)) tap = undefined
    }
    const cancel = () => { tap = undefined }
    const end = (event: TouchEvent) => {
      const current = tap
      tap = undefined
      if (!current || event.touches.length || event.timeStamp - current.started >= READER_GESTURE_THRESHOLDS.longPressMs) return
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === current.id)
      if (!touch || Math.hypot(touch.clientX - current.x, touch.clientY - current.y) > READER_GESTURE_THRESHOLDS.movement) return
      // Consume this native tap once; browser compatibility clicks are not guaranteed after viewport panning.
      event.preventDefault()
      menuAction.current()
    }
    element.addEventListener('touchstart', start, { passive: true })
    element.addEventListener('touchmove', move, { passive: true })
    element.addEventListener('touchcancel', cancel)
    element.addEventListener('touchend', end, { passive: false })
    return () => {
      element.removeEventListener('touchstart', start)
      element.removeEventListener('touchmove', move)
      element.removeEventListener('touchcancel', cancel)
      element.removeEventListener('touchend', end)
    }
  }, [mode])
  useLayoutEffect(() => {
    const element = chrome.current
    const shell = element?.closest<HTMLElement>('.app-shell') ?? document.querySelector<HTMLElement>('.app-shell')
    if (!element || !shell || mode === 'reader') return
    const previous = shell.style.getPropertyValue('--gallery-chrome-height')
    const measure = () => shell.style.setProperty('--gallery-chrome-height', `${element.offsetHeight}px`)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      if (previous) shell.style.setProperty('--gallery-chrome-height', previous)
      else shell.style.removeProperty('--gallery-chrome-height')
    }
  }, [mode])
  if (mode === 'reader') return <Action ref={trigger} className="reader-menu-trigger" data-menu-trigger aria-label="菜单" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="gallery-panel" onClick={onMenu}><ListIcon aria-hidden="true" /></Action>
  return <nav ref={chrome} className="gallery-chrome" aria-label="相册工具" data-gallery-chrome>
    <Action ref={trigger} className="reader-menu-trigger" data-menu-trigger aria-label="菜单" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="gallery-panel" onClick={onMenu}><ListIcon aria-hidden="true" /></Action>
  </nav>
}
