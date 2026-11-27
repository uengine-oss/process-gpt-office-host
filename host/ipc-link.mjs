// The editor page's one connection to the web host (the renderer shim's WebSocket, /office/__ipc), as frames go out on it.
// Kept apart from the shim (which needs a page) so it is tested in Node: host/ipc-link.test.mjs.
//
// Production 2026-11-27 (Process GPT Lite, a chat's TXT open in the markdown editor): Cloudflare in front of the host ends a WebSocket
// that carries nothing for about 100 s (measured at the production address: closed after 125 s with 1006). The shim then went on
// sending into the closed socket — a browser drops such a frame without a word — so the editor's 저장 waited for an answer for good
// (「저장 중…」). Here: a heartbeat frame keeps the connection from going idle, and a frame for a socket that is not open is refused at
// once, so every request gets an answer (the shim rejects it: the editor shows its save failed).
export const HEARTBEAT_MS = 30_000
const OPEN = 1

/**
 * socket: a WebSocket (or anything with readyState · send · addEventListener('open' | 'close'))
 * → { opened: Promise (rejects if the socket closes first), closed, send(frame): Promise — resolves once sent, rejects when not open }
 */
export function createLink(socket, { heartbeatMs = HEARTBEAT_MS, every = setInterval, stop = clearInterval } = {}) {
  let closed = false
  const gone = () => new Error('web host disconnected')
  const opened = new Promise((resolve, reject) => {
    if (socket.readyState === OPEN) resolve()
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('close', () => reject(gone()), { once: true })
  })
  opened.catch(() => {})
  const timer = heartbeatMs > 0 ? every(() => { if (!closed && socket.readyState === OPEN) socket.send('{"t":"ping"}') }, heartbeatMs) : null
  socket.addEventListener('close', () => { closed = true; if (timer != null) stop(timer) })
  return {
    opened,
    get closed() { return closed },
    async send(frame) {
      await opened
      if (closed || socket.readyState !== OPEN) throw gone()
      socket.send(JSON.stringify(frame))
    },
  }
}
