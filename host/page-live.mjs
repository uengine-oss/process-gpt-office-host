// The editor page's half of what a framing page (pgpt-pro) adds on top of the editors, bundled
// into every editor's preload with the renderer shim. The fork's source is untouched: the 한글
// editor object comes from build-web.mjs (exposeRhwpEditor), the rest is the page's DOM.
//
// - Click to mention (`?assistant=parent`): with the parent's mention mode on (or ⌥/Alt held), a
//   click on a table, an image, a paragraph (워드·한글) or a cell range (엑셀) is told to the parent
//   as { type: 'mention', mention: { editor, kind, label, ...where } } — enough for the live tools
//   to address the same object (table number and cell, picture number, range, text anchor).
// - The selection, live (워드, `?assistant=parent`): what is selected in the document is told to the
//   parent as it changes — { type: 'selection', selection: { editor, kind, label, text, ...where } },
//   null when nothing is — so the parent's chat carries it (the chip in its composer takes the place
//   of the editor's own 「AI 수정 요청」, hidden there) and its agent addresses exactly that place with
//   the live tools: the top-level block, and in a table the cells' grid range as the table ops take it.
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

// ---------------------------------------------------------------- the selection, live (워드)
// A table's cells on its grid, the way the table ops count them (prosemirror-tables' TableMap): each cell
// (by its offset from the table's content start) → its rows and columns, 0-based, a merged cell covering more.
export function tableGrid(table) {
  const cells = new Map()
  const taken = []
  table.forEach((row, rowOff, r) => {
    let col = 0
    row.forEach((cell, cellOff) => {
      taken[r] ||= new Set()
      while (taken[r].has(col)) col++
      const cs = Math.max(1, Number(cell.attrs?.colspan) || 1)
      const rs = Math.max(1, Number(cell.attrs?.rowspan) || 1)
      for (let i = 0; i < rs; i++) { taken[r + i] ||= new Set(); for (let k = 0; k < cs; k++) taken[r + i].add(col + k) }
      cells.set(rowOff + 1 + cellOff, { row: r, col, rowEnd: r + rs - 1, colEnd: col + cs - 1, node: cell, rel: rowOff + 1 + cellOff })
      col += cs
    })
  })
  return cells
}

/** The selected cells' contents as position ranges, one per table row: what a paragraph or font op (setParagraphFormat,
 *  setFont: target.range) needs to reach every selected cell and nothing else. A cell selection's own from/to is one cell only
 *  (ProseMirror's Selection.from/to are its first range): production 11-25, 「1~3행 1~4열」 selected, the agent's
 *  setParagraphFormat with the selection's from/to changed one paragraph of ten. In a row the selected cells sit side by side
 *  (a rectangle on the grid), so one range per row covers exactly them. hit: tableGrid entries (+ node), tablePos: the table's position */
export function rowTextRanges(hit, tablePos) {
  const rows = new Map()
  for (const g of hit) {
    const from = tablePos + 1 + g.rel
    const to = from + g.node.nodeSize
    const r = rows.get(g.row)
    rows.set(g.row, r ? { from: Math.min(r.from, from), to: Math.max(r.to, to) } : { from, to })
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
}

/** what is selected in the 워드 editor and where (enough for office_live_apply_ops to hit that place: the block, a table's
 *  grid range, the positions), or null. `label` says where only — the parent shows the selected words beside it. */
export function docsSelection(ed) {
  const st = ed?.state
  const sel = st?.selection
  if (!sel || sel.empty) return null
  const doc = st.doc
  // a cell selection (prosemirror-tables) is its cells, not everything between its first and last one
  const cellSel = typeof sel.forEachCell === 'function'
  const parts = []
  if (cellSel) sel.forEachCell((cell) => parts.push(cell.textContent))
  const text = String(cellSel ? parts.join(' ') : doc.textBetween(sel.from, sel.to, ' ', ' ') || '').replace(/\s+/g, ' ').trim()
  const $from = doc.resolve(sel.from)
  const $to = doc.resolve(sel.to)
  const blockIndex = $from.index(0)
  // (a selection ending at the start of the next block does not reach into it)
  const blockEnd = Math.max(blockIndex, sel.to > sel.from && $to.parentOffset === 0 && $to.depth === 1 ? $to.index(0) - 1 : $to.index(0))
  const base = { editor: 'docs', text: text.slice(0, 2000), blockIndex, from: sel.from, to: sel.to }
  const top = doc.maybeChild(blockIndex)
  if (top?.type.name === 'docTable' && blockEnd === blockIndex) {
    let tablePos = 0
    let n = 0
    doc.forEach((node, offset, i) => { if (i < blockIndex) tablePos = offset + node.nodeSize; if (i <= blockIndex && node.type.name === 'docTable') n++ })
    const grid = tableGrid(top)
    const hit = []
    // a cell selection: its cells; a text selection: the cells it touches
    if (cellSel) sel.forEachCell((_cell, pos) => { const g = grid.get(pos - tablePos - 1); if (g) hit.push(g) })
    else {
      for (const [rel, g] of grid) {
        const abs = tablePos + 1 + rel
        if (abs < sel.to && abs + g.node.nodeSize > sel.from) hit.push(g)
      }
    }
    if (hit.length) {
      const range = { row: Math.min(...hit.map((g) => g.row)), col: Math.min(...hit.map((g) => g.col)), rowEnd: Math.max(...hit.map((g) => g.rowEnd)), colEnd: Math.max(...hit.map((g) => g.colEnd)) }
      const one = (a, b) => (a === b ? `${a + 1}` : `${a + 1}~${b + 1}`)
      const where = L(`${one(range.row, range.rowEnd)}행 ${one(range.col, range.colEnd)}열`, `row ${one(range.row, range.rowEnd)}, col ${one(range.col, range.colEnd)}`)
      return { ...base, kind: 'table', table: n, range, cells: hit.length, textRanges: rowTextRanges(hit, tablePos), label: `${L('표', 'Table')} ${n} · ${where}` }
    }
  }
  if (sel.node && sel.node.type.name === 'docProtected' && sel.node.attrs.blockType === 'image') {
    const p = docsPictures(ed).find((x) => x.pos === sel.from)
    if (p) return { ...base, kind: 'image', image: p.n, label: L(`이미지 ${p.n}`, `Image ${p.n}`) }
  }
  // (where only: the parent shows the selected words beside it)
  return { ...base, kind: 'text', blockEnd, label: blockEnd > blockIndex ? L(`문단 ${blockEnd - blockIndex + 1}개`, `${blockEnd - blockIndex + 1} paragraphs`) : L('문단', 'Paragraph') }
}

function installSelection(toParent) {
  const hooked = new WeakSet()
  let last = 'null'
  let timer = null
  const tell = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      let s = null
      try { s = docsSelection(docsEditor()) } catch { s = null }
      // (the same place again is not news; positions alone moving under an edit are)
      const key = JSON.stringify(s)
      if (key === last) return
      last = key
      toParent('selection', { selection: s })
    }, 180)
  }
  // the editor is made after the document loads (and again for another document): hook each one
  setInterval(() => {
    const ed = docsEditor()
    if (!ed || hooked.has(ed)) return
    hooked.add(ed)
    ed.on('selectionUpdate', tell)
    ed.on('update', tell)
    tell()
  }, 500)
}

// ---------------------------------------------------------------- cell alignment, and what the document shows (워드 live edits)
// Production 11-25 (회의록_템플릿.docx, written with python-docx's defaults): 「1~3행 1~4열 … 중앙정렬」 → setTableCellFormat
// vAlign center on ten cells, accepted, saved as w:vAlign center — and nothing moved on screen. Every cell paragraph carries the
// document's default space after (w:pPrDefault, 200 twips ≈ 13px) and nothing else makes the rows tall, so a cell's content
// (its line + that space) already fills the cell: centring it has no room to move. Word lays it out the same way. So, here,
// without touching the fork:
//   - planCellAlign: after a live batch sets cells' vertical alignment, each cell's edge spacing (its first paragraph's space
//     before + its last paragraph's space after, as laid out) is put where the alignment puts the text — top: all after,
//     center: half each, bottom: all before. The total stays, so the row keeps its height; the text moves as asked.
//   - formatFacts: what the document shows after a batch, for each format op — cells: vAlign · fill · borders as the document
//     has them, the cell's laid-out alignment and background, and where its text sits (room above and below its lines, and
//     the lines' height); paragraphs: the
//     requested fields and the laid-out alignment and spacing — so a caller checks the request against the document itself
//     instead of the op count (pgpt-pro lib/officeEdits.js).
const PARAGRAPHS = new Set(['docParagraph', 'docHeading', 'docListItem'])
const SAME_TWIPS = 10 // spacing this close (half a point) is already where it should be
const MAX_FACTS = 80

function topBlocks(doc) {
  const out = []
  doc.forEach((node, pos, index) => out.push({ node, pos, index }))
  return out
}
const hasText = (node, text, matchCase) =>
  matchCase === false ? node.textContent.toLowerCase().includes(String(text).toLowerCase()) : node.textContent.includes(String(text))

/** the one native table a table op's target names (blockIndexes · containsText, as the table ops take it) → { node, pos, index, n }, or null */
export function opTable(doc, target) {
  const t = target || {}
  const hits = []
  let n = 0
  for (const b of topBlocks(doc)) {
    if (b.node.type.name !== 'docTable') continue
    n++
    if (Array.isArray(t.blockIndexes) && !t.blockIndexes.includes(b.index)) continue
    if (t.containsText != null && !hasText(b.node, t.containsText, t.matchCase)) continue
    hits.push({ ...b, n })
  }
  return hits.length === 1 ? hits[0] : null
}

/** the cells a grid range touches (omitted: the whole table), each once, as the table ops take a range → [{ ...grid entry, pos }] */
export function cellsInRange(table, tablePos, range) {
  const top = range?.row ?? 0
  const left = range?.col ?? 0
  const bottom = range ? (range.rowEnd ?? range.row) : Infinity
  const right = range ? (range.colEnd ?? range.col) : Infinity
  const out = []
  for (const g of tableGrid(table).values()) {
    if (g.rowEnd < top || g.row > bottom || g.colEnd < left || g.col > right) continue
    out.push({ ...g, pos: tablePos + 1 + g.rel })
  }
  return out
}

/** the paragraphs a paragraph op's target reaches (as the ops' matchTarget · paragraphsIn take blockIndexes · nodeType ·
 *  containsText · range), or null for a target this page does not resolve the same way (the live selection, a heading level) */
export function opParagraphs(doc, target) {
  const t = target || {}
  if (t.scope === 'selection' || t.headingLevel != null || t.nodeType === 'image') return null
  const r = t.range && Number.isInteger(t.range.from) && Number.isInteger(t.range.to) ? t.range : null
  const meets = (pos, end) => !r || (end > r.from && pos < r.to) || (r.from === r.to && r.from >= pos && r.from <= end)
  const out = []
  for (const b of topBlocks(doc)) {
    if (Array.isArray(t.blockIndexes) && !t.blockIndexes.includes(b.index)) continue
    if (t.nodeType && b.node.type.name !== (t.nodeType === 'table' ? 'docTable' : t.nodeType)) continue
    if (t.containsText != null && !hasText(b.node, t.containsText, t.matchCase)) continue
    if (!meets(b.pos, b.pos + b.node.nodeSize)) continue
    if (b.node.isTextblock) {
      if (PARAGRAPHS.has(b.node.type.name)) out.push({ node: b.node, pos: b.pos })
      continue
    }
    b.node.descendants((node, offset) => {
      if (!PARAGRAPHS.has(node.type.name)) return true
      const pos = b.pos + 1 + offset
      if (meets(pos, pos + node.nodeSize)) out.push({ node, pos })
      return false
    })
  }
  return out
}

/** The paragraph ops that put each aligned cell's edge spacing where its alignment puts the text (see above), for a batch just
 *  applied — the positions are the document's now. spacingOf({ node, pos }) → { before, after } in twips as laid out, or null.
 *  Neighbouring paragraphs (no other paragraph between) that take the same values share one op: a row of one-line cells.
 *  → { ops, cells, paragraphs } */
export function planCellAlign(doc, ops, spacingOf) {
  const marks = []
  const seen = new Set()
  let cells = 0
  for (const op of ops || []) {
    if (op?.op !== 'setTableCellFormat' || op.vAlign === undefined) continue
    const t = opTable(doc, op.target)
    if (!t) continue
    const want = op.vAlign || 'top'
    for (const cell of cellsInRange(t.node, t.pos, op.range)) {
      if (seen.has(cell.pos)) continue
      seen.add(cell.pos)
      const kids = []
      cell.node.forEach((node, offset) => kids.push({ node, pos: cell.pos + 1 + offset }))
      const first = kids[0]
      const last = kids[kids.length - 1]
      if (!first || !PARAGRAPHS.has(first.node.type.name) || !PARAGRAPHS.has(last.node.type.name)) continue
      const a = spacingOf(first)
      const z = first === last ? a : spacingOf(last)
      if (!a || !z) continue
      const total = (a.before || 0) + (z.after || 0)
      const before = want === 'bottom' ? total : want === 'center' ? Math.round(total / 2) : 0
      const after = total - before
      if (Math.abs(before - (a.before || 0)) < SAME_TWIPS && Math.abs(after - (z.after || 0)) < SAME_TWIPS) continue
      cells++
      if (first === last) marks.push({ block: t.index, pos: first.pos, size: first.node.nodeSize, spaceBefore: before, spaceAfter: after })
      else {
        marks.push({ block: t.index, pos: first.pos, size: first.node.nodeSize, spaceBefore: before })
        marks.push({ block: t.index, pos: last.pos, size: last.node.nodeSize, spaceAfter: after })
      }
    }
  }
  const order = new Map()
  let i = 0
  doc.descendants((node, pos) => {
    if (!PARAGRAPHS.has(node.type.name)) return true
    order.set(pos, i++)
    return false
  })
  marks.sort((x, y) => x.pos - y.pos)
  const runs = []
  for (const m of marks) {
    const r = runs[runs.length - 1]
    if (r && r.block === m.block && r.spaceBefore === m.spaceBefore && r.spaceAfter === m.spaceAfter && order.get(m.pos) === order.get(r.last) + 1) {
      r.to = m.pos + m.size
      r.last = m.pos
    } else runs.push({ block: m.block, from: m.pos, to: m.pos + m.size, last: m.pos, spaceBefore: m.spaceBefore, spaceAfter: m.spaceAfter })
  }
  return {
    ops: runs.map((r) => ({
      op: 'setParagraphFormat',
      target: { blockIndexes: [r.block], range: { from: r.from, to: r.to } },
      ...(r.spaceBefore !== undefined ? { spaceBefore: r.spaceBefore } : {}),
      ...(r.spaceAfter !== undefined ? { spaceAfter: r.spaceAfter } : {}),
    })),
    cells,
    paragraphs: marks.length,
  }
}

/** What the document shows for each format op of a batch: [{ op (its index), name, table?, block?, cells? | paragraphs? }].
 *  shown: { cell(pos, node), paragraph(pos, node) } → what is laid out (the page's DOM; null when not on screen) */
export function formatFacts(doc, ops, shown) {
  const out = []
  ;(ops || []).forEach((op, i) => {
    if (op?.op === 'setTableCellFormat') {
      const t = opTable(doc, op.target)
      if (!t) return out.push({ op: i, name: op.op, cells: [] })
      const cells = cellsInRange(t.node, t.pos, op.range).slice(0, MAX_FACTS).map((c) => ({
        row: c.row, col: c.col, ...(c.rowEnd !== c.row ? { rowEnd: c.rowEnd } : {}), ...(c.colEnd !== c.col ? { colEnd: c.colEnd } : {}),
        text: clip(c.node.textContent, 20),
        vAlign: c.node.attrs.vAlign ?? null, fill: c.node.attrs.fill ?? null, borders: c.node.attrs.borders ?? null,
        shown: shown.cell(c.pos, c.node),
      }))
      out.push({ op: i, name: op.op, table: t.n, block: t.index, cells })
    } else if (op?.op === 'setParagraphFormat') {
      const ps = opParagraphs(doc, op.target)
      if (!ps) return
      const keys = Object.keys(op).filter((k) => k !== 'op' && k !== 'target')
      out.push({
        op: i, name: op.op,
        paragraphs: ps.slice(0, MAX_FACTS).map((p) => ({
          text: clip(p.node.textContent, 20),
          attrs: Object.fromEntries(keys.map((k) => [k, p.node.attrs[k] ?? null])),
          shown: shown.paragraph(p.pos, p.node),
        })),
      })
    }
  })
  return out
}

// ---- the same, laid out (the page's DOM)
const px = (v) => parseFloat(v) || 0
const r1 = (v) => Math.round(v * 10) / 10
/** a computed colour → 'RRGGBB', null for none (transparent) */
export function hexOfCss(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(String(color || ''))
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
  return [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase()
}
const domOf = (ed, pos) => {
  const d = ed.view.nodeDOM(pos)
  return d && d.nodeType === 1 ? d : null
}
/** a paragraph's spacing as laid out, in twips */
const domSpacing = (ed) => ({ pos }) => {
  const el = domOf(ed, pos)
  if (!el) return null
  const cs = getComputedStyle(el)
  return { before: Math.round(px(cs.marginTop) * 15), after: Math.round(px(cs.marginBottom) * 15) }
}
function domShown(ed) {
  return {
    cell(pos, node) {
      const td = domOf(ed, pos)
      if (!td) return null
      const cs = getComputedStyle(td)
      const out = { verticalAlign: cs.verticalAlign, background: hexOfCss(cs.backgroundColor) }
      // the box its text is laid out in: an exact-height row's clip box (or a rotated cell's), else the cell inside borders and padding
      const inner = td.querySelector(':scope > .cell-clip, :scope > .cell-vert')
      let top
      let bottom
      if (inner) ({ top, bottom } = inner.getBoundingClientRect())
      else {
        const r = td.getBoundingClientRect()
        top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop)
        bottom = r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom)
      }
      // where its text sits: the lines of its paragraphs that have text (their boxes, without their spacing)
      let t = Infinity
      let b = -Infinity
      node.forEach((child, offset) => {
        if (!PARAGRAPHS.has(child.type.name) || !child.textContent.trim()) return
        const r = domOf(ed, pos + 1 + offset)?.getBoundingClientRect()
        if (!r?.height) return
        t = Math.min(t, r.top)
        b = Math.max(b, r.bottom)
      })
      if (Number.isFinite(t)) Object.assign(out, { above: r1(t - top), below: r1(bottom - b), lines: r1(b - t) })
      return out
    },
    paragraph(pos) {
      const el = domOf(ed, pos)
      if (!el) return null
      const cs = getComputedStyle(el)
      return { textAlign: cs.textAlign, spaceBefore: Math.round(px(cs.marginTop) * 15), spaceAfter: Math.round(px(cs.marginBottom) * 15) }
    },
  }
}
// after a batch: the editor's own re-layout (measurements, pagination) a frame or two later; a page in the background has no frames
const settle = () => new Promise((resolve) => {
  let done = false
  const go = () => { if (!done) { done = true; resolve() } }
  requestAnimationFrame(() => requestAnimationFrame(go))
  setTimeout(go, 150)
})

// the host's own commands for an open 워드 document, beside the editor's bridge (worker-mcp.mjs office_live_apply_ops → live.mjs runPage)
const DOCS_COMMANDS = {
  cell_align_ops: async ({ ops }) => {
    const ed = docsEditor()
    if (!ed) throw new Error(L('워드 편집기가 아직 열리지 않았습니다', 'The Word editor is not open yet'))
    await settle()
    return planCellAlign(ed.state.doc, ops, domSpacing(ed))
  },
  format_facts: async ({ ops }) => {
    const ed = docsEditor()
    if (!ed) throw new Error(L('워드 편집기가 아직 열리지 않았습니다', 'The Word editor is not open yet'))
    await settle()
    return { check: formatFacts(ed.state.doc, ops, domShown(ed)) }
  },
}
function docsLiveBridge(ipcRenderer) {
  ipcRenderer.on('docs:page-command', async (_event, msg) => {
    const { requestId, command, payload } = msg || {}
    try {
      const fn = DOCS_COMMANDS[command]
      if (!fn) throw new Error(`unknown page command: ${command}`)
      ipcRenderer.send('docs:page-result', { requestId, ok: true, result: await fn(payload || {}) })
    } catch (err) {
      ipcRenderer.send('docs:page-result', { requestId, ok: false, error: String(err?.message || err) })
    }
  })
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
  if (editor === 'docs' && ipcRenderer) docsLiveBridge(ipcRenderer)
  if (assistantParent && ['docs', 'sheets', 'hwp'].includes(editor)) installMentions(editor, toParent)
  if (assistantParent && ['docs', 'hwp'].includes(editor)) installParentRequests(editor, toParent)
  if (assistantParent && editor === 'docs') installSelection(toParent)
  // the framing page asks which requests this page answers ('pictures': 'picture' / 'replace-picture')
  // and whether it tells its selection ('selection')
  if (assistantParent) toParent('page-live', { pictures: ['docs', 'hwp'].includes(editor), selection: editor === 'docs' })
}
