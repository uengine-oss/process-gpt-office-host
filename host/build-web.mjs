// Builds each editor's renderer from the fork with that editor's own
// vite.renderer.config.ts into dist/web/<editor>, with relative asset paths so the
// pages work under any prefix (the host serves them at /office/<editor>/).
//   EDITORS=docs,sheets node build-web.mjs      (default: all eight)
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { viteBrand } from './brand.mjs'
import { findForkRoot } from './fork-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fork = findForkRoot(resolve(here, '..'))
const out = resolve(here, '../dist/web')
const ALL = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'mindmap', 'hwp']
const editors = process.env.EDITORS ? process.env.EDITORS.split(',') : ALL

// The 한글 editor (@rhwp/editor) lives in the app's React state; the host page's live tools and
// click-to-mention (electron-renderer-shim.mjs) need the same object. Every editor createEditor()
// makes is also announced on the window ('ieum-rhwp-editor'). The fork's source is untouched.
function exposeRhwpEditor() {
  return {
    name: 'ieum-expose-rhwp-editor',
    transform(code, id) {
      if (!/[\\/]@rhwp[\\/]editor[\\/]index\.js$/.test(id)) return null
      const marker = 'export async function createEditor('
      if (!code.includes(marker)) throw new Error('expose-rhwp-editor: @rhwp/editor createEditor changed')
      return code.replace(marker, 'async function __ieumCreateEditor(') +
        `\nexport async function createEditor(...args) {
  const editor = await __ieumCreateEditor(...args)
  try { (globalThis.__ieumRhwpEditors ||= []).push(editor); globalThis.dispatchEvent(new CustomEvent('ieum-rhwp-editor', { detail: editor })) } catch {}
  return editor
}\n`
    },
  }
}

for (const editor of editors) {
  const appDir = resolve(fork, 'apps', editor)
  const require = createRequire(resolve(appDir, 'package.json'))
  const { build, loadConfigFromFile, mergeConfig } = await import(require.resolve('vite'))
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve(appDir, 'vite.renderer.config.ts'),
  )
  config.root = isAbsolute(config.root ?? '') ? config.root : resolve(appDir, config.root ?? 'src/renderer')
  delete config.server
  const started = Date.now()
  await build(
    mergeConfig(config, {
      configFile: false,
      base: './',
      logLevel: 'warn',
      build: { outDir: resolve(out, editor), emptyOutDir: true, reportCompressedSize: false },
      plugins: [viteBrand(), exposeRhwpEditor()],
    }),
  )
  console.log(`built ${editor} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}
