// `electron` for an editor's preload when it is bundled into a web page: the
// preload's contextBridge exposes onto window, and its ipcRenderer talks to the
// web host over one WebSocket (invoke = request/response, send = one-way,
// on = pushes from webContents.send on the host).
import { decode, encode } from './wire.mjs'

const params = new URLSearchParams(location.search)
// the host sits one level above the editor page (/office/<editor>/ → /office/);
// in the Vite dev setup the page is at / and this resolves to / as well
const hostBase = new URL('../', location.href)
const wsUrl = (() => {
  if (params.get('ipc')) return params.get('ipc')
  const url = new URL('__ipc', hostBase)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('editor', typeof __IEUM_EDITOR__ === 'string' ? __IEUM_EDITOR__ : '')
  // `file` is the local-trial alias of `src`
  for (const [from, to] of [['src', 'src'], ['file', 'src'], ['name', 'name'], ['token', 'token'], ['readonly', 'readonly']]) {
    if (params.get(from)) url.searchParams.set(to, params.get(from))
  }
  return url.href
})()

// the desktop app serves document bytes, media and fonts on custom schemes
// (genoffice-docx-media://…); the web host serves the same responders under __proto
const CUSTOM_SCHEME = /^(genoffice-[a-z-]+):\/\/(.*)$/
const protoBase = new URL('__proto/', hostBase).pathname
const toHttp = (url) => {
  const m = typeof url === 'string' && CUSTOM_SCHEME.exec(url)
  return m ? `${protoBase}${m[1]}/${m[2]}` : url
}

// the framing page (process-gpt) hears about the document: ready, saved, errors
const toParent = (type, detail) => {
  if (window.parent !== window) window.parent.postMessage({ source: 'ieum-office', type, ...detail }, '*')
}
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => nativeFetch(typeof input === 'string' ? toHttp(input) : input, init)
const NativeFontFace = window.FontFace
window.FontFace = function (family, source, descriptors) {
  const src = typeof source === 'string' ? source.replace(/genoffice-[a-z-]+:\/\/[^)'"\s]+/g, toHttp) : source
  return new NativeFontFace(family, src, descriptors)
}
const rewrite = (value) => {
  if (typeof value === 'string') return toHttp(value)
  if (Array.isArray(value)) return value.map(rewrite)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    for (const k of Object.keys(value)) value[k] = rewrite(value[k])
  }
  return value
}

let socket
let open
const pending = new Map() // id -> { resolve, reject }
const subscribers = new Map() // channel -> Set<listener>
let nextId = 1

function connect() {
  socket = new WebSocket(wsUrl)
  open = new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
  void open.then(() => toParent('ready', { editor: typeof __IEUM_EDITOR__ === 'string' ? __IEUM_EDITOR__ : '' }))
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data)
    if (frame.t === 'reply') {
      const call = pending.get(frame.id)
      pending.delete(frame.id)
      if (!call) return
      if (frame.error) call.reject(new Error(frame.error))
      else call.resolve(rewrite(decode(frame.value)))
    } else if (frame.t === 'event') {
      const args = rewrite(decode(frame.args))
      if (frame.channel.startsWith('office:')) return toParent(frame.channel.slice('office:'.length), args[0])
      subscribers.get(frame.channel)?.forEach((fn) => fn({ sender: ipcRenderer }, ...args))
    }
  })
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('web host disconnected'))
    pending.clear()
    toParent('closed', {})
  })
}
connect()

async function post(frame) {
  await open
  socket.send(JSON.stringify(frame))
}

// the framing page (process-gpt) sends the work item context for the editor's AI
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.source !== 'process-gpt') return
  if (event.data.type === 'context') void post({ t: 'context', context: event.data.context })
})

// The desktop app takes some shortcuts in the main process (before-input-event: the HWP
// editor's Ctrl/⌘+S and +P, which its inner iframe would otherwise swallow). Forward
// them, from this page and from same-origin frames inside it. The server's platform
// is not the user's, so either modifier counts as both.
const SHORTCUT_CODES = new Set(['KeyS', 'KeyP'])
const forwardShortcuts = (win) => {
  win.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || !SHORTCUT_CODES.has(e.code)) return
      if (e.code === 'KeyS') e.preventDefault() // never the browser's "save page"
      const input = { type: 'keyDown', code: e.code, key: e.key, shift: e.shiftKey, control: true, meta: true, alt: false, isAutoRepeat: false }
      void post({ t: 'input', input })
    },
    true,
  )
}
forwardShortcuts(window)
const watchFrame = (frame) => {
  const attach = () => {
    try {
      if (frame.contentWindow && !frame.contentWindow.__ieumKeys) {
        frame.contentWindow.__ieumKeys = true
        forwardShortcuts(frame.contentWindow)
      }
    } catch {
      // another origin: nothing to forward
    }
  }
  frame.addEventListener('load', attach)
  attach()
}
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.tagName === 'IFRAME') watchFrame(n)
}).observe(document.documentElement, { childList: true, subtree: true })

export const ipcRenderer = {
  invoke(channel, ...args) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      post({ t: 'invoke', id, channel, args: encode(args) })
    })
  },
  send(channel, ...args) {
    void post({ t: 'send', channel, args: encode(args) })
  },
  // a page cannot block on a socket; the few sync calls are fire-and-forget here
  sendSync(channel, ...args) {
    ipcRenderer.send(channel, ...args)
    return undefined
  },
  on(channel, listener) {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set())
    subscribers.get(channel).add(listener)
    return ipcRenderer
  },
  once(channel, listener) {
    const wrapped = (...args) => {
      ipcRenderer.removeListener(channel, wrapped)
      listener(...args)
    }
    return ipcRenderer.on(channel, wrapped)
  },
  removeListener(channel, listener) {
    subscribers.get(channel)?.delete(listener)
    return ipcRenderer
  },
  removeAllListeners(channel) {
    subscribers.delete(channel)
    return ipcRenderer
  },
}

export const contextBridge = {
  exposeInMainWorld(key, api) {
    window[key] = api
  },
}

export const webUtils = { getPathForFile: () => '' }

export default { ipcRenderer, contextBridge, webUtils }
