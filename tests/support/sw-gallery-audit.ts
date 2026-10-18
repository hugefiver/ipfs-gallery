import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright'
import { AUDIT_TEMP_PARENT, OWNED_CLOSE_BUDGET_MS, readOwnedCdpPort, removeOwnedRunRoot, withinOwnedAuditBudget, type OwnedAuditBrowser } from './owned-audit-browser'
import type { SwGalleryNetwork } from './sw-gallery-network'
import { observeVerifiedBlobs } from '../e2e/gallery-ui'

/** Uses the existing owned-profile/CDP identity checks with SW-capable launch settings. */
export async function launchSwGalleryAuditBrowser(network: SwGalleryNetwork, signal?: AbortSignal): Promise<OwnedAuditBrowser> {
  signal?.throwIfAborted()
  const runRoot = await mkdtemp(join(await realpath(AUDIT_TEMP_PARENT), 'ipfs-gallery-lighthouse-'))
  const token = randomUUID()
  let context: BrowserContext | undefined
  try {
    await writeFile(join(runRoot, '.ocmm-run-owner'), token, { flag: 'wx' })
    const userDataDir = join(runRoot, 'user-data')
    await mkdir(userDataDir)
    const launchedAt = Date.now()
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: false, timeout: 30_000,
      viewport: { width: 1350, height: 940 }, serviceWorkers: 'allow',
      args: ['--disable-extensions', '--disable-sync', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', ...network.chromiumArgs],
    })
    await observeVerifiedBlobs(context)
    signal?.throwIfAborted()
    const port = await readOwnedCdpPort(userDataDir, launchedAt, signal)
    const owned = context
    let closing: Promise<void> | undefined
    return {
      context: owned, page: owned.pages()[0] ?? await owned.newPage(), port, runRoot,
      close: () => closing ??= withinOwnedAuditBudget((async () => {
        await owned.browser()!.close()
        await removeOwnedRunRoot(runRoot, token)
      })(), OWNED_CLOSE_BUDGET_MS, 'SW audit browser cleanup'),
    }
  } catch (error) {
    try {
      await withinOwnedAuditBudget((async () => {
        if (context) await context.browser()!.close()
        await removeOwnedRunRoot(runRoot, token)
      })(), OWNED_CLOSE_BUDGET_MS, 'SW audit launch cleanup')
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SW audit launch and cleanup failed', { cause: cleanupError }) }
    throw error
  }
}
