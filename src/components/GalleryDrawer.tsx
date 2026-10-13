import { cloneElement, forwardRef, useLayoutEffect, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import Drawer from '@mui/material/Drawer'
import Slide, { type SlideProps } from '@mui/material/Slide'
import type { PaperProps } from '@mui/material/Paper'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useForkRef } from '@mui/material/utils'
import { GalleryChrome } from './GalleryChrome'
import { ArrowLeftIcon, XIcon } from '@phosphor-icons/react'
import { Action } from './Primitives'

type DrawerPaper = ReactElement<PaperProps & { ref?: Ref<HTMLDivElement>; children: ReactNode[] }>

// Keep the toggle stationary inside the MUI focus scope; only the opaque sidebar slides.
const FixedMenuSlide = forwardRef<HTMLDivElement, Omit<SlideProps, 'children'> & { children: DrawerPaper }>(function FixedMenuSlide({ children, ...transition }, ref) {
  const mergedRef = useForkRef(children.props.ref, ref)
  const [toggle, content] = children.props.children
  return cloneElement(children, { ref: mergedRef, children: [toggle, <Slide key="sidebar" {...transition} easing="var(--ease-feedback)">{content as ReactElement}</Slide>] })
})

export function GalleryDrawer({ open, onClose, onBack, isSubpanel, cardMode, title, labelledBy, focusKey, focusTarget, children }: {
  open: boolean; onClose: () => void; onBack?: () => void; isSubpanel?: boolean; cardMode?: boolean; title: string; labelledBy: string; focusKey: string | null; focusTarget?: string; children: ReactNode
}) {
  const [paper, setPaper] = useState<HTMLDivElement | null>(null)
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [duration] = useState(() => {
    const time = getComputedStyle(document.documentElement).getPropertyValue('--motion-panel').trim()
    return parseFloat(time) * (time.endsWith('ms') ? 1 : 1000)
  })
  useLayoutEffect(() => {
    const element = paper
    if (!element || !open) return
    const target = focusTarget ? element.querySelector<HTMLElement>(focusTarget) : null
    ;(target ?? element.querySelector<HTMLElement>('[data-modal-close]'))?.focus()
  }, [open, focusKey, focusTarget, paper])
  useLayoutEffect(() => {
    const element = paper
    if (!element || !open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) {
        if (event.key === 'Escape') event.stopPropagation()
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const controls = Array.from(element.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]'))
          .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[hidden],[inert]') && control.getClientRects().length > 0 && getComputedStyle(control).visibility !== 'hidden')
        const edge = event.shiftKey ? controls[0] : controls.at(-1)
        const target = event.shiftKey ? controls.at(-1) : controls[0]
        if (target && document.activeElement === edge) { event.preventDefault(); event.stopPropagation(); target.focus() }
      }
    }
    element.addEventListener('keydown', onKey)
    return () => element.removeEventListener('keydown', onKey)
  }, [open, onClose, paper])
  return <Drawer open={open} anchor="left" variant="temporary" elevation={0} className={`gallery-drawer${open ? '' : ' is-closed'}${cardMode ? ' is-card-mode' : ''}`} slots={{ transition: FixedMenuSlide }}
    transitionDuration={reduceMotion ? 0 : duration}
    ModalProps={{ keepMounted: true, disableRestoreFocus: true, closeAfterTransition: false }}
    onClose={(_event, reason) => { if (reason === 'backdropClick') onClose() }}
    slotProps={{ paper: { ref: setPaper, id: 'gallery-panel', 'aria-labelledby': labelledBy, 'aria-hidden': !open, inert: !open, className: 'gallery-drawer-paper' }, backdrop: { className: 'gallery-drawer-backdrop' } }}>
    {open ? (
      isSubpanel && onBack ? (
        <Action key="back" className="reader-menu-trigger" aria-label="返回上一级" onClick={onBack}><ArrowLeftIcon aria-hidden="true" /></Action>
      ) : (
        <GalleryChrome key="toggle" mode="reader" menuOpen onMenu={onClose} onHide={onClose} />
      )
    ) : null}
    <section className="gallery-drawer-surface">
      <header className="gallery-drawer-toolbar">
        <span className="gallery-drawer-toggle-space" aria-hidden="true" />
        <h2 id={labelledBy}>{title}</h2>
        <Action className="gallery-drawer-close" data-modal-close aria-label={`关闭${title}`} onClick={onClose}><XIcon aria-hidden="true" /></Action>
      </header>
      <div className="gallery-drawer-content">{children}</div>
    </section>
  </Drawer>
}
