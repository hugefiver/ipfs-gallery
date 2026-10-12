import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { importer } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { CID } from 'multiformats/cid'

const store = new MemoryBlockstore()
let seed = 0x13572468
const expected = Uint8Array.from({ length: 65_539 }, () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed & 255
})
const candidates = [
  { path: 'large.bin', content: expected },
  ...Array.from({ length: 48 }, (_, index) => ({ path: `entry-${index}.bin`, content: Uint8Array.of(index, index + 1) })),
]
let directory
for await (const entry of importer(candidates, store, {
  wrapWithDirectory: true, rawLeaves: true, chunker: fixedSize({ chunkSize: 8192 }), shardSplitThresholdBytes: 128,
})) directory = entry
assert.equal(directory?.unixfs?.type, 'hamt-sharded-directory')
const bundle = await build({
  configFile: false, publicDir: false, logLevel: 'warn',
  build: {
    write: false, target: 'es2023', minify: false,
    lib: { entry: fileURLToPath(new URL('./browser-worker.fixture.ts', import.meta.url)), formats: ['es'], fileName: 'network-worker' },
  },
})
const outputs = Array.isArray(bundle) ? bundle.flatMap((part) => part.output) : bundle.output
const files = new Map(outputs.map((output) => [output.fileName, output.type === 'chunk' ? output.code : output.source]))
assert.ok(files.has('network-worker.js'))

const browser = await chromium.launch({ headless: true, channel: 'chromium' })
try {
  const context = await browser.newContext()
  const requests = []
  await context.route('https://network-fixture.gateway.net/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1)
    await route.fulfill({ status: 200, contentType: path ? 'text/javascript' : 'text/html', body: path ? files.get(path) : '<!doctype html><title>Network Worker fixture</title>' })
  })
  await context.route(/^https:\/\/[ab]\.gateway\.net\/ipfs\//, async (route) => {
    const url = new URL(route.request().url())
    const cid = url.pathname.split('/').at(-1)
    assert.equal(url.searchParams.get('format'), 'raw')
    assert.equal(route.request().headers().accept, 'application/vnd.ipld.raw')
    requests.push({ gateway: url.hostname, cid })
    const chunks = []
    for await (const chunk of store.get(CID.parse(cid))) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    await route.fulfill({
      status: 200, contentType: 'application/vnd.ipld.raw', headers: { 'access-control-allow-origin': '*' },
      body: url.hostname.startsWith('a.') ? Buffer.from([0, 1, 2]) : bytes,
    })
  })
  const page = await context.newPage()
  await page.goto('https://network-fixture.gateway.net/')
  const { DEFAULT_LIMITS } = await import('../../src/shared/limits.ts')
  const cid = directory.cid.toString()
  const result = await page.evaluate((request) => new Promise((resolve, reject) => {
    const worker = new Worker('/network-worker.js', { type: 'module' })
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker fixture deadline')) }, 15_000)
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)) }
    worker.onmessage = (event) => {
      clearTimeout(timer)
      worker.terminate()
      resolve({ ...event.data, bytes: event.data.bytes ? Array.from(new Uint8Array(event.data.bytes)) : undefined })
    }
    worker.postMessage(request)
  }), {
    config: { gateways: ['https://a.gateway.net', 'https://b.gateway.net'], limits: DEFAULT_LIMITS },
    directory: { cid, path: [] }, file: { cid, path: ['large.bin'] },
  })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.stat, { kind: 'directory' })
  assert.equal(result.entries.length, 49)
  assert.deepEqual(result.bytes, Array.from(expected))
  assert.equal(result.gateways[0].state, 'cooldown')
  assert.equal(result.gateways[0].failures, 1)
  assert.ok(result.gateways[1].successes > 49)
  assert.equal(requests.filter((request) => request.gateway === 'a.gateway.net').length, 1)
  console.log(JSON.stringify({ browser: 'Chromium', workerBundle: true, hamtEntries: result.entries.length, exactBytes: expected.length, rawRequests: requests.length, corruptionFallback: true }))
  await context.close()
} finally {
  await browser.close()
}
