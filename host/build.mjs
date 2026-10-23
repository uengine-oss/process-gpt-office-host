// Bundles the two halves that run the fork's code unchanged on the web:
//   dist/office-host.mjs        editors' main-process modules + WebSocket host (Node)
//   dist/preload-<editor>.js    each editor's preload for the browser
// In both, `electron` resolves to the matching shim. npm packages stay external
// (resolved from the fork's node_modules); the fork's own TS sources are bundled.
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { esbuildBrand } from './brand.mjs'
import { findForkRoot } from './fork-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fork = findForkRoot(resolve(here, '..'))
const out = resolve(here, 'dist')
const editors = (process.env.EDITORS || 'docs,sheets,slides,pdf,markdown,html,mindmap,hwp').split(',')

// bundle the fork's TS (@ieum/… from this folder, then relative paths and @genoffice/*),
// leave other packages to Node; electron and the desktop-only electron-updater answer
// from the shim
const nodeExternals = {
  name: 'node-externals',
  setup(b) {
    b.onResolve({ filter: /^@ieum\// }, (args) =>
      b.resolve(`./${args.path.slice('@ieum/'.length)}`, { resolveDir: fork, kind: args.kind }),
    )
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path === 'electron' || args.path === 'electron-updater') {
        return { path: resolve(here, 'electron-main-shim.mjs') }
      }
      if (args.path.startsWith('@genoffice/')) return undefined
      return { path: args.path, external: true }
    })
  },
}

// Vite-style `?raw` / `?url` imports used by the fork's packages
const viteQueries = {
  name: 'vite-queries',
  setup(b) {
    b.onResolve({ filter: /\?(raw|url)$/ }, (args) => {
      const [file, query] = args.path.split('?')
      return { path: resolve(args.resolveDir, file), namespace: `vite-${query}` }
    })
    b.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }))
    b.onLoad({ filter: /.*/, namespace: 'vite-url' }, (args) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(args.path).href)}`,
      loader: 'js',
    }))
  },
}

// The CLI's command layer (office-worker) finds jsdom, the PDF/HWP WASM and the xlsx
// sidecar from the repository root, which it looks up from its own location; bundled
// here it is somewhere else, so it reads the fork root from IEUM_FORK_ROOT first.
const forkRoot = {
  name: 'fork-root',
  setup(b) {
    b.onLoad({ filter: /[\\/]packages[\\/]cli[\\/]src[\\/]resources\.ts$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8')
      const marker = 'export function repoRoot(): string | null {'
      if (!code.includes(marker)) throw new Error('fork-root: packages/cli/src/resources.ts changed')
      return {
        contents: code.replace(marker, `${marker}\n  if (process.env.IEUM_FORK_ROOT) return process.env.IEUM_FORK_ROOT`),
        loader: 'ts',
      }
    })
  },
}

await build({
  entryPoints: [resolve(here, 'office-host.mjs')],
  outfile: resolve(out, 'office-host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [esbuildBrand(), forkRoot, viteQueries, nodeExternals],
  // main-process code uses __dirname/require; give the ESM bundle both
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
  loader: { '.wasm': 'file', '.png': 'file', '.ttf': 'file', '.woff2': 'file' },
  logLevel: 'warning',
})

for (const editor of editors) {
  await build({
    entryPoints: [resolve(fork, 'apps', editor, 'src/preload/index.ts')],
    outfile: resolve(out, `preload-${editor}.js`),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    alias: { electron: resolve(here, 'electron-renderer-shim.mjs') },
    plugins: [esbuildBrand(), viteQueries],
    // preloads read a few process fields (platform, env, versions) the page lacks
    banner: { js: "var process = globalThis.process || { platform: 'web', env: {}, versions: {}, argv: [] };" },
    define: {
      'process.env.NODE_ENV': '"development"',
      __IEUM_EDITOR__: JSON.stringify(editor),
    },
    logLevel: 'warning',
  })
}
console.log(`built host + preloads: ${editors.join(', ')}`)
