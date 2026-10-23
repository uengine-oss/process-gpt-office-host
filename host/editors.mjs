// The eight editors, wired the way the desktop shell wires them
// (apps/shell/src/main/index.ts configures the runtimes, tab-manager.ts makes a
// view per tab). Here a "tab" is one WebSocket connection: the shim hands the
// editor's `new WebContentsView()` that connection's contents.
import { setUiLang } from '@ieum/packages/i18n/src/index'
import { viewContents } from './electron-main-shim.mjs'
import {
  configureDocsRuntime,
  createDocsView,
  markDocsNewBlank,
  registerAiIpc,
  registerDocsIpc,
  registerProjectIpc,
} from '@ieum/apps/docs/src/main/docs-main'
import { registerLazyMediaProtocol } from '@ieum/apps/docs/src/main/lazy-media'
import {
  configureSheetsRuntime,
  createSheetsView,
  queueWorkbookForView,
  setSheetsNewBlank,
} from '@ieum/apps/sheets/src/main/sheets-main'
import { configureSlidesRuntime } from '@ieum/apps/slides/src/main/session-state'
import { createSlidesView } from '@ieum/apps/slides/src/main/slides-main'
import { configurePdfRuntime, createPdfView } from '@ieum/apps/pdf/src/main/pdf-main'
import { configureMarkdownRuntime, createMarkdownView } from '@ieum/apps/markdown/src/main/markdown-main'
import { configureHtmlRuntime, createHtmlView } from '@ieum/apps/html/src/main/html-main'
import { configureMindmapRuntime, createMindmapView } from '@ieum/apps/mindmap/src/main/mindmap-main'
import { configureHwpRuntime, createHwpView } from '@ieum/apps/hwp/src/main/hwp-main'

/** which editor opens which extension (the shell's file routing) */
export const EDITOR_BY_EXT = {
  docx: 'docs', odt: 'docs',
  xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets',
  pptx: 'slides',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', txt: 'markdown',
  html: 'html', htm: 'html',
  xmind: 'mindmap',
  hwp: 'hwp', hwpx: 'hwp',
}
export const EDITORS = [...new Set(Object.values(EDITOR_BY_EXT))]

export function configureEditors({ templateFontsDir, sidecarPath }) {
  setUiLang(process.env.IEUM_LANG || 'ko')
  // preload/renderer locations are the web host's business, not the editors'
  const none = { preloadPath: '', rendererFile: '' }
  configureDocsRuntime(none)
  configureSheetsRuntime({ ...none, sidecarPath })
  configureSlidesRuntime({ preloadPath: '', rendererFilePath: '' })
  configurePdfRuntime(none)
  configureMarkdownRuntime(none)
  configureHtmlRuntime(none)
  configureMindmapRuntime(none)
  configureHwpRuntime(none)
  // the shell registers these once for every editor
  registerAiIpc()
  registerProjectIpc()
  registerDocsIpc()
  registerLazyMediaProtocol(templateFontsDir)
}

/** open `file` (null = a new document) in `editor` on this connection */
export function openEditor(editor, contents, file) {
  viewContents.next = contents
  switch (editor) {
    case 'docs': {
      const view = createDocsView(file ?? undefined)
      if (!file) markDocsNewBlank(view.webContents.id)
      return
    }
    case 'sheets': {
      if (!file) setSheetsNewBlank()
      createSheetsView({ includeAiHandlers: false, openingWorkbook: Boolean(file) })
      if (file) queueWorkbookForView(contents, file)
      return
    }
    case 'slides':
      return void createSlidesView(file)
    case 'pdf':
      return void createPdfView(file)
    case 'markdown':
      return void createMarkdownView(file)
    case 'html':
      return void createHtmlView(file)
    case 'mindmap':
      return void createMindmapView(file)
    case 'hwp':
      return void createHwpView(file)
    default:
      viewContents.next = null
      throw new Error(`unknown editor: ${editor}`)
  }
}
