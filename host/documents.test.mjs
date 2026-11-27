// How a tab's document gets back to the platform (host/documents.mjs): a save of new bytes is published and said; the same bytes
// written again (an edit undone before 저장) are said too — the page that pressed 저장 is not left waiting (production 2026-11-27,
// Process GPT Lite: a save that got no answer stayed 「저장 중…」) — and another file of the workspace changing says nothing.
//   node --test host/documents.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const samples = mkdtempSync(join(tmpdir(), 'ieum-doc-samples-'))
const data = mkdtempSync(join(tmpdir(), 'ieum-doc-data-'))
process.env.IEUM_WORKSPACE = samples
process.env.IEUM_HOST_DATA = data
writeFileSync(join(samples, 'memo.txt'), '첫 줄\n')
const { openWorkspace, CONTENT_TYPES } = await import('./documents.mjs')
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

test('new bytes are published and said; the same bytes written again are said as unchanged; another file says nothing', async () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push([channel, payload]) })
  opened.push(contents)
  const { file, dir } = await openWorkspace(contents, { src: 'memo.txt' })
  await wait(300)
  // the editor writes an edit
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', false]])
  // (a local trial keeps the edit beside the sample)
  assert.equal(readFileSync(join(samples, 'memo.txt.edited.txt'), 'utf8'), '첫 줄\n고친 줄\n')
  // saved again with the same bytes
  sent.length = 0
  await wait(20)
  writeFileSync(file, '첫 줄\n고친 줄\n')
  await wait(1500)
  assert.deepEqual(sent.map(([c, p]) => [c, !!p.unchanged]), [['office:saved', true]])
  // another file of the workspace (an asset, a temporary file)
  sent.length = 0
  writeFileSync(join(dir, 'other.tmp'), 'x')
  await wait(1500)
  assert.deepEqual(sent, [])
})
