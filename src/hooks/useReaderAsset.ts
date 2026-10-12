import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MediaContext, ReaderAssetBinding } from '../app/readerAlbumTypes'
import type { ContentRef, GalleryItem } from '../shared/contracts'
import { contentAddress } from '../app/format'
import { MainAssetSet, type MainAssetSnapshot } from './assetService'

const emptyState = {}

export function useReaderAsset(
  { service, sessionId }: MediaContext,
  item: GalleryItem | undefined,
  enabled: boolean,
): ReaderAssetBinding {
  const cid = item?.ref.cid
  const pathKey = JSON.stringify(item?.ref.path ?? [])
  const ref = useMemo<ContentRef | undefined>(() => cid ? { cid, path: JSON.parse(pathKey) as string[] } : undefined, [cid, pathKey])
  const address = ref ? contentAddress(ref) : ''
  const signature = JSON.stringify(address ? [address] : [])
  const ready = !!(enabled && service && sessionId && ref)
  const lifetime = useMemo(() => ({ active: false }), [service, sessionId, ready])
  const owner = useRef<{ lifetime: typeof lifetime; set: MainAssetSet; address: string } | null>(null)
  const [published, setPublished] = useState<{ lifetime: typeof lifetime; snapshot: MainAssetSnapshot }>()

  // Layout cleanup releases reader consumers before the next mode mounts its consumers.
  useLayoutEffect(() => {
    if (!ready || !service) return
    lifetime.active = true
    const current = new MainAssetSet(service, snapshot => {
      if (lifetime.active) setPublished({ lifetime, snapshot })
    })
    const holder = { lifetime, set: current, address: '' }
    owner.current = holder
    return () => {
      lifetime.active = false
      current.dispose()
      if (owner.current === holder) owner.current = null
    }
  }, [service, sessionId, ready, lifetime])

  useLayoutEffect(() => {
    const current = owner.current
    if (!ready || !ref || current?.lifetime !== lifetime) return
    current.address = address
    current.set.update([ref])
  }, [ready, ref, address, lifetime])

  const retry = useCallback(() => {
    const current = owner.current
    if (ready && ref && current?.lifetime === lifetime && lifetime.active && current.address === address) current.set.retry(ref)
  }, [ready, ref, address, lifetime])

  const candidate = ready && lifetime.active && published?.lifetime === lifetime && published.snapshot.signature === signature
    ? published.snapshot.states.get(address) : undefined
  const state = candidate && (!candidate.asset || candidate.asset.active) ? candidate : emptyState
  return { state, retry }
}
