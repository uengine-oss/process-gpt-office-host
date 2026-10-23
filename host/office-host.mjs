// The web host: runs the editors' own main-process modules (bundled with
// `electron` → electron-main-shim) and serves them to browser pages.
//
//   GET  /office/<editor>/?src=<document url>&name=<file name>&token=<jwt>   editor page
//   WS   /office/__ipc     the page's ipcRenderer (one connection = one editor tab)
//   GET  /office/__proto/<scheme>/…   the editors' custom-scheme responders (bytes, media, fonts)
//   POST /office/mcp       office-worker: document engines as MCP tools for agents (worker-mcp.mjs)
//   GET  /office/licenses/ open-source notices
//
// Pages are meant to be framed by process-gpt; they tell the parent window about
// saves with postMessage (see electron-renderer-shim.mjs).
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { app, HostWebContents, handlers, ipcMain, listeners, protocolHandlers } from './electron-main-shim.mjs'
import { decode, encode } from './wire.mjs'
import { describeLlm, installRequestTuning, pageAiSettings, withServerSettings, writeSettingsFile } from './ai-settings.mjs'
import { guardPaths, openWorkspace } from './documents.mjs'
import { configureEditors, EDITORS, openEditor } from './editors.mjs'
import { sanitizeContext, withWorkContext } from './work-context.mjs'
import { authRequired, verifyToken } from './auth.mjs'
import { handleWorkerMcp } from './worker-mcp.mjs'
import { registerSession } from './live.mjs'
import { staticHandler } from './static.mjs'
import { findForkRoot } from './fork-root.mjs'

const here = dirname(fileURLToPath(import.meta.url)) // host/dist
const web = resolve(here, '../..')
const PORT = Number(process.env.IEUM_HOST_PORT) || 5390
// the CLI command layer (office-worker) resolves jsdom, WASM and the sidecar from here (build.mjs fork-root)
const fork = findForkRoot(web)
process.env.IEUM_FORK_ROOT ??= fork

configureEditors({
  templateFontsDir: resolve(fork, 'packages/ui/template-fonts'),
  sidecarPath: process.env.XLSX_SIDECAR_PATH,
})

// ---- AI: the in-house LLM, configured here only (ai-settings.mjs) ----
writeSettingsFile(app.getPath('userData'))
installRequestTuning()
ipcMain.removeHandler('ai:get-settings')
ipcMain.handle('ai:get-settings', () => pageAiSettings())
ipcMain.removeHandler('ai:set-settings')
ipcMain.handle('ai:set-settings', () => {}) // the model is the platform's choice, not the page's

// ---- HTTP ----
const serveStatic = staticHandler({
  webRoot: resolve(web, 'dist/web'),
  licensesRoot: resolve(web, 'dist/licenses'),
  preloadRoot: here,
  editors: EDITORS,
})

const server = createServer(async (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0]
  // /office/__proto/<scheme>/<rest> → that editor's protocol.handle responder
  const proto = /^(?:\/office)?\/__proto\/([^/]+)\/(.*)$/.exec(req.url ?? '')
  if (proto) {
    const responder = protocolHandlers.get(proto[1])
    if (!responder) return void res.writeHead(404).end()
    try {
      const response = await responder(new Request(`${proto[1]}://${proto[2]}`))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      return void res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      return void res.writeHead(500).end(String(err?.message || err))
    }
  }
  // office-worker: the document engines as MCP tools for process-gpt agents
  if (pathname === '/office/mcp') {
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end()
    return void handleWorkerMcp(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err?.message || err))
    })
  }
  if (serveStatic(req, res, pathname)) return
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ ok: true, channels: handlers.size, llm: describeLlm() }))
  }
  res.writeHead(404).end()
})

// ---- WebSocket: one editor tab per connection ----
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  if (!/^(?:\/office)?\/__ipc(\?|$)/.test(req.url ?? '')) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (socket, req) => {
  const query = new URL(req.url, 'http://host').searchParams
  const send = (frame) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(frame))
  const contents = new HostWebContents((channel, args) => send({ t: 'event', channel, args: encode(args) }))
  socket.on('close', () => contents.destroy())

  const editor = query.get('editor') || ''
  contents.ready = (async () => {
    contents.user = verifyToken(query.get('token'))
    contents.userToken = query.get('token') || null
    if (!EDITORS.includes(editor)) throw new Error(`unknown editor: ${editor}`)
    contents.readOnly = query.get('readonly') === '1'
    const { file } = await openWorkspace(contents, {
      src: query.get('src'),
      name: query.get('name'),
      readOnly: contents.readOnly,
    })
    openEditor(editor, contents, file)
    registerSession(contents, editor)
  })()
  contents.ready.catch((err) => {
    console.warn(`[web-host] ${editor}: ${err.message}`)
    contents.send('office:error', { error: err.message })
  })

  socket.on('message', async (data) => {
    const frame = JSON.parse(String(data))
    const reply = (value, error) => send({ t: 'reply', id: frame.id, ...(error ? { error } : { value: encode(value) }) })
    try {
      await contents.ready
      if (frame.t === 'context') {
        contents.workContext = sanitizeContext(frame.context)
        if (contents.workContext) {
          console.log(`[web-host] work context: ${contents.workContext.activity || '-'} (${contents.workContext.inputs.length} inputs)`)
        }
        return
      }
      const args = withWorkContext(contents, withServerSettings(decode(frame.args ?? [])))
      guardPaths(contents, frame.channel, args)
      const event = {
        sender: contents,
        senderFrame: { url: contents.getURL() },
        reply: (ch, ...a) => contents.send(ch, ...a),
      }
      if (frame.t === 'input') {
        // main-process shortcuts (see the renderer shim)
        contents.emit('before-input-event', { preventDefault() {} }, frame.input)
        return
      }
      if (frame.t === 'send') {
        for (const fn of listeners.get(frame.channel) ?? []) fn({ ...event, returnValue: undefined }, ...args)
        return
      }
      const handler = handlers.get(frame.channel)
      if (!handler) return reply(undefined, `No handler registered for '${frame.channel}'`)
      reply(await handler(event, ...args))
    } catch (err) {
      if (frame.t === 'invoke') reply(undefined, String(err?.message || err))
      else console.warn(`[web-host] ${frame.channel}: ${err?.message || err}`)
    }
  })
})

server.listen(PORT, () => {
  console.log(`[web-host] ready on :${PORT} — ${handlers.size} ipc channels, editors: ${EDITORS.join(', ')}`)
  console.log(`[web-host] AI: ${describeLlm()}`)
  if (!authRequired()) console.warn('[web-host] SUPABASE_JWT_SECRET not set: connections are not authenticated (local trial only)')
})

// the editors' exit hooks (sidecar shutdown) run on process exit; make signals end it
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
