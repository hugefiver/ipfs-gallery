import { useEffect, useMemo, useState } from 'react'
import type { ContentRef, GalleryError } from '../shared/contracts'
import { toGalleryError } from '../shared/errors'
import { contentAddress } from '../app/format'
import type { AssetLease, AssetService } from './assetService'

export function useAsset(service: AssetService | undefined, sessionId: string, ref: ContentRef, enabled: boolean, priority: number, revision = 0) {
  const address = contentAddress(ref)
  const cid = ref.cid
  const pathKey = JSON.stringify(ref.path)
  const stableRef = useMemo<ContentRef>(() => ({ cid, path: JSON.parse(pathKey) as string[] }), [cid, pathKey])
  const key = `${sessionId}:${address}:${revision}`
  const [state, setState] = useState<{ key: string; asset?: AssetLease; error?: GalleryError }>({ key: '' })
  useEffect(() => {
    if (!service || !enabled || !sessionId) return
    let active = true
    const ticket = service.acquire(stableRef, priority)
    ticket.promise.then(asset => {
      if (active) setState({ key, asset })
    }).catch(error => {
      if (active) setState({ key, error: toGalleryError(error) })
    })
    return () => { active = false; ticket.cancel() }
  }, [service, sessionId, stableRef, key, enabled, priority])
  return enabled && state.key === key && (!state.asset || state.asset.active) ? state : { key }
}
