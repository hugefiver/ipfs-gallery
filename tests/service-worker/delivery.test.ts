import { describe, expect, it } from 'vitest'
import { createServer } from 'vite'
import { serviceWorkerBundle } from '../../vite.config'

describe('Service Worker development delivery', () => {
  for (const base of ['/', '/gallery/']) {
    it(`serves the executable worker at ${base}`, async () => {
      const server = await createServer({
        configFile: false, base, plugins: [serviceWorkerBundle()],
        server: { host: '127.0.0.1', port: 0 },
      })
      try {
        await server.listen()
        const address = server.httpServer!.address()
        if (!address || typeof address === 'string') throw new Error('Missing owned development listener')
        const url = `http://127.0.0.1:${address.port}${base}ipfs-service-worker.js`
        const response = await fetch(url)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toMatch(/^(text|application)\/javascript\b/)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
        const rejected = await fetch(url, { method: 'POST' })
        expect(rejected.status).toBe(405)
        expect(rejected.headers.get('allow')).toBe('GET, HEAD')
      } finally {
        await server.close()
      }
    }, 30_000)
  }
})
