// Where a tab's document lives while it is edited, and how it gets back to the
// platform.
//
// Each connection gets its own workspace folder. The page names its document with
// `src`: either an http(s) URL from an allowed origin (a Supabase Storage object
// in process-gpt) or, for local trials, a file name under IEUM_WORKSPACE. The host
// downloads it into the workspace and the editor opens that copy. When the editor
// writes the file (Save, autosave), the host uploads it to Supabase Storage next to
// the original as `edited-<name>_<time>.<ext>` (one object per editing session,
// overwritten by later saves in the same session) and tells the page the new URL.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

const DATA_ROOT = resolve(process.env.IEUM_HOST_DATA || join(tmpdir(), 'ieum-web-host'))
const SESSIONS = join(DATA_ROOT, 'sessions')
const SAMPLES = process.env.IEUM_WORKSPACE ? resolve(process.env.IEUM_WORKSPACE) : null
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || ''
// without a service key the host uploads as the signed-in user (their token + the anon key),
// so storage policies apply exactly as for the user's own uploads
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const ALLOWED_ORIGINS = new Set(
  [SUPABASE_URL, ...(process.env.IEUM_ALLOWED_SOURCES || '').split(',')]
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => new URL(u).origin),
)

export const safeName = (name) =>
  basename(String(name || 'document'))
    .replace(/[\u0000-\u001f<>:"|?*\\]/g, '_')
    .slice(-180) || 'document'

export const stamp = (at = new Date()) => at.toISOString().replace(/[-:T]/g, '').slice(0, 14)

/**
 * where the edited copy of a stored object goes: beside it, `edited-<stem>_<time>.<ext>`.
 * Named after the stored object, not the display name (storage keys must stay ASCII);
 * an edited copy of an edited copy keeps the original stem instead of edited-edited-….
 * after: an edited copy this one must come after (a new address for the same opening — publishSave): its time plus a second at
 * least, so the two never share a name (the form stays edited-<stem>_<14 digits>: Process GPT Lite's checks and its copies job read it).
 */
export function editedObjectPath(path, ext, { after = null } = {}) {
  const stem = path.split('/').pop().replace(/\.[^.]+$/, '')
  const base = (/^edited-(.+)_\d{14}$/.exec(stem) || [])[1] || stem
  let time = stamp()
  const prev = after && /_(\d{14})\.[^./]+$/.exec(after)?.[1]
  if (prev && time <= prev) time = stamp(new Date(Date.UTC(+prev.slice(0, 4), +prev.slice(4, 6) - 1, +prev.slice(6, 8), +prev.slice(8, 10), +prev.slice(10, 12), +prev.slice(12, 14)) + 1000))
  return path.replace(/[^/]*$/, `edited-${base}_${time}.${ext}`)
}

/**
 * A Supabase Storage object URL → { origin, bucket, path } (public, signed or
 * authenticated form). The origin is what the browser used; uploads go to
 * SUPABASE_URL (which may be an internal address) and the returned URL keeps the
 * browser's origin.
 */
export function storageObjectOf(url) {
  const u = new URL(url)
  const prefix = '/storage/v1/object/'
  if (!ALLOWED_ORIGINS.has(u.origin) || !u.pathname.startsWith(prefix)) return null
  const parts = u.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
  if (parts[0] === 'public' || parts[0] === 'sign' || parts[0] === 'authenticated') parts.shift()
  const [bucket, ...path] = parts
  return bucket && path.length ? { origin: u.origin, bucket, path: path.join('/') } : null
}

/** headers for a storage write: the service key, else the signed-in user's token with the anon key */
export function storageAuth(userToken) {
  if (SUPABASE_KEY) return { authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY }
  if (userToken && SUPABASE_ANON_KEY) return { authorization: `Bearer ${userToken}`, apikey: SUPABASE_ANON_KEY }
  return null
}

/** a document source a host may fetch: an http(s) URL on an allowed origin */
export const isAllowedSource = (url) => /^https?:\/\//i.test(url) && ALLOWED_ORIGINS.has(new URL(url).origin)

/** where new documents go: the browser-facing Supabase origin and the files bucket */
export const newDocumentObject = (ext) => ({
  origin: new URL(process.env.SUPABASE_PUBLIC_URL || SUPABASE_URL || 'http://localhost').origin,
  bucket: process.env.IEUM_NEW_DOC_BUCKET || 'files',
  path: `agent-docs/${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`,
})

// How long an upload may take: a base for any file plus time for its size at a slow rate (a large file on a slow link is not cut off
// for being large) — 15 s for a few-MB document, well inside the page's own wait for a save (Process GPT Lite SAVE_WAIT_MS, 30 s). A
// longer one is announced to the page first (office:saving { limitMs }), which then waits that long. An upload past its limit is given
// up (stuck, it would hold every later save of the tab behind it — they go one at a time), so a page that says a save failed has heard
// it from here: the upload has stopped. (Not 「nothing moved for N s」: what the network has not sent yet sits in the socket's buffer,
// several MB, out of sight — a slow link draining it looks stuck.) IEUM_UPLOAD_BASE_MS · IEUM_UPLOAD_MIN_RATE (bytes/s) change them.
export const UPLOAD_BASE_MS = Number(process.env.IEUM_UPLOAD_BASE_MS) || 15_000
export const UPLOAD_MIN_RATE = Number(process.env.IEUM_UPLOAD_MIN_RATE) || 512 * 1024
export const uploadLimitMs = (size) => UPLOAD_BASE_MS + Math.ceil((Math.max(0, size) / UPLOAD_MIN_RATE) * 1000)

export async function uploadToStorage(object, path, bytes, contentType, auth, { timeoutMs = uploadLimitMs(bytes.length) } = {}) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${SUPABASE_URL || object.origin}/storage/v1/object/${object.bucket}/${encoded}`, {
    method: 'POST',
    headers: { ...auth, 'x-upsert': 'true', 'content-type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return `${object.origin}/storage/v1/object/public/${object.bucket}/${encoded}`
}

export const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  md: 'text/markdown; charset=utf-8',
  // (a .txt the markdown editor saves: served as text, not as a download — production 11-27, a chat's TXT)
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xmind: 'application/zip',
}

/**
 * Prepare the workspace for one connection and fetch its document. A read-only
 * open (preview) never uploads.
 * Returns { dir, file } (file null for a new, empty document).
 */
export async function openWorkspace(contents, { src, name, readOnly = false }) {
  const dir = join(SESSIONS, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  contents.workspace = dir
  contents.once('destroyed', () => {
    contents.stopWatch?.()
    // keep the folder a while for autosave recovery, then drop it
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 30 * 60_000).unref?.()
  })
  if (!src) return { dir, file: null }

  let bytes
  let fileName
  if (/^https?:\/\//i.test(src)) {
    const origin = new URL(src).origin
    if (!ALLOWED_ORIGINS.has(origin)) throw new Error(`document source not allowed: ${origin}`)
    const res = await fetch(src)
    if (!res.ok) throw new Error(`document download ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
    fileName = safeName(name || decodeURIComponent(new URL(src).pathname.split('/').pop()))
    contents.source = { url: src, object: storageObjectOf(src) }
  } else {
    if (!SAMPLES) throw new Error('local documents are disabled (IEUM_WORKSPACE not set)')
    const local = join(SAMPLES, safeName(src))
    if (!existsSync(local)) throw new Error(`no such document: ${safeName(src)}`)
    bytes = await readFile(local)
    fileName = safeName(name || src)
    contents.source = { local }
  }
  const file = join(dir, fileName)
  await writeFile(file, bytes)
  contents.documentPath = file
  contents.savedHash = createHash('sha256').update(bytes).digest('hex')
  contents.savedMtime = statSync(file).mtimeMs
  // a preview never publishes: edits stay in the workspace
  if (!readOnly) watchSaves(contents, file)
  return { dir, file }
}

/** the editor writes its file in place (often via a temp file + rename): watch the folder */
function watchSaves(contents, file) {
  let timer
  // (one publish at a time: a save that comes while one is going up is looked at once that one is done)
  const publish = (opts) => { contents.publishing = (contents.publishing || Promise.resolve()).then(() => publishSave(contents, file, opts)).catch(() => {}) }
  const watcher = watch(contents.workspace, () => {
    clearTimeout(timer)
    timer = setTimeout(() => publish(), 800)
  })
  // (a watcher that fails — the folder removed under it — must not take the host, and every open document, down with it)
  watcher.on('error', (err) => console.warn(`[web-host] watching ${contents.workspace} failed:`, err?.message || err))
  // The page asks for the editor's last write to be sent up (`republish`): the editor has nothing newer — its 저장 is off — and the page
  // needs that write in storage (an upload of it failed; a save the page must see answered). Answered like a save: 「saved」 (sent up, or
  // the same bytes as the last one up — `unchanged`) or 「save-failed」. Editors whose own key or button does nothing then (the
  // spreadsheet refuses Ctrl+S on the web host, the slides ignore it) are saved again this way.
  contents.republish = () => publish({ asked: true })
  contents.stopWatch = () => {
    clearTimeout(timer)
    watcher.close()
  }
}

async function publishSave(contents, file, { asked = false } = {}) {
  if (!existsSync(file) || statSync(file).size === 0) {
    // (asked for, it is answered: the editor has written nothing yet — a new document)
    if (asked) contents.send('office:save-failed', { name: basename(file), error: 'nothing saved yet' })
    return
  }
  const st = statSync(file)
  // (the document itself written again — not some other file of the workspace — or the page asking for it: answered either way)
  const rewritten = asked || st.mtimeMs !== contents.savedMtime
  contents.savedMtime = st.mtimeMs
  const bytes = readFileSync(file)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash === contents.savedHash) {
    // saved again with the same bytes (an edit undone before 저장): nothing to publish, but the page that pressed 저장 hears it is saved —
    // as the copy this session published last, or, before any, with no address (the document is as it was opened: nothing new to point
    // at, so no older address is ever handed back). The framing page takes `unchanged` only while it waits for a save. Only once the
    // publish before it is through (publishes go one at a time). A file system that keeps whole seconds misses a rewrite within the same
    // second: no answer then. Written again since it was read (the editor is saving once more): that save is the one answered.
    if (rewritten && existsSync(file) && statSync(file).mtimeMs === st.mtimeMs) {
      contents.send('office:saved', { name: basename(file), size: bytes.length, url: contents.publishedUrl || null, unchanged: true })
    }
    return
  }
  // the bytes whose upload failed, met again with the document not written since (another file of the workspace changed): not sent up by
  // themselves — nobody asked, and a 「saved」 nobody waits for would tell the page its edits are in. The editor's own save of them again
  // (its 저장, ⌘S — the page's 다시 시도) writes the document, and that is tried.
  if (!rewritten && hash === contents.failedHash) return
  contents.savedHash = hash
  const name = basename(file)
  const ext = extname(name).slice(1).toLowerCase()
  try {
    let url = null
    const object = contents.source?.object
    const auth = object && storageAuth(contents.userToken)
    if (auth) {
      contents.editedPath ??= editedObjectPath(object.path, ext)
      // (the page waits for this save's answer as long as the upload may take — longer than its own 30 s for a large file)
      const limitMs = uploadLimitMs(bytes.length)
      contents.send('office:saving', { name, size: bytes.length, limitMs })
      url = await uploadToStorage(object, contents.editedPath, bytes, CONTENT_TYPES[ext] || 'application/octet-stream', auth, { timeoutMs: limitMs })
    } else if (contents.source?.local) {
      // local trial: keep the edit beside the sample, never over it
      await copyFile(file, `${contents.source.local}.edited${extname(name)}`)
    }
    contents.failedHash = null
    contents.publishedUrl = url
    contents.emit('office-published', url)
    contents.send('office:saved', { name, size: bytes.length, url })
  } catch (err) {
    console.warn(`[web-host] publishing ${name} failed:`, err?.stack || err)
    // Not published — and what the edited copy holds now is not known (an upload cut off by its limit may still land, after a later
    // one): no bytes count as saved, so the next save goes up whatever it holds (never 「unchanged」 with an address that may hold
    // something else), and to a new address of its own — a late landing of this one cannot overwrite it. The page takes the address of
    // each save from its answer.
    contents.savedHash = null
    contents.failedHash = hash
    if (contents.editedPath && contents.source?.object) contents.editedPath = editedObjectPath(contents.source.object.path, ext, { after: contents.editedPath })
    contents.send('office:save-failed', { name, error: String(err?.message || err) })
  }
}

// ---- path confinement ----
// The editors' main code was written for "my files on my PC" and takes paths from
// the page (open-path, readFile, save targets…). Every absolute path a page sends
// must stay inside its own workspace or the host's internal folders.
const PATH_KEY = /(^|[a-z])(path|paths|dir|file|target)s?$/i

export function guardPaths(contents, channel, args) {
  const roots = [contents.workspace, DATA_ROOT, resolve(tmpdir())].filter(Boolean)
  const check = (value) => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\n')) return
    const full = resolve(value)
    if (!roots.some((root) => full === root || full.startsWith(root + sep))) {
      throw new Error(`'${channel}': path outside this document's workspace`)
    }
  }
  for (const arg of args) {
    if (Array.isArray(arg)) arg.forEach(check)
    else check(arg)
    if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && !Array.isArray(arg)) {
      for (const [key, value] of Object.entries(arg)) {
        if (!PATH_KEY.test(key)) continue
        if (Array.isArray(value)) value.forEach(check)
        else check(value)
      }
    }
  }
}

export const hostDataRoot = DATA_ROOT
