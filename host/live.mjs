// Live sessions: an agent edits a document a person has open, in front of them.
//
// The editors already carry an MCP bridge (apps/docs|sheets/src/renderer/mcp-bridge.ts):
// the desktop shell pushes `<editor>:mcp-command`, the live editor runs it with the
// built-in agent's own executors and answers on `<editor>:mcp-result`. The host plays
// the shell's part, so a process-gpt agent's edits appear in the open editor as they
// happen, and the page is told an agent is writing.
import { randomUUID } from 'node:crypto'
import { ipcMain, webContents } from './electron-main-shim.mjs'

// 한글: the page answers for its editor (page-live.mjs), the editors' own bridge covers docs and sheets
export const LIVE_EDITORS = new Set(['docs', 'sheets', 'hwp'])
const pending = new Map() // requestId -> { resolve, timer }

for (const editor of LIVE_EDITORS) {
  ipcMain.on(`${editor}:mcp-ready`, (event) => {
    event.sender.mcpReady = true
  })
  ipcMain.on(`${editor}:mcp-result`, (_event, result) => {
    const call = result && pending.get(result.requestId)
    if (!call) return
    pending.delete(result.requestId)
    clearTimeout(call.timer)
    call.resolve(result)
  })
}

/** a connection becomes a live session once its editor is open */
export function registerSession(contents, editor) {
  contents.sessionId = randomUUID()
  contents.editorName = editor
}

/** the open documents of one user (the token's subject), as agents see them */
export function sessionsOf(userSub) {
  return webContents
    .getAllWebContents()
    .filter((c) => c.sessionId && !c.isDestroyed() && LIVE_EDITORS.has(c.editorName) && c.user?.sub === userSub)
    .map((c) => ({
      session_id: c.sessionId,
      editor: c.editorName,
      file_name: c.documentPath ? c.documentPath.split('/').pop() : null,
      file_url: c.source?.url ?? null,
      read_only: Boolean(c.readOnly),
      ready: Boolean(c.mcpReady),
    }))
}

export function sessionFor(userSub, sessionId) {
  const c = webContents.getAllWebContents().find((x) => x.sessionId === sessionId && !x.isDestroyed())
  if (!c || c.user?.sub !== userSub) throw new Error('열려 있는 그 문서를 찾지 못했습니다(office_live_documents 로 다시 확인하세요)')
  if (!c.mcpReady) throw new Error('문서가 아직 열리는 중입니다. 잠시 뒤 다시 시도하세요')
  return c
}

/** run one editor command in the live editor and wait for its answer */
export function runLive(contents, command, payload, timeoutMs = 60_000) {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`편집기가 ${timeoutMs / 1000}초 안에 답하지 않았습니다`))
    }, timeoutMs)
    pending.set(requestId, {
      timer,
      resolve: (result) => (result.ok ? resolve(result.result) : reject(new Error(result.error || '편집기가 명령을 거절했습니다'))),
    })
    contents.send(`${contents.editorName}:mcp-command`, { requestId, command, payload })
  })
}

/** tell the page (and through it, process-gpt) that an agent is writing */
export function announce(contents, detail) {
  contents.send('office:agent', detail)
}
