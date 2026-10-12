import { useCallback, useRef, useState } from 'react'
import { readGalleryPreferences, updateGalleryPreferences } from './galleryPreferences'
import type { GalleryPreferenceAction, GalleryPreferencesController } from './galleryPreferences'

export type { DeviceClass, GalleryPreferences, GalleryPreferencesController, LayoutMode, PreferenceResult, StorageStatus, StoredGalleryPreferencesV1 } from './galleryPreferences'

export function useGalleryPreferences(): GalleryPreferencesController {
  const [state, setState] = useState(() => readGalleryPreferences())
  const current = useRef(state)
  const change = useCallback((action: GalleryPreferenceAction) => {
    // IO runs once in the event handler, never in a render or replayable state updater.
    const next = updateGalleryPreferences(current.current, action)
    current.current = next.state
    setState(next.state)
    return next.result
  }, [])

  return {
    ...state,
    setLayout: mode => change({ type: 'layout', mode }),
    setSidebar: (device, open) => change({ type: 'sidebar', device, open }),
    setRemember: enabled => change({ type: 'remember', enabled }),
    applyGateways: gateways => change({ type: 'gateways', gateways }),
    clearSavedPreferences: () => change({ type: 'clear' }),
  }
}
