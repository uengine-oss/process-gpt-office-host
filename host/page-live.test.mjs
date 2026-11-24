// The selection the page tells a framing page (page-live.mjs docsSelection): where it is, as the 워드 editor's table ops count it.
// Built on the editor's own ProseMirror packages (the fork's node_modules), with nodes named as the editor names them.
//   node --test host/page-live.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { docsSelection, tableGrid } from './page-live.mjs'

const cellSpec = (role) => ({ content: 'docParagraph+', tableRole: role, isolating: true, attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } })
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: {},
    docParagraph: { group: 'block', content: 'text*' },
    docTable: { group: 'block', content: 'docTableRow+', tableRole: 'table', isolating: true },
    docTableRow: { content: '(docTableCell | docTableHeader)+', tableRole: 'row' },
    docTableCell: cellSpec('cell'),
    docTableHeader: cellSpec('header_cell'),
  },
})
const p = (t) => schema.node('docParagraph', null, t ? [schema.text(t)] : [])
const td = (t, attrs) => schema.node('docTableCell', attrs || null, [p(t)])
const tr = (...cells) => schema.node('docTableRow', null, cells)
// 회의록: a heading-like line, a line, the table (참석자 spans two columns in the second row), a closing line
const doc = schema.node('doc', null, [
  p('주간 회의록'), p('작성: 한서윤'),
  schema.node('docTable', null, [tr(td('일시'), td('2026-11-25'), td('10:00')), tr(td('참석자'), td('대표, 개발팀, 운영팀, 영업팀', { colspan: 2 })), tr(td('안건'), td('출시'), td('점검'))]),
  p('끝'),
])
const editorWith = (selection) => ({ state: EditorState.create({ doc, selection }) })
const posOf = (text) => { let at = -1; doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes(text)) at = pos + n.text.indexOf(text) }); return at }

test('tableGrid: merged cells take the columns they cover, as the table ops count them (0-based)', () => {
  const grid = [...tableGrid(doc.child(2)).values()].map(({ row, col, rowEnd, colEnd }) => [row, col, rowEnd, colEnd])
  assert.deepEqual(grid, [[0, 0, 0, 0], [0, 1, 0, 1], [0, 2, 0, 2], [1, 0, 1, 0], [1, 1, 1, 2], [2, 0, 2, 0], [2, 1, 2, 1], [2, 2, 2, 2]])
})

test('docsSelection: words in a merged cell → 표 1 · 2행 2~3열, block 2, the grid range', () => {
  const from = posOf('대표')
  const s = docsSelection(editorWith(TextSelection.create(doc, from, from + '대표, 개발팀, 운영팀, 영업팀'.length)))
  assert.equal(s.kind, 'table')
  assert.equal(s.text, '대표, 개발팀, 운영팀, 영업팀')
  assert.equal(s.label, '표 1 · 2행 2~3열')
  assert.deepEqual([s.blockIndex, s.table, s.range], [2, 1, { row: 1, col: 1, rowEnd: 1, colEnd: 2 }])
  assert.deepEqual([s.from, s.to], [from, from + '대표, 개발팀, 운영팀, 영업팀'.length])
})

test('docsSelection: a cell selection is its cells (not what lies between them)', () => {
  // the first column, rows 1–3: 일시 · 참석자 · 안건
  let a = -1, b = -1
  doc.descendants((n, pos) => { if (n.type.name === 'docTableCell' && n.textContent === '일시') a = pos; if (n.type.name === 'docTableCell' && n.textContent === '안건') b = pos })
  const s = docsSelection(editorWith(CellSelection.create(doc, a, b)))
  assert.equal(s.kind, 'table')
  assert.equal(s.text, '일시 참석자 안건')
  assert.deepEqual(s.range, { row: 0, col: 0, rowEnd: 2, colEnd: 0 })
  assert.equal(s.label, '표 1 · 1~3행 1열')
})

test('docsSelection: words of a paragraph, of two paragraphs, nothing selected', () => {
  const from = posOf('한서윤')
  const one = docsSelection(editorWith(TextSelection.create(doc, from, from + 3)))
  assert.deepEqual([one.kind, one.label, one.text, one.blockIndex], ['text', '문단', '한서윤', 1])
  const two = docsSelection(editorWith(TextSelection.create(doc, posOf('회의록'), from + 3)))
  assert.deepEqual([two.kind, two.label, two.blockIndex, two.blockEnd], ['text', '문단 2개', 0, 1])
  assert.equal(docsSelection(editorWith(TextSelection.create(doc, from, from))), null)
  assert.equal(docsSelection(null), null)
})
