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

export const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

/**
 * where the edited copy of a stored object goes: beside it, `edited-<stem>_<time>.<ext>`.
 * Named after the stored object, not the display name (storage keys must stay ASCII);
 * an edited copy of an edited copy keeps the original stem instead of edited-edited-….
 */
export function editedObjectPath(path, ext) {
  const stem = path.split('/').pop().replace(/\.[^.]+$/, '')
  const base = (/^edited-(.+)_\d{14}$/.exec(stem) || [])[1] || stem
  return path.replace(/[^/]*$/, `edited-${base}_${stamp()}.${ext}`)
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

export async function uploadToStorage(object, path, bytes, contentType, auth) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${SUPABASE_URL || object.origin}/storage/v1/object/${object.bucket}/${encoded}`, {
    method: 'POST',
    headers: { ...auth, 'x-upsert': 'true', 'content-type': contentType },
    body: bytes,
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
  // a preview never publishes: edits stay in the workspace
  if (!readOnly) watchSaves(contents, file)
  return { dir, file }
}

/** the editor writes its file in place (often via a temp file + rename): watch the folder */
function watchSaves(contents, file) {
  let timer
  const watcher = watch(contents.workspace, () => {
    clearTimeout(timer)
    timer = setTimeout(() => void publishSave(contents, file), 800)
  })
  contents.stopWatch = () => {
    clearTimeout(timer)
    watcher.close()
  }
}

async function publishSave(contents, file) {
  if (!existsSync(file) || statSync(file).size === 0) return
  const bytes = readFileSync(file)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash === contents.savedHash) return
  contents.savedHash = hash
  const name = basename(file)
  const ext = extname(name).slice(1).toLowerCase()
  try {
    let url = null
    const object = contents.source?.object
    const auth = object && storageAuth(contents.userToken)
    if (auth) {
      contents.editedPath ??= editedObjectPath(object.path, ext)
      url = await uploadToStorage(object, contents.editedPath, bytes, CONTENT_TYPES[ext] || 'application/octet-stream', auth)
    } else if (contents.source?.local) {
      // local trial: keep the edit beside the sample, never over it
      await copyFile(file, `${contents.source.local}.edited${extname(name)}`)
    }
    contents.publishedUrl = url
    contents.emit('office-published', url)
    contents.send('office:saved', { name, size: bytes.length, url })
  } catch (err) {
    console.warn(`[web-host] publishing ${name} failed:`, err?.stack || err)
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
