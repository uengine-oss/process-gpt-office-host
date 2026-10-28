// The editor page's half of what a framing page (pgpt-pro) adds on top of the editors, bundled
// into every editor's preload with the renderer shim. The fork's source is untouched: the 한글
// editor object comes from build-web.mjs (exposeRhwpEditor), the rest is the page's DOM.
//
// - Click to mention (`?assistant=parent`): with the parent's mention mode on (or ⌥/Alt held), a
//   click on a table, an image, a paragraph (워드·한글) or a cell range (엑셀) is told to the parent
//   as { type: 'mention', mention: { editor, kind, label, ...where } } — enough for the live tools
//   to address the same object (table number and cell, picture number, range, text anchor).
// - 한글 live session: the 한글 editor has no MCP bridge of its own, so this page answers the
//   host's `hwp:mcp-command` (live.mjs) with the editor's agent plugin (tables, text) and its
//   document bytes; the host's office_live_* tools reach the open 한글 document through it.
// - Pictures (한글, 워드): the parent asks for picture N's bytes (to edit it in another app) and later
//   hands back new bytes. 한글: the document is rewritten with only that picture changed and
//   reloaded. 워드: the picture's node takes the new bytes the way the ribbon's 「그림 바꾸기」 does
//   (imageReplace — the drawing, its place, size and wrap stay; saving writes the new bytes).
// - Words the page itself writes (mention chips, errors) follow the page's `lang=en|ko`, like the
//   editors' own UI (electron-renderer-shim.mjs); without it, Korean as before.

// ---------------------------------------------------------------- the page's language
let lang = 'ko'
const L = (ko, en) => (lang === 'en' ? en : ko)

// ---------------------------------------------------------------- zip (hwpx is a zip)
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (u8) => {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
/** entries of a zip, in order: { name, data } (central directory; stored or deflated) */
export async function unzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let eocd = -1
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = []
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen))
    const lNameLen = dv.getUint16(local + 26, true)
    const lExtraLen = dv.getUint16(local + 28, true)
    const raw = u8.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize)
    out.push({ name, data: method === 8 ? await inflateRaw(raw) : raw.slice() })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
/** a stored (uncompressed) zip of entries, in their order — mimetype first, as HWPX/OCF wants */
export function zip(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const nm = enc.encode(name)
    const crc = crc32(data)
    const head = new Uint8Array(30 + nm.length)
    const h = new DataView(head.buffer)
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true)
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true)
    h.setUint16(26, nm.length, true); head.set(nm, 30)
    const c = new Uint8Array(46 + nm.length)
    const d = new DataView(c.buffer)
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true)
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true)
    d.setUint16(28, nm.length, true); d.setUint32(42, offset, true); c.set(nm, 46)
    parts.push(head, data)
    central.push(c)
    offset += head.length + data.length
  }
  const size = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true)
  e.setUint32(12, size, true); e.setUint32(16, offset, true)
  const all = new Uint8Array(offset + size + 22)
  let at = 0
  for (const x of [...parts, ...central, end]) { all.set(x, at); at += x.length }
  return all
}

// ---------------------------------------------------------------- 한글: the editor and its pictures
const hwpEditor = () => globalThis.__ieumRhwpEditors?.at(-1) || null
const agent = (method, ...args) => hwpEditor().plugins.invoke('ieum-agent', method, args)

/** the document's pictures in reading order: { n, id, path, media } (BinData via content.hpf) */
async function hwpPictures(entries) {
  const dec = new TextDecoder()
  const text = (name) => dec.decode(entries.find((e) => e.name === name)?.data || new Uint8Array())
  const hpf = text('Contents/content.hpf')
  const items = new Map([...hpf.matchAll(/<opf:item\b[^>]*>/g)].map((m) => {
    const tag = m[0]
    const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(tag) || [])[1]
    return [attr('id'), { path: attr('href'), media: attr('media-type') }]
  }))
  const sections = entries.map((e) => e.name).filter((n) => /^Contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const out = []
  for (const s of sections) {
    for (const m of text(s).matchAll(/<hp:pic\b[\s\S]*?binaryItemIDRef="([^"]+)"/g)) {
      const item = items.get(m[1])
      if (item?.path) out.push({ n: out.length + 1, id: m[1], ...item })
    }
  }
  return out
}
async function hwpPicture(n) {
  const ed = hwpEditor()
  if (!ed) throw new Error(L('한글 편집기가 아직 열리지 않았습니다', 'The Hangul editor is not open yet'))
  const entries = await unzip(await ed.exportHwpx())
  const pics = await hwpPictures(entries)
  const pic = pics[(n || 1) - 1]
  if (!pic) throw new Error(L(`그림 ${n} 이 문서에 없습니다(그림 ${pics.length}개)`, `Picture ${n} is not in the document (${pics.length} picture${pics.length === 1 ? '' : 's'})`))
  return { entries, pic, count: pics.length }
}
/** picture N's bytes, to be edited elsewhere */
export async function hwpPictureBytes(n) {
  const { entries, pic, count } = await hwpPicture(n)
  const data = entries.find((e) => e.name === pic.path).data
  return { n: pic.n, count, name: pic.path.split('/').pop(), media: pic.media, bytes: data }
}
/** put new bytes in place of picture N and reload the document (same name, same place) */
export async function hwpReplacePicture(n, bytes, fileName) {
  const ed = hwpEditor()
  const { entries, pic } = await hwpPicture(n)
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const next = entries.map((e) => (e.name === pic.path ? { name: e.name, data } : e))
  // PNG bytes under a .jpg name (or the other way) would not decode: keep the bytes' own type
  const png = data[0] === 0x89 && data[1] === 0x50
  const ext = png ? 'png' : 'jpg'
  const media = png ? 'image/png' : 'image/jpeg'
  if (!pic.path.toLowerCase().endsWith(`.${ext}`)) {
    const path = pic.path.replace(/\.[a-z0-9]+$/i, `.${ext}`)
    for (const e of next) {
      if (e.name === pic.path) e.name = path
      if (/content\.hpf$|manifest\.xml$/.test(e.name)) {
        const s = new TextDecoder().decode(e.data).split(pic.path).join(path).replace(
          new RegExp(`(href="${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*media-type=")[^"]*`), `$1${media}`)
        e.data = new TextEncoder().encode(s)
      }
    }
  }
  const out = zip(next)
  // the reload scrolls to the top: keep the reader where they were
  const scroller = () => { try { return ed.element.contentDocument.getElementById('scroll-container') } catch { return null } }
  const top = scroller()?.scrollTop || 0
  await ed.loadFile(out, fileName || 'document.hwpx', { skipUnsavedGuard: true })
  for (const ms of [300, 900, 1800]) setTimeout(() => { const s = scroller(); if (s) s.scrollTop = top }, ms)
  return { replaced: pic.n, bytes: out.length }
}

// ---------------------------------------------------------------- 워드: its pictures
// tiptap puts the editor on its root element; the document's pictures are its image nodes, in order:
// block pictures (docProtected, blockType 'image' — a picture on its own line) and inline ones
const docsEditor = () => document.querySelector('.ProseMirror')?.editor || null
function docsPictures(ed) {
  const out = []
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'docProtected' && node.attrs.blockType === 'image') out.push({ n: out.length + 1, pos, node, src: node.attrs.imageDataUrl || '' })
    else if (node.type.name === 'docInlineImage' && node.attrs.dataUrl && !node.attrs.rule) out.push({ n: out.length + 1, pos, node, src: node.attrs.dataUrl, inline: true })
  })
  return out
}
/** the picture a clicked <img> shows: its number among docsPictures */
function docsPictureOf(ed, img) {
  for (const p of docsPictures(ed)) {
    const dom = ed.view.nodeDOM(p.pos)
    if (dom && (dom === img || dom.contains?.(img))) return p.n
  }
  return null
}
function docsPicture(n) {
  const ed = docsEditor()
  if (!ed) throw new Error(L('워드 편집기가 아직 열리지 않았습니다', 'The Word editor is not open yet'))
  const pics = docsPictures(ed)
  const pic = pics[(n || 1) - 1]
  if (!pic) throw new Error(L(`그림 ${n} 이 문서에 없습니다(그림 ${pics.length}개)`, `Picture ${n} is not in the document (${pics.length} picture${pics.length === 1 ? '' : 's'})`))
  return { ed, pic, count: pics.length }
}
const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }
/** picture N's bytes: its data URL, or what the page shows (a picture served from the file) */
export async function docsPictureBytes(n) {
  const { ed, pic, count } = docsPicture(n)
  let src = pic.src
  if (!/^data:|^genoffice-|^https?:|^blob:|^\//.test(src)) src = ed.view.nodeDOM(pic.pos)?.querySelector?.('img')?.src || src
  let bytes
  const data = /^data:[^;,]*;base64,(.*)$/s.exec(src)
  if (data) {
    // decoded here: the editor page's CSP does not let fetch() read data: URLs
    const bin = atob(data[1])
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else {
    // window.fetch maps the editor's genoffice-* scheme to the host (electron-renderer-shim.mjs)
    const res = await fetch(src)
    if (!res.ok) throw new Error(L(`그림 ${pic.n} 을 읽지 못했습니다(${res.status})`, `Could not read picture ${pic.n} (${res.status})`))
    bytes = new Uint8Array(await res.arrayBuffer())
  }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49
  const media = png ? 'image/png' : gif ? 'image/gif' : 'image/jpeg'
  return { n: pic.n, count, name: `image${pic.n}.${MEDIA_EXT[media]}`, media, bytes }
}
const dataUrlOf = async (bytes, media) => {
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(new Blob([bytes], { type: media }))
  })
  return url
}
const naturalSize = (url) => new Promise((resolve, reject) => {
  const im = new Image()
  im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight })
  im.onerror = () => reject(new Error('the new picture does not decode'))
  im.src = url
})
/** put new bytes in place of picture N: same place, same width (height follows the new picture) */
export async function docsReplacePicture(n, bytes) {
  const { ed, pic } = docsPicture(n)
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const png = data[0] === 0x89 && data[1] === 0x50
  const gif = data[0] === 0x47 && data[1] === 0x49
  const media = png ? 'image/png' : gif ? 'image/gif' : 'image/jpeg'
  const url = await dataUrlOf(data, media)
  const natural = await naturalSize(url)
  const a = pic.node.attrs
  let attrs
  if (pic.inline) {
    // an inline picture saves its drawing XML as it was: only the block form can take new bytes
    throw new Error(L('글 줄 안에 든 그림은 아직 바꿀 수 없습니다(그림을 따로 한 줄에 두면 돼요)', 'A picture inside a line of text cannot be replaced yet (put the picture on its own line)'))
  } else {
    const w = Math.max(1, Math.round(Number(a.imageWidthPx) || Math.min(natural.width, 620)))
    const h = Math.max(1, Math.round((w * natural.height) / natural.width))
    const base64 = url.slice(url.indexOf(',') + 1)
    const original = a.docxIndex !== null && a.docxIndex !== undefined
    // as Ribbon.tsx applyPictureBytes: an original picture keeps its drawing (imageReplace), a new one
    // its pending payload (genImage); the crop window of the old bytes would clip the new ones
    attrs = {
      ...a, imageDataUrl: url, imageWidthPx: w, imageHeightPx: h, imageCrop: null, imageFillRect: null,
      ...(original ? { imageReplace: { base64, mime: media } } : { genImage: { base64, mime: media, widthPx: w, heightPx: h } }),
    }
  }
  ed.view.dispatch(ed.state.tr.setNodeMarkup(pic.pos, undefined, attrs))
  return { replaced: pic.n, bytes: data.length }
}

// the host's live commands for an open 한글 document (worker-mcp.mjs office_live_* → live.mjs)
const HWP_COMMANDS = {
  read_document: async () => ({ text: String(await agent('readText')).slice(0, 60_000), tables: await agent('listTables'), pictures: (await hwpPictures(await unzip(await hwpEditor().exportHwpx()))).map(({ n, path }) => ({ n, path })) }),
  list_tables: () => agent('listTables'),
  read_table: ({ table, fromRow }) => agent('readTable', table, fromRow ?? null),
  fill_cells: ({ table, cells, overwrite = true }) => agent('fillCells', table, cells, overwrite),
  add_rows: ({ table, at, where = 'after', count = 1 }) => agent('addTableLines', table, 'rows', at, where, count),
  remove_rows: ({ table, at, count = 1 }) => agent('removeTableLines', table, 'rows', at, count),
  replace_text: ({ find, replace, occurrence }) => agent('replaceText', find, replace, occurrence ?? null),
  insert_paragraphs: ({ anchor, where = 'after', paragraphs }) => agent('insertParagraphs', anchor, null, where, paragraphs),
  picture: async ({ n }) => { const p = await hwpPictureBytes(n); return { ...p, bytes: p.bytes } },
  replace_picture: ({ n, bytes, name }) => hwpReplacePicture(n, bytes, name),
}

function hwpLiveBridge(ipcRenderer) {
  ipcRenderer.on('hwp:mcp-command', async (_event, msg) => {
    const { requestId, command, payload } = msg || {}
    try {
      const fn = HWP_COMMANDS[command]
      if (!fn) throw new Error(L(`한글 편집기가 모르는 명령: ${command}`, `Command unknown to the Hangul editor: ${command}`))
      if (!hwpEditor()) throw new Error(L('한글 편집기가 아직 열리지 않았습니다', 'The Hangul editor is not open yet'))
      ipcRenderer.send('hwp:mcp-result', { requestId, ok: true, result: await fn(payload || {}) })
    } catch (err) {
      ipcRenderer.send('hwp:mcp-result', { requestId, ok: false, error: String(err?.message || err) })
    }
  })
  // ready once a document is in the editor
  const ready = async (tries = 120) => {
    try {
      const ed = hwpEditor()
      if (ed && (await ed.commands.context()).hasDocument) return ipcRenderer.send('hwp:mcp-ready')
    } catch {
      // the editor is still starting
    }
    if (tries > 0) setTimeout(() => ready(tries - 1), 1000)
  }
  ready()
}

// ---------------------------------------------------------------- mentions
const clip = (s, n = 24) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

/** 워드 (tiptap): the top-level block under the click is the outline's block */
function docsMention(target) {
  const root = target.closest?.('.ProseMirror')
  if (!root) return null
  let block = target
  while (block && block.parentElement !== root) block = block.parentElement
  if (!block) return null
  const blocks = [...root.children]
  const blockIndex = blocks.indexOf(block)
  const img = target.closest('img')
  if (img) {
    // numbered like docsPictures (the picture round trip finds it by that number)
    const ed = root.editor
    const n = (ed && docsPictureOf(ed, img)) || [...root.querySelectorAll('img')].indexOf(img) + 1
    return { kind: 'image', image: n, blockIndex, label: L(`이미지 ${n}`, `Image ${n}`) }
  }
  if (block.tagName === 'TABLE' || target.closest('table')) {
    const table = target.closest('table')
    const n = [...root.querySelectorAll('table')].indexOf(table) + 1
    const cell = target.closest('td, th')
    const row = cell ? cell.parentElement.rowIndex + 1 : null
    const col = cell ? cell.cellIndex + 1 : null
    const head = clip([...(table.rows[0]?.cells || [])].map((c) => c.innerText).join(' · '), 30)
    return { kind: 'table', table: n, blockIndex, row, col, cellText: clip(cell?.innerText, 40), anchor: head, label: `${L('표', 'Table')} ${n}${head ? ` (${clip(head, 14)})` : ''}` }
  }
  const text = clip(block.innerText, 60)
  return { kind: 'paragraph', blockIndex, anchor: text, label: `${L('문단', 'Paragraph')} "${clip(text, 12)}"` }
}

/** 엑셀 (Univer): the selection in the name box, on the active sheet */
function sheetsMention() {
  const box = [...document.querySelectorAll('input')].find((i) => /^\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d+)?$/.test(i.value))
  if (!box) return null
  const range = box.value.replace(/\$/g, '')
  const sheet = clip(document.querySelector('.univer-sheet-bar [class*="active"], [class*="sheet-bar"] [aria-selected="true"]')?.innerText || '', 30)
  return { kind: 'range', range, sheet: sheet || null, label: `${sheet ? `${sheet}!` : ''}${range}` }
}

/** 한글 (rhwp): what the click put the caret on — a picture, a table cell or a paragraph */
async function hwpMention() {
  const ed = hwpEditor()
  if (!ed) return null
  const ctx = await ed.commands.context()
  if (ctx.inPictureObjectSelection) {
    const page = (await ed.getSelectionContext().catch(() => null))?.page || 1
    // which picture: the first one on this page (the page's SVG lists them in reading order)
    let n = 1
    try {
      const pics = await hwpPictures(await unzip(await ed.exportHwpx()))
      if (pics.length > 1) {
        let before = 0
        for (let p = 1; p < page; p++) before += ((await ed.getPageSvg(p)).match(/<image\b/g) || []).length
        n = Math.min(pics.length, before + 1)
      }
    } catch {
      // keep the first
    }
    return { kind: 'image', image: n, page, label: L(`이미지 ${n}`, `Image ${n}`) }
  }
  // a word at the caret gives the caret's place (paragraph, or table cell path)
  await ed.commands.execute('ext:ieum-select-word').catch(() => null)
  const sel = await agent('selection').catch(() => null)
  const seg = sel?.ok ? sel.segments[0] : null
  if (!seg) return null
  if (seg.path?.length || (ctx.inTable && (await ed.commands.context()).inTable)) {
    const cellIndex = seg.path?.[0]?.cellIndex ?? 0
    const list = await agent('listTables')
    for (const t of list.tables || []) {
      const read = await agent('readTable', t.table, null)
      const cell = read?.cells?.[cellIndex]
      if (cell && String(cell.text).includes(seg.text)) {
        return { kind: 'table', table: t.table, row: cell.row, col: cell.col, cellText: clip(cell.text, 40), anchor: t.near || '', label: `${L('표', 'Table')} ${t.table}${t.near ? ` (${clip(t.near.replace(/^\d+\.\s*/, ''), 14)})` : ''}` }
      }
    }
    return { kind: 'table', table: null, cellText: seg.text, label: L('표', 'Table') }
  }
  return { kind: 'paragraph', para: seg.para, anchor: seg.text, label: `${L('문단', 'Paragraph')} "${clip(seg.text, 12)}"` }
}

function installMentions(editor, toParent) {
  let mode = false
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.source !== 'process-gpt') return
    if (event.data.type === 'mention-mode') mode = !!event.data.on
  })
  const tell = (m) => m && toParent('mention', { mention: { editor, ...m } })
  const onClick = (win) => (e) => {
    if (!(mode || e.altKey)) return
    if (editor === 'docs') return tell(docsMention(e.target))
    if (editor === 'sheets') return setTimeout(() => tell(sheetsMention()), 120)
    if (editor === 'hwp') return setTimeout(() => hwpMention().then(tell).catch(() => {}), 200)
  }
  window.addEventListener('mouseup', onClick(window), true)
  // the 한글 editor draws in a same-origin frame of its own
  if (editor === 'hwp') {
    const hook = () => {
      for (const f of document.querySelectorAll('iframe')) {
        try {
          if (f.contentWindow && !f.contentWindow.__ieumMention) {
            f.contentWindow.__ieumMention = true
            f.contentWindow.addEventListener('mouseup', onClick(f.contentWindow), true)
          }
        } catch {
          // another origin
        }
      }
    }
    new MutationObserver(hook).observe(document.documentElement, { childList: true, subtree: true })
    setInterval(hook, 2000)
  }
}

// ---------------------------------------------------------------- requests from the parent
function installParentRequests(editor, toParent) {
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || event.data?.source !== 'process-gpt') return
    const { type, requestId } = event.data
    const { n, bytes, name } = event.data
    const run = editor === 'docs'
      ? { 'picture': () => docsPictureBytes(n), 'replace-picture': () => docsReplacePicture(n, bytes) }[type]
      // 'hwp-*': the names before 워드 pictures, still answered
      : { 'picture': () => hwpPictureBytes(n), 'replace-picture': () => hwpReplacePicture(n, bytes, name), 'hwp-picture': () => hwpPictureBytes(n), 'hwp-replace-picture': () => hwpReplacePicture(n, bytes, name) }[type]
    if (!run) return
    try {
      toParent('reply', { requestId, ok: true, result: await run() })
    } catch (err) {
      toParent('reply', { requestId, ok: false, error: String(err?.message || err) })
    }
  })
}

export function installPageLive({ editor, ipcRenderer, toParent, assistantParent, pageLang }) {
  if (pageLang === 'en' || pageLang === 'ko') lang = pageLang
  if (editor === 'hwp') hwpLiveBridge(ipcRenderer)
  if (assistantParent && ['docs', 'sheets', 'hwp'].includes(editor)) installMentions(editor, toParent)
  if (assistantParent && ['docs', 'hwp'].includes(editor)) installParentRequests(editor, toParent)
  // the framing page asks which requests this page answers ('pictures': 'picture' / 'replace-picture')
  if (assistantParent) toParent('page-live', { pictures: ['docs', 'hwp'].includes(editor) })
}
