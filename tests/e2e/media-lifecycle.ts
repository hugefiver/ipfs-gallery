import type { Page } from '@playwright/test'

declare global {
  interface Window {
    mediaTestEvents: { type: string; url: string }[]
  }
}

export async function captureMediaLifecycle(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.mediaTestEvents = []
    for (const type of ['load', 'error']) document.addEventListener(type, event => {
      if (!(event.target instanceof HTMLImageElement)) return
      const url = event.target.currentSrc || event.target.src
      if (url.startsWith('blob:')) window.mediaTestEvents.push({ type: event.type, url })
    }, true)
  })
}

export function mediaEvents(page: Page) {
  return page.evaluate(() => window.mediaTestEvents)
}
