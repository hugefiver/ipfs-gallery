import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ParsedLocation, ViewState } from '../shared/contracts'
import { DEFAULT_GATEWAYS } from '../shared/gateways'
import { parseLocation, serializeLocation } from '../core/query'
import { createGalleryClient } from '../worker/client'
import { GalleryController, type GallerySnapshot } from './galleryController'
import { toGalleryError } from '../shared/errors'

const emptyLocation = (): ParsedLocation => ({ view: { q: '', tags: [] }, gateways: [], notices: [] })
function readLocation(): { location: ParsedLocation; error?: unknown } {
  try { return { location: parseLocation(window.location.search) } }
  catch (error) { return { location: emptyLocation(), error } }
}

export function resolveGalleryGateways(location: ParsedLocation, preference: readonly string[]): readonly string[] {
  return location.gateways.length ? location.gateways : preference.length ? preference : DEFAULT_GATEWAYS
}

export function useGallery({ gatewayPreference }: { gatewayPreference: readonly string[] }) {
  const [initial] = useState(readLocation)
  const [location, setLocation] = useState(initial.location)
  const locationRef = useRef(location)
  const inputError = useRef(initial.error)
  const preferenceRef = useRef(gatewayPreference)
  useLayoutEffect(() => { preferenceRef.current = gatewayPreference }, [gatewayPreference])
  const controllerRef = useRef<GalleryController | null>(null)
  const [controller, setController] = useState<GalleryController | null>(null)
  const [snapshot, setSnapshot] = useState<GallerySnapshot>({ sessionId: '', status: 'empty', gateways: [] })
  const [viewError, setViewError] = useState('')
  const effectiveGateways = inputError.current ? [] : resolveGalleryGateways(location, gatewayPreference)
  const gatewayKey = JSON.stringify(effectiveGateways)

  useEffect(() => {
    const current = new GalleryController(createGalleryClient())
    controllerRef.current = current
    setController(current)
    const unsubscribe = current.subscribe(setSnapshot)
    const restore = () => {
      setViewError('')
      const parsed = readLocation()
      inputError.current = parsed.error
      locationRef.current = parsed.location
      setLocation(parsed.location)
      if (parsed.error) current.inputError(parsed.error)
      else current.start({ ...parsed.location, gateways: [...resolveGalleryGateways(parsed.location, preferenceRef.current)] })
    }
    restore()
    window.addEventListener('popstate', restore)
    return () => {
      window.removeEventListener('popstate', restore)
      unsubscribe()
      current.dispose()
      if (controllerRef.current === current) controllerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (inputError.current) return
    const current = locationRef.current
    controllerRef.current?.start({ ...current, gateways: [...resolveGalleryGateways(current, preferenceRef.current)] })
  }, [gatewayKey])

  const navigate = useCallback((next: ParsedLocation, mode: 'push' | 'replace' = 'replace', reload = false) => {
    const canonical = parseLocation(serializeLocation(next))
    const url = `${window.location.pathname}${serializeLocation(canonical)}${window.location.hash}`
    if (mode === 'push') window.history.pushState(null, '', url)
    else window.history.replaceState(window.history.state, '', url)
    inputError.current = undefined
    locationRef.current = canonical
    setViewError('')
    controllerRef.current?.start({ ...canonical, gateways: [...resolveGalleryGateways(canonical, preferenceRef.current)] }, mode === 'push' || reload)
    setLocation(canonical)
  }, [])

  const updateView = useCallback((patch: Partial<ViewState>) => {
    const current = locationRef.current
    try { navigate({ ...current, view: { ...current.view, ...patch } }) }
    catch (error) { setViewError(toGalleryError(error).message) }
  }, [navigate])
  const openItem = useCallback((id: string) => updateView({ item: id }), [updateView])
  const closeItem = useCallback(() => updateView({ item: undefined }), [updateView])
  const retry = useCallback(() => {
    if (inputError.current) return
    const current = locationRef.current
    controllerRef.current?.start({ ...current, gateways: [...resolveGalleryGateways(current, preferenceRef.current)] }, true)
  }, [])
  const cancel = useCallback(() => controllerRef.current?.cancel(), [])
  const rejectInput = useCallback((error: unknown) => { inputError.current = error; controllerRef.current?.inputError(error) }, [])

  return { location, effectiveGateways, snapshot, controller, viewError, navigate, updateView, openItem, closeItem, retry, cancel, rejectInput }
}
