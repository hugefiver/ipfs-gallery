import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react(), {
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
