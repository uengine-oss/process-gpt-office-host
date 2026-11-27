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
const { openWorkspace, CONTENT_TYPES, uploadToStorage, UPLOAD_TIMEOUT_MS } = await import('./documents.mjs')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const opened = []
after(() => {
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

test('an upload that does not fail but never ends is given up after its time limit (not waited on with every later save behind it)', async () => {
  assert.equal(UPLOAD_TIMEOUT_MS, 60_000)
  const hung = []
  const server = createServer((req) => { hung.push(req) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const t0 = Date.now()
    await assert.rejects(uploadToStorage({ origin, bucket: 'files' }, 'pgpt-pro/u/copies/edited-x.txt', Buffer.from('x'), 'text/plain', {}, { timeoutMs: 300 }), /abort|timeout/i)
    assert.ok(Date.now() - t0 < 5000)
  } finally {
    for (const r of hung) r.socket.destroy()
    server.close()
  }
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
