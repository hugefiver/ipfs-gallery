import { expect, test } from './fixtures'
import { openPanel } from './gallery-ui'

test('static startup shell remains readable while the application module loads', async ({ page }) => {
  let release!: () => void
  let requested!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const moduleRequest = new Promise<void>(resolve => { requested = resolve })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/assets/*.css', route => route.abort())
  await page.route('**/assets/index-*.js', async route => {
    requested()
    await gate
    await route.continue()
  })
  try {
    await page.goto('/', { waitUntil: 'commit' })
    await moduleRequest
    await expect(page.getByRole('heading', { name: '影像档案', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toBeVisible()
    await expect(page.getByRole('status')).not.toBeEmpty()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    const statusBox = await page.getByRole('status').boundingBox()
    expect(statusBox!.width).toBeGreaterThan(0)
    expect(statusBox!.height).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    release()
  }
  await expect(page.locator('.app-shell')).toBeVisible()
  if (!await page.getByRole('textbox', { name: 'CID 或 IPFS 地址', exact: true }).isVisible()) await openPanel(page, 'source')
  await expect(page.getByRole('textbox', { name: 'CID 或 IPFS 地址', exact: true })).toBeVisible()
  const dialog = page.getByRole('dialog')
  const heading = dialog.getByRole('heading', { level: 2 })
  await expect(heading).toBeVisible()
  await expect(heading).not.toBeEmpty()
  await expect(dialog).toHaveAttribute('aria-labelledby', (await heading.getAttribute('id'))!)
  await expect(dialog).toHaveAccessibleName((await heading.textContent())!)
  await expect(page.getByRole('dialog')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('the static page explains the JavaScript requirement without loading remote media', async ({ browser, baseURL, proxy }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, proxy })
  try {
    const page = await context.newPage()
    const remoteRequests: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).origin !== new URL(baseURL!).origin) remoteRequests.push(request.url())
    })
    await page.goto(baseURL!)
    await expect(page.getByRole('heading', { name: '影像档案', exact: true })).toBeVisible()
    await expect(page.locator('noscript')).toBeVisible()
    await expect(page.locator('noscript')).not.toBeEmpty()
    expect(remoteRequests).toEqual([])
  } finally {
    await context.close()
  }
})
