// Serves the built editor pages (dist/web/<editor>, made by build-web.mjs) under
// /office/<editor>/ with the editor's preload bundle injected ahead of its entry.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
}

export function staticHandler({ webRoot, preloadRoot, licensesRoot, editors }) {
  const pages = new Map() // editor -> injected index.html
  const indexOf = (editor) => {
    if (!pages.has(editor)) {
      const html = readFileSync(join(webRoot, editor, 'index.html'), 'utf8')
      pages.set(editor, html.replace('<head>', `<head>\n    <script src="../_preload/${editor}.js"></script>`))
    }
    return pages.get(editor)
  }

  // returns true when it answered
  return (req, res, pathname) => {
    const m = /^\/office\/([a-z_]+)(\/.*)?$/.exec(pathname)
    if (!m) return false
    const [, first, rest = ''] = m
    if (first === 'licenses') {
      // the open-source notices that travel with the editors (index.html renders NOTICE.md)
      const name = rest.replace(/^\//, '') || 'index.html'
      const file = resolve(licensesRoot, name)
      if (!file.startsWith(resolve(licensesRoot) + sep) || !existsSync(file)) return notFound(res)
      const type = name.endsWith('.html') ? TYPES['.html'] : name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
      res.writeHead(200, { 'content-type': type })
      createReadStream(file).pipe(res)
      return true
    }
    if (first === '_preload') {
      const editor = rest.replace(/^\//, '').replace(/\.js$/, '')
      const file = join(preloadRoot, `preload-${editor}.js`)
      if (!editors.includes(editor) || !existsSync(file)) return notFound(res)
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' })
      createReadStream(file).pipe(res)
      return true
    }
    if (!editors.includes(first)) return false
    if (!rest) {
      res.writeHead(301, { location: `/office/${first}/` + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') })
      res.end()
      return true
    }
    if (rest === '/' || rest === '/index.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' })
      res.end(indexOf(first))
      return true
    }
    const root = resolve(webRoot, first)
    const file = resolve(root, normalize(decodeURIComponent(rest)).replace(/^[/\\]+/, ''))
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound(res)
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': /\/assets\//.test(rest) ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    createReadStream(file).pipe(res)
    return true
  }
}

function notFound(res) {
  res.writeHead(404)
  res.end()
  return true
}
