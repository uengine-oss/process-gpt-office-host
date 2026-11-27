// The editor page's connection to the web host (host/ipc-link.mjs): production 2026-11-27, Cloudflare ended an idle editor WebSocket
// after ~100 s and the editor's 저장 then went into the closed socket and waited for good (「저장 중…」).
//   node --test host/ipc-link.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { beatFromHost, createLink, HEARTBEAT_MS } from './ipc-link.mjs'

// a stand-in WebSocket: like a browser's, a frame sent while not open is not an error here — it would just be lost
class FakeSocket extends EventTarget {
  readyState = 0
  sent = []
  lost = []
  send(d) { (this.readyState === 1 ? this.sent : this.lost).push(d) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
// timers the test turns by hand
function clock() {
  const fns = new Map()
  let n = 0
  return { every: (fn) => { fns.set(++n, fn); return n }, stop: (id) => fns.delete(id), tick: () => { for (const fn of fns.values()) fn() }, get count() { return fns.size } }
}

test('a frame waits for the connection to open, then goes out', async () => {
  const s = new FakeSocket()
  const c = clock()
  const link = createLink(s, c)
  const p = link.send({ t: 'invoke', id: 1, channel: 'markdown:save' })
  assert.deepEqual(s.sent, [])
  s.open()
  await p
  assert.deepEqual(s.sent.map((x) => JSON.parse(x).channel), ['markdown:save'])
})

test('a heartbeat goes out while the connection is open (inside Cloudflare\'s 100 s), and stops when it closes', async () => {
  assert.ok(HEARTBEAT_MS < 100_000)
  const s = new FakeSocket()
  const c = clock()
  createLink(s, c)
  c.tick()
  assert.deepEqual(s.sent, []) // not open yet: nothing
  s.open()
  c.tick(); c.tick()
  assert.deepEqual(s.sent, ['{"t":"ping"}', '{"t":"ping"}'])
  s.close()
  assert.equal(c.count, 0)
  c.tick()
  assert.equal(s.lost.length, 0)
})

test('after the connection closed, a frame is refused at once — never sent into the closed socket to wait for good', async () => {
  const s = new FakeSocket()
  const link = createLink(s, clock())
  s.open()
  s.close()
  assert.equal(link.closed, true)
  await assert.rejects(link.send({ t: 'invoke', id: 2, channel: 'markdown:save' }), /web host disconnected/)
  assert.deepEqual(s.lost, [])
})

test('a connection that closes before it opens: what waits for it is refused', async () => {
  const s = new FakeSocket()
  const link = createLink(s, clock())
  const p = link.send({ t: 'send', channel: 'x' })
  s.close()
  await assert.rejects(p, /web host disconnected/)
  await assert.rejects(link.opened, /web host disconnected/)
})

test('a link made on a socket already closed: what waits for it is refused at once (its close event is past)', async () => {
  const s = new FakeSocket()
  s.readyState = 3
  const c = clock()
  const link = createLink(s, c)
  assert.equal(link.closed, true)
  await assert.rejects(link.opened, /web host disconnected/)
  await assert.rejects(link.send({ t: 'invoke', id: 3, channel: 'markdown:save' }), /web host disconnected/)
  assert.equal(c.count, 0)
})

test('the host beats too (a background tab\'s timers are slowed), until the connection closes', () => {
  const s = new FakeSocket()
  const c = clock()
  const out = []
  beatFromHost(s, (f) => out.push(f), c)
  c.tick(); c.tick()
  assert.deepEqual(out, [{ t: 'ping' }, { t: 'ping' }])
  s.close()
  assert.equal(c.count, 0)
})
