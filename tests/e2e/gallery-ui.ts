import { expect, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'

type ToolPanel = 'source' | 'filters' | 'info' | 'network'
const panelNames: Record<ToolPanel, RegExp> = { source: /^来源(?: \(部分可用\))?$/, filters: /^搜索与筛选$/, info: /^当前影像信息$/, network: /^网络$/ }

declare global {
  interface Window {
    mediaTestBlobs?: Map<string, Blob>
  }
}

export async function observeVerifiedBlobs(page: Page | BrowserContext): Promise<void> {
  await page.addInitScript(() => {
    const blobs = new Map<string, Blob>()
    window.mediaTestBlobs = blobs
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = object => {
      const url = create(object)
      if (object instanceof Blob) blobs.set(url, object)
      return url
    }
    URL.revokeObjectURL = url => {
      revoke(url)
      blobs.delete(url)
    }
  })
}

async function verifiedMediaBytes(element: HTMLImageElement | HTMLVideoElement): Promise<number[]> {
  const src = element.currentSrc
  if (!src.startsWith('blob:')) throw new Error('Media must use verified Blob bytes')
  let bytes: ArrayBuffer
  if (window.mediaTestBlobs) {
    const blob = window.mediaTestBlobs.get(src)
    if (!blob) throw new Error(`Missing observed media Blob: ${src}`)
    bytes = await blob.arrayBuffer()
  } else bytes = await (await fetch(src)).arrayBuffer()
  return Array.from(new Uint8Array(bytes))
}

export const ui = {
  surface: (page: Page) => page.getByRole('main', { includeHidden: true }),
  reader: (page: Page) => page.getByRole('region', { name: /^阅读区：/, includeHidden: true }),
  readerSurface: (page: Page) => ui.reader(page).locator('..'),
  album: (page: Page) => page.getByRole('region', { name: '影像相册', exact: true, includeHidden: true }),
  tiles: (page: Page) => ui.album(page).getByRole('button', { name: /^打开 / }),
  tile: (page: Page, title: string) => ui.album(page).getByRole('button', { name: `打开 ${title}`, exact: true }),
  tileImage: (page: Page, title: string) => ui.tile(page, title).locator('..').locator('img'),
  menuButton: (page: Page) => page.getByRole('button', { name: '菜单', exact: true }),
  dialog: (page: Page) => page.getByRole('dialog'),
  closePanel: (page: Page) => ui.dialog(page).getByRole('button', { name: /^关闭/ }).first(),
  back: (page: Page) => ui.dialog(page).getByRole('button', { name: '返回上一级', exact: true }),
  panelAction: (page: Page, panel: ToolPanel) => ui.dialog(page).getByRole('button', { name: panelNames[panel] }),
  albumAction: (page: Page) => ui.dialog(page).getByRole('group', { name: '观看模式', exact: true }).getByRole('button', { name: /^相册(?: · 当前模式)?$/ }),
  readerAction: (page: Page) => ui.dialog(page).getByRole('group', { name: '观看模式', exact: true }).getByRole('button', { name: /^阅读(?: · 当前模式)?$/ }),
  source: (page: Page) => ui.dialog(page).getByRole('textbox', { name: 'CID 或 IPFS 地址', exact: true }),
  submit: (page: Page) => ui.dialog(page).getByRole('form', { name: '打开影像来源', exact: true }).getByRole('button', { name: '打开', exact: true }),
  cancelSource: (page: Page) => ui.surface(page).getByRole('button', { name: '取消', exact: true }),
  filters: (page: Page) => ui.dialog(page).getByRole('region', { name: '筛选已读取影像', exact: true }),
  search: (page: Page) => ui.filters(page).getByRole('searchbox', { name: '搜索', exact: true }),
  sort: (page: Page) => ui.filters(page).getByRole('combobox', { name: '排序', exact: true }),
  next: (page: Page) => page.getByRole('button', { name: '下一项', exact: true }),
  previous: (page: Page) => page.getByRole('button', { name: '上一项', exact: true }),
  zoomIn: (page: Page) => page.getByRole('button', { name: '放大图片', exact: true }),
  resetZoom: (page: Page) => page.getByRole('button', { name: '复位图片', exact: true }),
  readerInfo: (page: Page) => ui.dialog(page).getByRole('button', { name: '影像详情', exact: true }),
  readerTools: (page: Page) => page.getByRole('dialog', { name: '阅读工具', exact: true }),
  download: (scope: Locator, name = '下载经过验证的原始媒体') => scope.getByRole('button', { name, exact: true }),
  settingsDialog: (page: Page) => page.getByRole('dialog', { name: '网络与浏览器偏好', exact: true }),
  gateways: (dialog: Locator) => dialog.getByRole('textbox', { name: /^网关 \d+ HTTPS 地址$/ }),
  saveSettings: (dialog: Locator) => dialog.getByRole('button', { name: '应用并重新读取', exact: true }),
  remember: (dialog: Locator) => dialog.getByRole('checkbox', { name: '保存设置到此浏览器', exact: true }),
  clearSaved: (dialog: Locator) => dialog.getByRole('button', { name: '清除已保存设置并恢复默认', exact: true }),
  storageStatus: (dialog: Locator) => dialog.locator('#preferences-storage-status'),
  clearFilters: (page: Page) => ui.filters(page).getByRole('button', { name: '清除筛选', exact: true }),
  tag: (page: Page, tag: string) => ui.filters(page).getByRole('group', { name: '标签（同时满足所有已选标签，最多 20 个）', exact: true }).getByRole('button', { name: tag, exact: true }),
  type: (page: Page, name: '全部' | '图片' | '视频') => ui.filters(page).getByRole('group', { name: '媒体类型', exact: true }).getByRole('radio', { name, exact: true }),
}

export async function revealAlbumChrome(page: Page): Promise<void> {
  if (await ui.menuButton(page).isVisible()) return
  const surface = await ui.album(page).count() ? ui.album(page) : ui.surface(page)
  await surface.focus()
  await page.keyboard.press('m')
  await expect(ui.menuButton(page)).toBeVisible()
}

export async function openMenu(page: Page): Promise<void> {
  if (await page.getByRole('dialog', { name: '菜单', exact: true }).isVisible()) return
  if (await ui.dialog(page).count()) await page.keyboard.press('Escape')
  if (await ui.album(page).count()) await revealAlbumChrome(page)
  else await expect(ui.menuButton(page)).toBeVisible()
  await ui.menuButton(page).click()
  await expect(page.getByRole('dialog', { name: '菜单', exact: true })).toBeVisible()
}

export async function openPanel(page: Page, panel: ToolPanel): Promise<void> {
  await openMenu(page)
  await ui.panelAction(page, panel).click()
  await expect(ui.dialog(page)).toHaveCount(1)
}

export async function openReaderTools(page: Page): Promise<void> {
  if (await ui.readerTools(page).isVisible()) return
  await openMenu(page)
  await ui.dialog(page).getByRole('button', { name: '阅读工具与下载', exact: true }).click()
  await expect(ui.readerTools(page)).toBeVisible()
  await expect(ui.readerTools(page).locator('[data-reader-tools]')).toBeVisible()
}

export async function enterAlbum(page: Page): Promise<void> {
  if (await ui.album(page).count()) return
  await openMenu(page)
  await ui.albumAction(page).click()
  await expect(ui.album(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(0)
}

export async function enterReader(page: Page): Promise<void> {
  if (await ui.reader(page).count()) return
  await openMenu(page)
  await ui.readerAction(page).click()
  await expect(ui.reader(page)).toBeVisible()
  await expect(ui.dialog(page)).toHaveCount(0)
}

export async function submitSource(page: Page, value: string): Promise<void> {
  if (!await ui.source(page).isVisible()) await openPanel(page, 'source')
  await ui.source(page).fill(value)
  await ui.submit(page).click()
}

export async function selectAlbumItem(page: Page, title: string): Promise<void> {
  await enterAlbum(page)
  const tile = ui.tile(page, title)
  await tile.scrollIntoViewIfNeeded()
  if (await tile.locator('..').locator('video').count()) await tile.press('Enter')
  else await tile.click()
  await expect(ui.reader(page)).toBeVisible()
  await expect(ui.menuButton(page)).toBeVisible()
}

export async function expectReaderImage(page: Page, bytes: Uint8Array): Promise<void> {
  await expectImageBytes(ui.reader(page).getByRole('img', { includeHidden: true }), bytes)
}

export async function expectVideoBytes(video: Locator, expected: Uint8Array): Promise<void> {
  await expect(video).toBeVisible()
  await expect(video).toHaveAttribute('controls', '')
  await expect(video).toHaveAttribute('playsinline', '')
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2)
  expect(await video.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, autoplay: element.autoplay, width: element.videoWidth, height: element.videoHeight })))
    .toEqual({ paused: true, autoplay: false, width: 32, height: 24 })
  const actual = await video.evaluate(verifiedMediaBytes)
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true)
}

export async function expectImageBytes(image: Locator, expected: Uint8Array): Promise<void> {
  await expect(image).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0), { timeout: 30_000 }).toBe(true)
  const actual = await image.evaluate(verifiedMediaBytes)
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true)
}

export async function expectDownloadBytes(page: Page, scope: Locator, expected: Uint8Array, downloadName = '下载经过验证的原始媒体'): Promise<void> {
  const pending = page.waitForEvent('download')
  await ui.download(scope, downloadName).click()
  const download = await pending
  expect(await download.failure()).toBeNull()
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).equals(Buffer.from(expected))).toBe(true)
  expect(Array.from(download.suggestedFilename()).some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32)).toBe(false)
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
