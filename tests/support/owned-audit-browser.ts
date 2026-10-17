import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type BrowserContext, type Page } from 'playwright'

export const AUDIT_TEMP_PARENT = tmpdir()
const OWNER_MARKER = '.ocmm-run-owner'
export const OWNED_CLOSE_BUDGET_MS = 35_000

export function waitForOwnedAudit<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export async function withinOwnedAuditBudget<T>(work: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`${phase} exceeded its ${milliseconds}ms owned-audit budget`)), milliseconds)
  try {
    return await waitForOwnedAudit(work, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export interface OwnedAuditBrowser {
  context: BrowserContext
  page: Page
  port: number
  runRoot: string
  close(): Promise<void>
}

export async function removeOwnedRunRoot(runRoot: string, ownershipToken: string): Promise<void> {
  const tempRoot = await realpath(AUDIT_TEMP_PARENT)
  const resolvedRunRoot = await realpath(runRoot)
  const marker = join(resolvedRunRoot, OWNER_MARKER)
  if (
    resolvedRunRoot !== runRoot ||
    dirname(resolvedRunRoot) !== tempRoot ||
    !/^ipfs-gallery-lighthouse-[A-Za-z0-9_-]+$/.test(basename(resolvedRunRoot)) ||
    (await lstat(runRoot)).isSymbolicLink() ||
    !(await lstat(marker)).isFile() ||
    (await readFile(marker, 'utf8')) !== ownershipToken
  ) {
    throw new Error('Refusing to remove an audit profile without exact run ownership')
  }
  await rm(resolvedRunRoot, { recursive: true, force: false })
}

export async function readOwnedCdpPort(userDataDir: string, launchStartedAt: number, signal?: AbortSignal): Promise<number> {
  const activePortFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 10_000
  let lastError: unknown
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      const [portText, browserPath] = (await readFile(activePortFile, 'utf8')).trim().split(/\r?\n/)
      const port = Number(portText)
      const metadata = await stat(activePortFile)
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[^/]+$/.test(browserPath ?? '')) {
        throw new Error('Chromium wrote invalid endpoint metadata')
      }
      if (metadata.mtimeMs < launchStartedAt - 1_000) {
        throw new Error('Endpoint metadata predates this Chromium launch')
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new Error('Endpoint readiness budget expired')
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]) : AbortSignal.timeout(remainingMs),
      })
      if (!response.ok) throw new Error(`Endpoint probe returned HTTP ${response.status}`)
      const version = await response.json() as { webSocketDebuggerUrl?: string }
      if (!version.webSocketDebuggerUrl) throw new Error('Endpoint probe omitted its browser WebSocket URL')
      const endpoint = new URL(version.webSocketDebuggerUrl)
      if (
        endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
        endpoint.port !== String(port) || endpoint.pathname !== browserPath ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      ) {
        throw new Error('Endpoint does not match this launch’s profile metadata')
      }
      return port
    } catch (error) {
      signal?.throwIfAborted()
      lastError = error
      await delay(Math.min(100, Math.max(0, deadline - Date.now())))
    }
  }
  throw new Error('Run-owned Chromium endpoint did not become ready', { cause: lastError })
}

export async function launchOwnedAuditBrowser(signal?: AbortSignal): Promise<OwnedAuditBrowser> {
  signal?.throwIfAborted()
  const tempRoot = await realpath(AUDIT_TEMP_PARENT)
  if (!(await stat(tempRoot)).isDirectory()) throw new Error('Approved audit temp parent is not a directory')
  const runRoot = await mkdtemp(join(tempRoot, 'ipfs-gallery-lighthouse-'))
  const token = randomUUID()
  let context: BrowserContext | undefined
  try {
    await writeFile(join(runRoot, OWNER_MARKER), token, { flag: 'wx' })
    const userDataDir = join(runRoot, 'user-data')
    await mkdir(userDataDir)
    const launchStartedAt = Date.now()
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      timeout: 30_000,
      viewport: { width: 1350, height: 940 },
      serviceWorkers: 'block',
      args: [
        '--disable-extensions',
        '--disable-sync',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
    })
    signal?.throwIfAborted()
    const port = await readOwnedCdpPort(userDataDir, launchStartedAt, signal)
    const ownedContext = context
    const page = ownedContext.pages()[0] ?? await ownedContext.newPage()
    let closing: Promise<void> | undefined
    return {
      context: ownedContext,
      page,
      port,
      runRoot,
      // Browser.close reaches the owned process even if context/route disposal is blocked.
      close: () => closing ??= withinOwnedAuditBudget((async () => {
        await ownedContext.browser()!.close()
        await removeOwnedRunRoot(runRoot, token)
      })(), OWNED_CLOSE_BUDGET_MS, `Owned browser cleanup (${runRoot})`).catch(error => {
        closing = undefined
        throw error
      }),
    }
  } catch (error) {
    const errors = [error]
    try {
      await withinOwnedAuditBudget((async () => {
        if (context) await context.browser()!.close()
        await removeOwnedRunRoot(runRoot, token)
      })(), OWNED_CLOSE_BUDGET_MS, `Owned launch cleanup (${runRoot})`)
    } catch (cleanupError) {
      errors.push(cleanupError)
    }
    if (errors.length > 1) throw new AggregateError(errors, `Audit launch and owned cleanup failed (${runRoot})`, { cause: error })
    throw error
  }
}
