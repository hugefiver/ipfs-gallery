import { CID } from 'multiformats/cid'
import { identity } from 'multiformats/hashes/identity'
import { test, expect } from './fixtures'
import { FIXTURE_GATEWAYS, sourceUrl } from './gateway-route'
import { expectReaderImage, submitSource, ui } from './gallery-ui'
import { createPng } from '../fixtures/media'

const emptyUrl = `/?${new URLSearchParams([
  ['gateway', FIXTURE_GATEWAYS.slow], ['gateway', FIXTURE_GATEWAYS.fast],
])}`

test.describe('active source background maintenance', () => {
  test.use({ directTransport: 'bitswap' })

  test('refreshes providers after foreground idle and retires maintenance on source history removal', async ({ page, galleryFixtures: fixtures, network }) => {
    test.setTimeout(160_000)
    network.slow.setMode({ kind: '404' })
    network.fast.setMode({ kind: '404' })
    const provider = network.provider!
    await page.goto(emptyUrl)
    await submitSource(page, `ipfs://${fixtures.manifests.standalone.ref.cid}`)
    await expectReaderImage(page, fixtures.raw.bytes)
    const discoveries = network.router.events.length
    const opened = provider.records.filter(record => record.type === 'connection:open').length
    expect(opened).toBeGreaterThan(0)

    // Cross the production idle boundary without replacing clocks in either Worker realm.
    await page.waitForTimeout(65_000)
    expect(network.router.events.length).toBeGreaterThan(discoveries)
    await expectReaderImage(page, fixtures.raw.bytes)
    await ui.reader(page).focus()
    await page.keyboard.press('ArrowRight')
    await expectReaderImage(page, fixtures.dagPb.bytes)
    expect(provider.records.filter(record => record.type === 'connection:open')).toHaveLength(opened)

    await page.goBack()
    await expect.poll(() => {
      const query = new URL(page.url()).searchParams
      return ['unixfs', 'cid', 'meta'].some(key => query.has(key))
    }).toBe(false)
    await expect.poll(() => provider.records.reduce((count, record) =>
      count + (record.type === 'connection:open' ? 1 : record.type === 'connection:close' ? -1 : 0), 0),
    ).toBe(0)
    const afterRetirement = {
      routing: network.router.events.length,
      http: network.httpProvider.events.length,
      slow: network.slow.requests.length,
      fast: network.fast.requests.length,
      wants: provider.records.filter(record => record.type === 'want').length,
    }
    // A retired session must not restart at the next production heartbeat.
    await page.waitForTimeout(25_000)
    expect({
      routing: network.router.events.length,
      http: network.httpProvider.events.length,
      slow: network.slow.requests.length,
      fast: network.fast.requests.length,
      wants: provider.records.filter(record => record.type === 'want').length,
    }).toEqual(afterRetirement)
    expect(provider.instrumentationErrors).toEqual([])
  })
})

test('keeps discovering a valid source after its foreground read fails', async ({ page, galleryFixtures: fixtures, network }) => {
  test.setTimeout(60_000)
  network.slow.setMode({ kind: '404' })
  network.fast.setMode({ kind: '404' })
  await page.goto(emptyUrl)
  await submitSource(page, `ipfs://${fixtures.raw.cid}`)
  await expect(ui.surface(page).getByRole('button', { name: '重试', exact: true })).toBeVisible()
  const initialDiscoveries = network.router.events.filter(event => event.cid === fixtures.raw.cid).length
  expect(initialDiscoveries).toBeGreaterThan(0)
  await expect.poll(() => network.router.events.filter(event => event.cid === fixtures.raw.cid).length,
    { timeout: 45_000, intervals: [1000] }).toBeGreaterThan(initialDiscoveries)
  await expect(ui.surface(page).getByRole('button', { name: '重试', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('unixfs')).toBe(true)
})

test('discovers a failed external asset from an identity manifest without querying the identity CID', async ({ page, galleryFixtures: fixtures, network }) => {
  test.setTimeout(100_000)
  network.slow.setMode({ kind: '404' })
  network.fast.setMode({ kind: '404' })
  const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, items: [{ cid: fixtures.raw.cid }] }))
  const inline = CID.createV1(0x55, identity.digest(manifest)).toString()
  await page.goto(emptyUrl)
  await submitSource(page, inline)
  await expect(page.getByRole('alert').first()).toBeVisible()
  const discoveries = network.router.events.filter(event => event.cid === fixtures.raw.cid).length
  expect(discoveries).toBeGreaterThan(0)
  await expect.poll(() => network.router.events.filter(event => event.cid === fixtures.raw.cid).length,
    { timeout: 45_000, intervals: [1000] }).toBeGreaterThan(discoveries)
  expect(network.router.events.some(event => event.cid === inline)).toBe(false)
  await expect(page.getByRole('alert').first()).toBeVisible()

  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.has('unixfs')).toBe(false)
  const retired = network.router.events.length
  await page.waitForTimeout(25_000)
  expect(network.router.events).toHaveLength(retired)
})

test('samples a recovered gateway while the rendered source stays idle', async ({ page, galleryFixtures: fixtures, network }) => {
  test.setTimeout(120_000)
  network.slow.setMode({ kind: '429', retryAfter: '1' })
  network.fast.setMode({ kind: 'correct' })
  await page.goto(sourceUrl('unixfs', fixtures.raw.ref))
  await expectReaderImage(page, fixtures.raw.bytes)
  expect(network.slow.requests.some(request => request.cid === fixtures.raw.cid && request.status === 429)).toBe(true)
  expect(network.fast.requests.some(request => request.cid === fixtures.raw.cid && request.status === 200)).toBe(true)
  const previousRequests = network.slow.requests.length
  network.slow.setMode({ kind: 'correct' })

  // No foreground action or cache lookup can account for a fresh endpoint response here.
  await expect.poll(() => network.slow.requests.slice(previousRequests)
    .some(request => request.cid === fixtures.raw.cid && request.status === 200),
  { timeout: 100_000, intervals: [1000] }).toBe(true)
  await expectReaderImage(page, fixtures.raw.bytes)
})

test('empty and identity-only sessions remain network silent beyond a maintenance tick', async ({ page, network }) => {
  test.setTimeout(70_000)
  await page.goto(emptyUrl)
  await expect(page.locator('#root')).not.toBeEmpty()
  await page.waitForTimeout(21_000)
  expect(network.router.events).toEqual([])
  expect(network.slow.requests).toEqual([])
  expect(network.fast.requests).toEqual([])
  const bytes = createPng(1, 1, 19)
  const cid = CID.createV1(0x55, identity.digest(bytes)).toString()
  await submitSource(page, cid)
  await expectReaderImage(page, bytes)
  await page.waitForTimeout(21_000)
  expect(network.router.events).toEqual([])
  expect(network.httpProvider.events).toEqual([])
  expect(network.slow.requests).toEqual([])
  expect(network.fast.requests).toEqual([])
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(records => records.length))).toBe(0)
})
