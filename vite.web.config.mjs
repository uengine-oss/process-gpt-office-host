// Development: serves one editor renderer (from the untouched fork) with HMR, using
// that editor's own vite.renderer.config.ts, its preload bundle (host/dist) injected
// ahead of the entry, and the IPC/proto routes proxied to a running office-host.
// Production does not use this: office-host serves the built pages (build-web.mjs).
//   EDITOR=docs PORT=5296 npx vite --config vite.web.config.mjs    (vite from the fork's node_modules)
//   → http://localhost:5296/?src=sample.docx
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { viteBrand } from './host/brand.mjs'
import { findForkRoot } from './host/fork-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fork = findForkRoot(here)
const editor = process.env.EDITOR || 'docs'
const host = `localhost:${process.env.IEUM_HOST_PORT || 5390}`
const appDir = resolve(fork, 'apps', editor)
const require = createRequire(resolve(appDir, 'package.json'))
const { loadConfigFromFile, mergeConfig } = await import(require.resolve('vite'))

function preload() {
  return {
    name: 'ieum-preload',
    transformIndexHtml(html) {
      return html.replace('<head>', '<head>\n    <script src="/__preload.js"></script>')
    },
    configureServer(server) {
      server.middlewares.use('/__preload.js', (_req, res) => {
        res.setHeader('content-type', 'text/javascript')
        res.end(readFileSync(resolve(here, `host/dist/preload-${editor}.js`)))
      })
    },
  }
}

const { config: own } = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  resolve(appDir, 'vite.renderer.config.ts'),
)
// the editor configs give root relative to their own folder (they run from there)
own.root = isAbsolute(own.root ?? '') ? own.root : resolve(appDir, own.root ?? 'src/renderer')
delete own.server

export default mergeConfig(own, {
  plugins: [viteBrand(), preload()],
  server: {
    port: Number(process.env.PORT) || 5296,
    strictPort: true,
    fs: { allow: [fork, here] },
    proxy: {
      '/__ipc': { target: `ws://${host}`, ws: true },
      '/__proto': { target: `http://${host}` },
    },
  },
})
