// office-worker: the editors' document engines as MCP tools for process-gpt agents.
//
// Agents decide WHAT to change; the engines edit the files with the same fidelity as
// the editors (no HTML round trip). Creating documents stays with office-mcp (the
// skills + store_and_render path), which also runs in background work-item execution:
// these tools need the user's token, and deepagents leaves a `{{user_jwt}}` server out
// when there is none (todolist polling), so they exist only where a person is present
// (chat, an open editor). Every tool takes and returns
// Supabase Storage URLs, works as the calling user (their token, storage policies
// apply) and runs IeumOffice's own command layer (packages/cli `runJson`) in this
// process — the CLI's tools are reused, only the file transport is ours.
//
//   POST /office/mcp   Streamable HTTP (stateless, JSON responses), Authorization: Bearer <user token>
//
// Tools: office_guide, office_read_document, office_apply_ops, office_convert,
// and the live ones (live.mjs) that edit a document the calling user has open, in front of them:
// office_live_documents, office_live_read, office_live_write, office_live_replace, office_live_apply_ops,
// office_live_save.
// HWP/HWPX: read only here (the engines have no headless HWP writer); they are
// edited in the browser editor.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createContext, disposeContext, runJson } from '@ieum/packages/cli/src/mcp/run'
import { bearerOf, verifyToken } from './auth.mjs'
import { announce, runLive, sessionFor, sessionsOf } from './live.mjs'
import {
  CONTENT_TYPES, editedObjectPath, hostDataRoot, isAllowedSource, newDocumentObject, safeName, storageAuth,
  storageObjectOf, uploadToStorage,
} from './documents.mjs'

const PUBLIC_URL = (process.env.IEUM_PUBLIC_URL || `http://localhost:${process.env.IEUM_HOST_PORT || 5390}`).replace(/\/$/, '')
const EDITOR_BY_EXT = { docx: 'docs', odt: 'docs', xlsx: 'sheets', pptx: 'slides', pdf: 'pdf', md: 'markdown', html: 'html', hwp: 'hwp', hwpx: 'hwp' }
const MAX_TEXT = 60_000

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] })
const failure = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })
const extOf = (name) => extname(String(name).split('?')[0]).slice(1).toLowerCase()
const editorUrl = (fileUrl, name) => {
  const editor = EDITOR_BY_EXT[extOf(name || fileUrl)]
  return editor ? `${PUBLIC_URL}/office/${editor}/?src=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(name || '')}` : null
}
const report = (ok) => ({ status: ok.status, summary: ok.summary, warnings: ok.warnings, detail: ok.detail })

// ops are an array of objects; agents sometimes send that array as a JSON string
const OPS = z
  .union([z.array(z.record(z.string(), z.any())), z.string()])
  .describe('형식별 연산 객체의 배열(office_guide 참고), 예: [{"op":"findReplace","find":"…","replace":"…"}]')
/**
 * conversions the CLI runs in this process. Its other routes (anything to pdf, docx→html,
 * html→docx) go through the desktop app's hidden export window, which a server does not
 * have — they would hang, so they are refused up front.
 */
const CONVERSIONS = {
  pdf: ['docx', 'pptx', 'xlsx', 'md', 'epub'],
  csv: ['xlsx'],
  xls: ['xlsx'],
  xlsb: ['xlsx'],
  ods: ['xlsx'],
  md: ['docx', 'html', 'odt'],
  markdown: ['docx', 'html', 'odt'],
  docx: ['md', 'odt'],
  odt: ['docx', 'md'],
  xlsx: ['csv'],
  xlsm: ['csv'],
}
const conversionList = Object.entries(CONVERSIONS)
  .filter(([from]) => from !== 'markdown')
  .map(([from, to]) => `${from}→${to.join('·')}`)
  .join(', ')

function opsList(ops) {
  let list = ops
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      throw new Error('ops 는 연산 객체의 배열(JSON)이어야 합니다')
    }
  }
  if (!Array.isArray(list) || !list.length) throw new Error('ops 는 비어 있지 않은 연산 객체의 배열이어야 합니다')
  return list
}

/**
 * what a tool says about a document it wrote (an edited copy, a conversion). process-gpt's
 * chat opens a docx result that carries html_url (and a .docx file_name / content_type) in
 * its document panel, and the panel opens file_url in the editor.
 */
const documentResult = (fileUrl, name, ok) => {
  const ext = extOf(name)
  const editor = editorUrl(fileUrl, name)
  return {
    file_url: fileUrl, file_name: name, content_type: CONTENT_TYPES[ext], editor_url: editor,
    ...(ext === 'docx' ? { html_url: editor } : {}),
    ...report(ok),
  }
}

/** one scratch directory per tool call; the CLI's file rules are confined to it */
async function inScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ieum-worker-'))
  const ctx = createContext({
    cwd: dir,
    scratchDir: dir,
    log: () => {},
    env: { ...process.env, GENOFFICE_ALLOWED_ROOTS: dir, GENOFFICE_AUTH_DIR: join(hostDataRoot, 'cli') },
  })
  try {
    return await fn(ctx, dir)
  } finally {
    disposeContext(ctx)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function download(url, dir) {
  if (!isAllowedSource(url)) throw new Error(`이 주소의 문서는 받을 수 없습니다: ${new URL(url).origin}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`문서를 내려받지 못했습니다 (HTTP ${res.status})`)
  const name = safeName(decodeURIComponent(new URL(url).pathname.split('/').pop() || 'document'))
  const path = join(dir, name)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  return { path, name, ext: extOf(name) }
}

async function run(ctx, argv) {
  const outcome = await runJson(argv, ctx)
  if (outcome.error) throw new Error(`${outcome.error.error}: ${outcome.error.message}`)
  return outcome.ok
}

function buildServer(userToken, claims) {
  const auth = storageAuth(userToken)
  const publish = async (object, path, bytes, ext) => {
    if (!auth) throw new Error('저장소에 올릴 권한이 없습니다(로그인 토큰 또는 서비스 키가 필요합니다)')
    return uploadToStorage(object, path, bytes, CONTENT_TYPES[ext] || 'application/octet-stream', auth)
  }
  const server = new McpServer(
    { name: 'process-gpt-office', version: '1.0.0' },
    {
      instructions: [
        '이미 있는 문서 파일(docx·xlsx·pptx·pdf, 한글은 읽기만)을 원본 형식 그대로 읽고 고치는 도구다. 새 문서는 만들지 않는다(문서 생성은 office-mcp 가 맡는다).',
        '고치기 전에 office_read_document 로 읽고, office_guide 로 그 형식의 연산(op) 설명을 본 뒤 office_apply_ops 를 부른다.',
        '모든 도구는 Supabase Storage 의 파일 주소(file_url)를 받고 돌려준다. 고친 문서는 원본을 두고 옆에 edited-… 로 따로 올린다.',
        '결과의 editor_url 은 사람이 편집기에서 여는 주소다(업무 화면이 로그인 토큰을 붙인다).',
      ].join('\n'),
    },
  )

  server.registerTool(
    'office_guide',
    {
      description: '형식별 편집 연산(op) 설명서를 돌려준다. office_apply_ops·office_live_apply_ops 의 ops 를 쓰기 전에 읽는다.',
      inputSchema: { format: z.enum(['docx', 'xlsx', 'pptx']) },
      annotations: { readOnlyHint: true },
    },
    async ({ format }) =>
      inScratch(async (ctx) => {
        const ok = await run(ctx, ['guide', { docx: 'docs', xlsx: 'sheets', pptx: 'slides' }[format]])
        return text(String(ok.detail?.text ?? ok.summary ?? '').slice(0, MAX_TEXT) || ok)
      }),
  )

  server.registerTool(
    'office_read_document',
    {
      description: '문서의 내용을 읽는다(docx·xlsx·pptx·pdf·hwp·hwpx·md·html). docx 는 range 로 블록 범위(예: "0-30")를 줄 수 있다.',
      inputSchema: { file_url: z.string(), range: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ file_url, range }) =>
      inScratch(async (ctx, dir) => {
        const doc = await download(file_url, dir)
        const argv = {
          docx: ['docs', 'read', doc.path, ...(range ? ['--range', range] : [])],
          odt: ['docs', 'read', doc.path, ...(range ? ['--range', range] : [])],
          xlsx: ['sheet', 'read', doc.path],
          pptx: ['slides', 'read', doc.path],
          pdf: ['pdf', 'read', doc.path],
          hwp: ['hwp', 'read', doc.path, '--full'],
          hwpx: ['hwp', 'read', doc.path, '--full'],
        }[doc.ext]
        if (!argv) return text(readFileSync(doc.path, 'utf8').slice(0, MAX_TEXT))
        const ok = await run(ctx, argv)
        return text(JSON.stringify(report(ok)).slice(0, MAX_TEXT))
      }),
  )

  server.registerTool(
    'office_apply_ops',
    {
      description:
        '문서를 연산(ops)으로 고친다(docx·xlsx·pptx). 원본은 그대로 두고 고친 문서를 원본 옆에 edited-… 로 올려 그 file_url 을 돌려준다. 거절된 연산은 번호와 이유가 결과에 온다.',
      inputSchema: { file_url: z.string(), ops: OPS },
    },
    async ({ file_url, ops }) =>
      inScratch(async (ctx, dir) => {
        const doc = await download(file_url, dir)
        const verb = { docx: 'docs', odt: 'docs', xlsx: 'sheet', pptx: 'slides' }[doc.ext]
        if (!verb) return failure(`이 형식은 연산으로 고칠 수 없습니다: .${doc.ext}${doc.ext.startsWith('hwp') ? ' (한글 문서는 편집기에서 고칩니다)' : ''}`)
        writeFileSync(join(dir, 'ops.json'), JSON.stringify(opsList(ops)))
        const out = join(dir, `edited.${doc.ext}`)
        const ok = await run(ctx, [verb, 'apply', doc.path, '--ops', join(dir, 'ops.json'), '--out', out])
        const source = storageObjectOf(file_url)
        const object = source ?? newDocumentObject(doc.ext)
        const path = source ? editedObjectPath(source.path, doc.ext) : object.path
        const fileUrl = await publish(object, path, readFileSync(out), doc.ext)
        return text(documentResult(fileUrl, doc.name, ok))
      }),
  )

  server.registerTool(
    'office_convert',
    {
      description: `문서를 다른 형식으로 바꿔 올린다. 되는 것: ${conversionList}. PDF로 내보내기는 아직 되지 않는다. 결과: file_url.`,
      inputSchema: { file_url: z.string(), to: z.string().describe('대상 형식 확장자') },
    },
    async ({ file_url, to }) =>
      inScratch(async (ctx, dir) => {
        const ext = to.replace(/^\./, '').toLowerCase()
        const from = extOf(file_url)
        if (!CONVERSIONS[from]?.includes(ext)) {
          return failure(`${from || '이 형식'} → ${ext} 변환은 서버에서 하지 않습니다. 되는 것: ${conversionList}`)
        }
        const doc = await download(file_url, dir)
        const out = join(dir, `converted.${ext}`)
        const ok = await run(ctx, ['convert', doc.path, '--to', ext, '--out', out])
        const object = newDocumentObject(ext)
        const fileUrl = await publish(object, object.path, readFileSync(out), ext)
        const name = doc.name.replace(/\.[^.]+$/, `.${ext}`)
        return text(documentResult(fileUrl, name, ok))
      }),
  )
  registerLiveTools(server, claims)
  return server
}

/** tools on the documents the calling user has open right now (the edits show up in their editor) */
function registerLiveTools(server, claims) {
  const live = async (sessionId, fn) => {
    try {
      return text(await fn(sessionFor(claims.sub, sessionId)))
    } catch (err) {
      return failure(String(err?.message || err))
    }
  }
  const words = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

  server.registerTool(
    'office_live_documents',
    {
      description: '이 사용자가 지금 편집기에 열어 둔 문서 목록. 여기 나온 문서는 office_live_* 도구로 사람이 보는 앞에서 고칠 수 있다(워드·엑셀).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text({ documents: sessionsOf(claims.sub) }),
  )

  server.registerTool(
    'office_live_read',
    {
      description: '열린 문서의 지금 내용(저장 전 편집 포함). 워드는 블록 번호가 붙은 본문, 엑셀은 시트 요약(addresses 를 주면 그 셀 값).',
      inputSchema: { session_id: z.string(), addresses: z.array(z.string()).optional(), sheet: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, addresses, sheet }) =>
      live(session_id, (c) =>
        c.editorName === 'sheets' ? runLive(c, 'read_sheet', { addresses, sheet }) : runLive(c, 'read_document', {}),
      ),
  )

  server.registerTool(
    'office_live_write',
    {
      description:
        '열린 워드 문서에 내용을 넣는다(사람이 보는 화면에 바로 나타난다). html 은 제한된 HTML(p·h1~h3·ul/ol/li·table·strong·em). after_block_index 를 주면 그 블록 뒤에, 없으면 끝에 넣는다.',
      inputSchema: { session_id: z.string(), html: z.string(), after_block_index: z.number().int().optional() },
    },
    async ({ session_id, html, after_block_index }) =>
      live(session_id, async (c) => {
        if (c.editorName !== 'docs') throw new Error('office_live_write 는 워드 문서에만 쓴다')
        announce(c, { action: 'write', text: words(html) })
        // without a position the editor inserts at its caret (often the top): default to the end
        let afterBlockIndex = after_block_index
        if (afterBlockIndex === undefined) {
          const { text: outline } = await runLive(c, 'read_document', {})
          const count = Number((/has (\d+) blocks?/.exec(outline) || [])[1])
          afterBlockIndex = Number.isInteger(count) && count > 0 ? count - 1 : -1
        }
        return runLive(c, 'insert_content', { html, afterBlockIndex })
      }),
  )

  server.registerTool(
    'office_live_replace',
    {
      description:
        '열린 워드 문서의 블록을 html 로 바꾼다. match_text 를 주면 그 글이 든 첫 블록을 바꾼다(예: "(작성 예정)" 같은 자리 표시를 채울 때 — 번호가 밀려도 틀리지 않는다). 번호로 바꿀 때는 start~end(office_live_read 의 번호)를 주고, 바꾸면 뒤 블록 번호가 달라지므로 여러 곳은 뒤에서부터 바꾸거나 바꿀 때마다 다시 읽는다.',
      inputSchema: {
        session_id: z.string(),
        html: z.string(),
        match_text: z.string().optional().describe('바꿀 블록에 든 글(그 글이 든 첫 블록)'),
        start_block_index: z.number().int().optional(),
        end_block_index: z.number().int().optional(),
      },
    },
    async ({ session_id, html, match_text, start_block_index, end_block_index }) =>
      live(session_id, async (c) => {
        if (c.editorName !== 'docs') throw new Error('office_live_replace 는 워드 문서에만 쓴다')
        let start = start_block_index
        let end = end_block_index ?? start_block_index
        if (match_text) {
          // the outline lists one block per line as "index|type|preview"
          const { text: outline } = await runLive(c, 'read_document', {})
          const hit = String(outline)
            .split('\n')
            .map((line) => /^(\d+)\|[^|]*\|(.*)$/.exec(line))
            .find((m) => m && m[2].includes(match_text))
          if (!hit) throw new Error(`"${match_text}" 이 든 블록이 없습니다(office_live_read 로 지금 내용을 확인하세요)`)
          start = end = Number(hit[1])
        }
        if (!Number.isInteger(start)) throw new Error('match_text 나 start_block_index 중 하나를 주세요')
        announce(c, { action: 'replace', text: words(html) })
        return runLive(c, 'replace_blocks', { startBlockIndex: start, endBlockIndex: end, html })
      }),
  )

  server.registerTool(
    'office_live_apply_ops',
    {
      description: '열린 문서에 편집 연산을 적용한다(워드 apply_ops, 엑셀 시트 연산). 연산 형식은 office_guide 참고.',
      inputSchema: { session_id: z.string(), ops: OPS },
    },
    async ({ session_id, ops }) =>
      live(session_id, async (c) => {
        const list = opsList(ops)
        announce(c, { action: 'ops', text: `편집 ${list.length}건` })
        return runLive(c, 'apply_ops', { ops: list })
      }),
  )

  server.registerTool(
    'office_live_save',
    {
      description: '열린 문서를 저장한다. 원본은 두고 편집본이 저장소에 올라가며, 그 file_url 을 돌려준다(업무 화면의 첨부도 편집본으로 바뀐다).',
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) =>
      live(session_id, async (c) => {
        if (c.readOnly) throw new Error('미리보기로 연 문서는 저장하지 않는다')
        const published = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 15_000)
          c.once('office-published', (url) => {
            clearTimeout(t)
            resolve(url)
          })
        })
        const command = c.editorName === 'sheets' ? 'save_sheet' : 'save_document'
        await runLive(c, command, { path: c.documentPath, overwrite: true })
        announce(c, { action: 'save', text: '저장' })
        return { saved: true, file_url: await published }
      }),
  )
}

/** POST /office/mcp */
export async function handleWorkerMcp(req, res) {
  const token = bearerOf(req)
  let claims
  try {
    claims = verifyToken(token)
  } catch (err) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `unauthorized: ${err.message}` }, id: null }))
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
  const server = buildServer(token, claims)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
