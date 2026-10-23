// Collects the notices that must travel with the editors (Apache-2.0 §4) into
// dist/licenses: the fork's LICENSE / NOTICE / LICENSE-UNICODE, its generated
// THIRD-PARTY-NOTICES (bundled npm packages, fonts, WASM) and our NOTICE.md,
// plus index.html: NOTICE.md as a page people can read, linking the full texts.
// The host serves the folder at /office/licenses/.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findForkRoot } from './fork-root.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fork = findForkRoot(resolve(here, '..'))
const out = resolve(here, '../dist/licenses')
mkdirSync(out, { recursive: true })

// the generator writes a git-ignored build artifact inside the fork
execFileSync('node', ['tools/gen-third-party-notices.mjs'], { cwd: fork, stdio: 'inherit' })
for (const [from, to] of [
  ['LICENSE', 'LICENSE'],
  ['NOTICE', 'NOTICE'],
  ['LICENSE-UNICODE.txt', 'LICENSE-UNICODE.txt'],
  ['apps/shell/build/THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt'],
]) copyFileSync(resolve(fork, from), resolve(out, to))
copyFileSync(resolve(here, '../NOTICE.md'), resolve(out, 'NOTICE.md'))
writeFileSync(resolve(out, 'index.html'), page(readFileSync(resolve(here, '../NOTICE.md'), 'utf8')))
console.log(`licenses → ${out}`)

// just the markdown NOTICE.md uses: headings, paragraphs, (nested) lists, tables,
// code fences, quotes, **bold**, `code` and links
function page(md) {
  const shipped = new Set(['LICENSE', 'NOTICE', 'LICENSE-UNICODE.txt', 'THIRD-PARTY-NOTICES.txt', 'NOTICE.md'])
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${shipped.has(c) ? `<a href="${c}">${c}</a>` : c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s),]+)/g, '<a href="$1">$1</a>')
  const html = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const body = []
      while (++i < lines.length && !lines[i].startsWith('```')) body.push(esc(lines[i]))
      html.push(`<pre>${body.join('\n')}</pre>`)
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(' ')
      html.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`)
    } else if (line.startsWith('|')) {
      const rows = []
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()))
      i--
      const [head, , ...body] = rows
      html.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`)
    } else if (/^\s*- /.test(line)) {
      let depth = -1
      for (; i < lines.length && /^\s*- /.test(lines[i]); i++) {
        const d = lines[i].search(/\S/) / 2
        while (depth < d) html.push('<ul>'), depth++
        while (depth > d) html.push('</ul>'), depth--
        html.push(`<li>${inline(lines[i].trim().slice(2))}</li>`)
      }
      i--
      while (depth-- >= 0) html.push('</ul>')
    } else if (line.startsWith('> ')) {
      html.push(`<blockquote>${inline(line.slice(2))}</blockquote>`)
    } else if (line.trim()) {
      html.push(`<p>${inline(line)}</p>`)
    }
  }
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>오픈소스 고지</title>
<style>
  body { margin: 0; background: #fff; color: #1f2328; font: 15px/1.7 system-ui, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 16px; } h2 { font-size: 19px; margin: 32px 0 8px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
  pre, code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: #f4f5f7; border-radius: 4px; }
  pre { padding: 12px 14px; overflow-x: auto; } code { padding: 1px 5px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; } th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f8f9fb; } blockquote { margin: 8px 0; padding: 8px 14px; border-left: 3px solid #3949ab; background: #f5f6fc; }
  a { color: #3949ab; } ul { padding-left: 22px; margin: 4px 0; }
</style></head>
<body><main>${html.join('\n')}</main></body></html>
`
}
