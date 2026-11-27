// How a tab's document gets back to the platform (host/documents.mjs): a save of new bytes is published and said; the same bytes
// written again (an edit undone before 저장) are said too — the page that pressed 저장 is not left waiting (production 2026-11-27,
// Process GPT Lite: a save that got no answer stayed 「저장 중…」) — and another file of the workspace changing says nothing. An upload
// that fails leaves nothing counted as saved, and its bytes go up again only with the editor's own save of them.
//   node --test host/documents.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const samples = mkdtempSync(join(tmpdir(), 'ieum-doc-samples-'))
const data = mkdtempSync(join(tmpdir(), 'ieum-doc-data-'))
process.env.IEUM_WORKSPACE = samples
process.env.IEUM_HOST_DATA = data
writeFileSync(join(samples, 'memo.txt'), '첫 줄\n')
writeFileSync(join(samples, 'draft.txt'), '첫 줄\n')
writeFileSync(join(samples, 'again.txt'), '첫 줄\n')
// A storage stand-in for the uploads to Supabase (the document is downloaded from it, its edited copies go up to it): state.fail makes
// the next uploads answer 503; posts are the uploads it took
const store = { fail: 0, posts: [] }
const storage = createServer((req, res) => {
  if (req.method === 'GET') return void res.end('첫 줄\n')
  const parts = []
  req.on('data', (c) => parts.push(c))
  req.on('end', () => {
    const path = decodeURIComponent(req.url.replace(/^\/storage\/v1\/object\/files\//, ''))
    if (store.fail > 0) { store.fail--; store.posts.push({ path, failed: true }); return void res.writeHead(503).end('{"error":"unavailable (test)"}') }
    store.posts.push({ path, body: Buffer.concat(parts).toString('utf8') })
    res.end('{"Key":"ok"}')
  })
})
await new Promise((r) => storage.listen(0, '127.0.0.1', r))
const STORE = `http://127.0.0.1:${storage.address().port}`
process.env.IEUM_ALLOWED_SOURCES = STORE
process.env.SUPABASE_ANON_KEY = 'anon (test)'
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
delete process.env.SUPABASE_KEY
const { openWorkspace, CONTENT_TYPES, uploadToStorage, uploadLimitMs, editedObjectPath } = await import('./documents.mjs')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const opened = []
after(() => {
  storage.close()
  for (const c of opened) c.emit('destroyed')
  rmSync(samples, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test('a .txt goes up as text', () => {
  assert.equal(CONTENT_TYPES.txt, 'text/plain; charset=utf-8')
})

test('new bytes are published and said; the same bytes written again are said as unchanged (with the last published address, or none before any); another file says nothing', async () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]) })
  opened.push(contents)
  const { file, dir } = await openWorkspace(contents, { src: 'memo.txt' })
  await wait(300)
  // the same bytes as opened, written again before anything was published: said as unchanged, with no address (nothing new to point at)
  writeFileSync(file, '첫 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged, p.url]), [['office:saved', true, null]])
  sent.length = 0
  // the editor writes an edit
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', false]])
  // (a local trial keeps the edit beside the sample — and has no published address: one as a storage host would have)
  assert.equal(readFileSync(join(samples, 'memo.txt.edited.txt'), 'utf8'), '첫 줄\n고친 줄\n')
  contents.publishedUrl = 'http://127.0.0.1:54321/storage/v1/object/public/files/test/edited-memo_20261127000000.txt'
  // saved again with the same bytes
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged, p.url]), [['office:saved', true, contents.publishedUrl]])
  // another file of the workspace (an asset, a temporary file)
  sent.length = 0
  writeFileSync(join(dir, 'other.tmp'), 'x')
  await wait(1500)
  assert.deepEqual(sent, [])
})

test('an upload may take a base time plus time for its size (not cut off for being large); past that it is given up', async () => {
  // a document of a few MB: well inside the page's own wait for a save (Process GPT Lite SAVE_WAIT_MS 30 s); a large one gets longer
  // (and is announced to the page — office:saving, below)
  assert.ok(uploadLimitMs(3 * 1024 * 1024) < 30_000)
  assert.ok(uploadLimitMs(3 * 1024 * 1024) >= 15_000)
  assert.ok(uploadLimitMs(50 * 1024 * 1024) > 100_000)
  assert.ok(uploadLimitMs(20 * 1024 * 1024) > uploadLimitMs(10 * 1024 * 1024))
  const held = []
  const server = createServer((req, res) => {
    held.push(req)
    if (req.url.includes('stuck')) return // takes the request, answers nothing
    // takes it all, then answers slowly (1.2 s)
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); setTimeout(() => res.end('{"Key":"ok"}'), 1200) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  const up = (path, timeoutMs) => uploadToStorage({ origin, bucket: 'files' }, path, Buffer.from('x'), 'text/plain', {}, { timeoutMs })
  try {
    let t0 = Date.now()
    await assert.rejects(up('stuck/edited-x_20261127000000.txt', 300), /abort|timeout/i)
    assert.ok(Date.now() - t0 < 3000)
    // slow, but inside its limit: it goes up
    t0 = Date.now()
    assert.match(await up('slow/edited-x_20261127000000.txt', 3000), /slow/)
    assert.ok(Date.now() - t0 > 1000)
  } finally {
    for (const r of held) r.socket.destroy()
    server.close()
  }
})

test('after an upload that failed, the opening saves to a new address of its own (edited-<stem>_<14 digits>, a later time) — a late landing of the old one cannot overwrite a newer save', async () => {
  assert.equal(editedObjectPath('pgpt-pro/u/att/memo.txt', 'txt', { after: 'pgpt-pro/u/att/edited-memo_29991231235959.txt' }), 'pgpt-pro/u/att/edited-memo_30000101000000.txt')
  assert.match(editedObjectPath('pgpt-pro/u/copies/edited-ab_20261127000000.txt', 'txt'), /\/edited-ab_\d{14}\.txt$/)
  const sent = []
  const contents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]), userToken: 'user (test)' })
  opened.push(contents)
  const { file } = await openWorkspace(contents, { src: `${STORE}/storage/v1/object/public/files/pgpt-pro/u/att/memo.txt`, name: 'memo.txt' })
  await wait(300)
  store.fail = 1
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  // (each upload announced first, with how long the page should wait for it)
  assert.deepEqual(sent.map(([c]) => c), ['office:saving', 'office:save-failed'])
  assert.equal(sent[0][1].limitMs, uploadLimitMs(sent[0][1].size))
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n또 고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c]) => c), ['office:saving', 'office:saved'])
  const [first, second] = store.posts
  assert.equal(first.failed, true)
  for (const p of [first.path, second.path]) assert.match(p, /^pgpt-pro\/u\/att\/edited-memo_\d{14}\.txt$/)
  assert.ok(second.path > first.path, `${second.path} after ${first.path}`)
  assert.equal(second.body, '첫 줄\n고친 줄\n또 고친 줄\n')
  // the page is told where it went
  assert.ok(sent[1][1].url.endsWith(second.path.split('/').map(encodeURIComponent).join('/')))
  // a save after a good one stays where it is (one address per opening, until an upload fails)
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n')
  await wait(1500)
  assert.equal(store.posts[2].path, second.path)
})

test('an upload that failed: no bytes count as saved after it, and its bytes go up again only when the editor writes the document again', async () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]) })
  opened.push(contents)
  const { file, dir } = await openWorkspace(contents, { src: 'draft.txt' })
  await wait(300)
  // (where a local trial keeps the edit is taken by a folder: the copy cannot be written)
  const blocked = join(samples, 'draft.txt.edited.txt')
  mkdirSync(blocked)
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c]) => c), ['office:save-failed'])
  rmSync(blocked, { recursive: true, force: true })
  // another file of the workspace changes: the failed bytes are not sent up by themselves (and no 「saved」 nobody asked for)
  sent.length = 0
  writeFileSync(join(dir, 'other.tmp'), 'x')
  await wait(1500)
  assert.deepEqual(sent, [])
  // the editor saves them again (its 저장 · ⌘S — the page's 다시 시도): they go up, as a save, not as 「unchanged」
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', false]])
  assert.equal(readFileSync(blocked, 'utf8'), '첫 줄\n고친 줄\n')
  // after a failure the bytes saved before it are not 「unchanged」 either: what the copy holds was not known
  rmSync(blocked)
  mkdirSync(blocked)
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n또 고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c]) => c), ['office:save-failed'])
  rmSync(blocked, { recursive: true, force: true })
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', false]])
  assert.equal(readFileSync(blocked, 'utf8'), '첫 줄\n고친 줄\n')
})

test('the page asks for the editor\'s last write to go up again (republish): answered as a save — unchanged when it is up, sent when its upload failed', async () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]) })
  opened.push(contents)
  const { file } = await openWorkspace(contents, { src: 'again.txt' })
  await wait(300)
  // nothing written since it opened: answered at once, as the document it opened (no address)
  contents.republish()
  await wait(300)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged, p.url]), [['office:saved', true, null]])
  // a write whose upload fails; the editor takes it as saved and writes nothing more
  const blocked = join(samples, 'again.txt.edited.txt')
  mkdirSync(blocked)
  sent.length = 0
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c]) => c), ['office:save-failed'])
  rmSync(blocked, { recursive: true, force: true })
  // asked: the same bytes go up (the document was not written again — the editor's 저장 is off)
  sent.length = 0
  contents.republish()
  await wait(500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', false]])
  assert.equal(readFileSync(blocked, 'utf8'), '첫 줄\n고친 줄\n')
  // and asked again: they are up — unchanged
  sent.length = 0
  contents.republish()
  await wait(300)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', true]])
})
