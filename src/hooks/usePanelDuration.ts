import useMediaQuery from '@mui/material/useMediaQuery'
import { useMemo } from 'react'

export function usePanelDuration(): number {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  return useMemo(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(reduced ? '--motion-reduced' : '--motion-panel')) || 0, [reduced])
}
