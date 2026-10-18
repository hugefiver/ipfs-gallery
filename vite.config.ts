import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'
import { buildPolicyDefines, parseBuildPolicy } from './build/build-policy'
import type { BuildPolicy } from './src/shared/build-policy-defaults'

const buildPolicy = parseBuildPolicy({
  IPFS_GALLERY_GATEWAYS: process.env.IPFS_GALLERY_GATEWAYS,
  IPFS_GALLERY_TRUSTLESS: process.env.IPFS_GALLERY_TRUSTLESS,
})

/** Separate single-file compilation prevents app chunk splitting from leaking into the SW. */
export function serviceWorkerBundle(
  sourceModule = fileURLToPath(new URL('./src/network/ipfs-source.ts', import.meta.url)),
  policy: BuildPolicy = buildPolicy,
): Plugin {
  const entry = 'virtual:ipfs-gallery-service-worker'
  const runtime = fileURLToPath(new URL('./src/service-worker/entry.ts', import.meta.url)).replaceAll('\\', '/')
  async function compile() {
    const output = await build({ configFile: false, publicDir: false, logLevel: 'warn',
      define: buildPolicyDefines(policy),
      plugins: [{ name: 'ipfs-service-worker-entry',
        resolveId(id) { if (id === entry) return `\0${entry}` },
        load(id) {
          if (id === `\0${entry}`) return `import { installServiceWorker } from ${JSON.stringify(runtime)};\nimport { createIpfsBlockSource } from ${JSON.stringify(sourceModule.replaceAll('\\', '/'))};\ninstallServiceWorker(createIpfsBlockSource);`
        } }],
      build: { write: false, target: 'es2022', minify: true,
        lib: { entry, formats: ['es'], fileName: () => 'ipfs-service-worker.js' },
        rolldownOptions: { input: entry, output: { codeSplitting: false } } },
    })
    const outputs = Array.isArray(output) ? output : [output]
    const result = outputs[0]
    if (outputs.length !== 1 || !result || !('output' in result) || result.output.length !== 1 || result.output[0]?.type !== 'chunk') {
      throw new Error('Service Worker must be one self-contained JavaScript bundle')
    }
    const chunk = result.output[0]
    if (chunk.imports.length || chunk.dynamicImports.length) throw new Error('Service Worker cannot import runtime chunks')
    return chunk.code
  }
  let compilation: Promise<string> | undefined
  function compiledScript() {
    compilation ??= compile().finally(() => { compilation = undefined })
    return compilation
  }
  return {
    name: 'ipfs-service-worker-bundle',
    configureServer(server) {
      const scriptPath = `${server.config.base}ipfs-service-worker.js`
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== scriptPath) return next()
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }).end()
          return
        }
        void compiledScript().then(code => {
          response.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          response.end(request.method === 'HEAD' ? undefined : code)
        }).catch(next)
      })
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'ipfs-service-worker.js', source: await compiledScript() })
    },
  }
}

export default defineConfig({
  base: './',
  // Vite also inherits these definitions when compiling Dedicated Workers.
  define: buildPolicyDefines(buildPolicy),
  plugins: [react(), serviceWorkerBundle(undefined, buildPolicy), {
    name: 'inline-entry-styles',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue
        const html = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
        file.source = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, link => {
          const href = link.match(/\bhref="([^"]+)"/)?.[1]
          const css = href && bundle[href.replace(/^\.\//, '')]
          if (!css || css.type !== 'asset' || !css.fileName.endsWith('.css')) return link
          const styles = typeof css.source === 'string' ? css.source : new TextDecoder().decode(css.source)
          return `<style>${styles}</style>`
        })
      }
    },
  }],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
