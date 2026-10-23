// `electron` for the editors' main-process code when it runs inside the web host
// (Node, no Electron). ipcMain handlers are collected here and served over a
// WebSocket by office-host.mjs; each browser connection is a WebContents.
// Desktop-only surfaces (menus, native dialogs, windows) are inert.
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const handlers = new Map() // channel -> (event, ...args) => any
export const listeners = new Map() // channel -> Set<(event, ...args) => void>

const dataRoot = resolve(process.env.IEUM_HOST_DATA || join(tmpdir(), 'ieum-web-host'))

export const ipcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn)
  },
  handleOnce(channel, fn) {
    handlers.set(channel, fn)
  },
  removeHandler(channel) {
    handlers.delete(channel)
  },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(fn)
    return ipcMain
  },
  once(channel, fn) {
    const wrapped = (...args) => {
      ipcMain.removeListener(channel, wrapped)
      fn(...args)
    }
    return ipcMain.on(channel, wrapped)
  },
  removeListener(channel, fn) {
    listeners.get(channel)?.delete(fn)
    return ipcMain
  },
  removeAllListeners(channel) {
    if (channel) listeners.delete(channel)
    else listeners.clear()
    return ipcMain
  },
}

// one per browser connection; `send` pushes to that page
const contentsById = new Map()
let nextId = 1

// window/view features the editors poke at but a web page has no use for
// (zoom, devtools, capture, find…): any member the class lacks is a no-op
const tolerant = (target) =>
  new Proxy(target, {
    get(t, key, receiver) {
      if (key in t || typeof key !== 'string') return Reflect.get(t, key, receiver)
      return () => undefined
    },
  })

export class HostWebContents extends EventEmitter {
  constructor(push) {
    super()
    this.id = nextId++
    this.push = push
    this.destroyed = false
    this.session = tolerant({ on() {} })
    this.ipc = tolerant({ handle() {}, on() {} })
    // the host's own per-tab state (documents.mjs, office-host.mjs); declared here so
    // the tolerant proxy below reads them as values, not as no-op methods
    Object.assign(this, {
      ready: null,
      user: null,
      userToken: null,
      workspace: null,
      documentPath: null,
      source: null,
      savedHash: null,
      editedPath: null,
      stopWatch: null,
      workContext: null,
      readOnly: false,
      sessionId: null,
      editorName: null,
      mcpReady: false,
      publishedUrl: null,
    })
    contentsById.set(this.id, this)
    return tolerant(this)
  }
  send(channel, ...args) {
    if (!this.destroyed) this.push(channel, args)
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    contentsById.delete(this.id)
    this.emit('destroyed')
  }
  getURL() {
    return 'http://web-host/'
  }
  isLoading() {
    return false
  }
  focus() {}
  setWindowOpenHandler() {}
  getOwnerBrowserWindow() {
    return null
  }
  loadURL() {
    return Promise.resolve()
  }
  loadFile() {
    return Promise.resolve()
  }
  setBackgroundThrottling() {}
}

export const webContents = {
  fromId: (id) => contentsById.get(id) ?? null,
  getAllWebContents: () => [...contentsById.values()],
  getFocusedWebContents: () => null,
}

export class BrowserWindow extends EventEmitter {
  static fromWebContents() {
    return null
  }
  static getFocusedWindow() {
    return null
  }
  static getAllWindows() {
    return []
  }
  constructor() {
    super()
    throw new Error('BrowserWindow is not available in the web host')
  }
}

// an editor module that builds its own view (createDocsView, createSheetsView…) gets the connecting page's
// contents: the host sets `viewContents.next` right before calling it
export const viewContents = { next: null }
export class WebContentsView {
  constructor() {
    if (!viewContents.next) throw new Error('WebContentsView is not available in the web host')
    this.webContents = viewContents.next
    viewContents.next = null
    return tolerant(this)
  }
}

const paths = {}
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  name: 'IeumOffice Web',
  getPath(name) {
    paths[name] ??= (() => {
      const dir = join(dataRoot, name)
      mkdirSync(dir, { recursive: true })
      return dir
    })()
    return paths[name]
  },
  setPath(name, value) {
    paths[name] = value
  },
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-web',
  getName: () => 'IeumOffice Web',
  getLocale: () => 'ko',
  getSystemLocale: () => 'ko-KR',
  getPreferredSystemLanguages: () => ['ko-KR'],
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  quit() {},
  exit() {},
  focus() {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId() {},
  addRecentDocument() {},
  clearRecentDocuments() {},
  commandLine: { appendSwitch() {}, hasSwitch: () => false, getSwitchValue: () => '' },
})

// no person sits at a native dialog: confirmations take their default button,
// pickers are cancelled (the web page chooses files through process-gpt instead)
export const dialog = {
  showMessageBox: async (_win, options) => ({ response: (options ?? _win)?.defaultId ?? 0, checkboxChecked: false }),
  showMessageBoxSync: (_win, options) => (options ?? _win)?.defaultId ?? 0,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => undefined,
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: () => undefined,
  showErrorBox(title, content) {
    console.warn(`[web-host] ${title}: ${content}`)
  },
}

export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder() {},
  trashItem: async () => {},
  beep() {},
}

const menuStub = { popup() {}, closePopup() {}, append() {}, items: [] }
export const Menu = {
  buildFromTemplate: () => ({ ...menuStub }),
  setApplicationMenu() {},
  getApplicationMenu: () => null,
}
export class MenuItem {
  constructor(options) {
    Object.assign(this, options)
  }
}

export const nativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  themeSource: 'light',
})

export const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }),
  createFromBuffer: (buf) => ({ isEmpty: () => !buf?.length, toPNG: () => buf, getSize: () => ({ width: 0, height: 0 }) }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
}

export const clipboard = { readText: () => '', writeText() {}, readImage: () => nativeImage.createEmpty(), writeImage() {}, availableFormats: () => [], read: () => '', readBuffer: () => Buffer.alloc(0), clear() {} }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [], getDisplayNearestPoint: () => ({ scaleFactor: 1 }) }
// custom-scheme responders (document bytes, lazy media, fonts) are fetch-style
// handlers; the host serves them over HTTP under /__proto/<scheme>/...
export const protocolHandlers = new Map()
export const protocol = {
  registerSchemesAsPrivileged() {},
  handle(scheme, fn) {
    protocolHandlers.set(scheme, fn)
  },
  unhandle(scheme) {
    protocolHandlers.delete(scheme)
  },
  isProtocolHandled: (scheme) => protocolHandlers.has(scheme),
}
export const session = {
  defaultSession: { on() {}, protocol, setSpellCheckerLanguages() {}, availableSpellCheckerLanguages: [], setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, resolveProxy: async () => 'DIRECT' },
  fromPartition: () => session.defaultSession,
}
export const desktopCapturer = { getSources: async () => [] }
export const net = { fetch: (...args) => fetch(...args) }
export const powerMonitor = Object.assign(new EventEmitter(), {})
export const powerSaveBlocker = { start: () => 0, stop() {} }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
export const globalShortcut = { register: () => false, unregister() {}, unregisterAll() {} }
export const systemPreferences = { getAccentColor: () => '0078d4ff', on() {} }
export const crashReporter = { start() {} }
export const autoUpdater = Object.assign(new EventEmitter(), { setFeedURL() {}, checkForUpdates() {} })
export const utilityProcess = {
  fork() {
    throw new Error('utilityProcess is not available in the web host')
  },
}
export const contextBridge = { exposeInMainWorld() {} }
export const ipcRenderer = { invoke: async () => null, send() {}, on() {}, removeListener() {} }
export const webUtils = { getPathForFile: () => '' }

export default {
  ipcMain, webContents, BrowserWindow, WebContentsView, app, dialog, shell, Menu, MenuItem,
  nativeTheme, nativeImage, clipboard, screen, protocol, session, net, powerMonitor,
  powerSaveBlocker, safeStorage, globalShortcut, systemPreferences, crashReporter,
  autoUpdater, utilityProcess, contextBridge, ipcRenderer, webUtils, desktopCapturer,
}
