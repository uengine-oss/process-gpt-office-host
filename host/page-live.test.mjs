// The selection the page tells a framing page (page-live.mjs docsSelection): where it is, as the 워드 editor's table ops count it.
// Built on the editor's own ProseMirror packages (the fork's node_modules), with nodes named as the editor names them.
// Also the 워드 live edits' cell alignment and read-back (planCellAlign · formatFacts): production 11-25, a centred cell whose
// paragraph's space after filled it showed no change.
//   node --test host/page-live.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { docsSelection, tableGrid, planCellAlign, formatFacts, opParagraphs, opTable, hexOfCss } from './page-live.mjs'

const cellSpec = (role) => ({ content: 'docParagraph+', tableRole: role, isolating: true,
  attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, vAlign: { default: null }, fill: { default: null }, borders: { default: null } } })
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: {},
    docParagraph: { group: 'block', content: 'text*', attrs: { align: { default: null }, spaceBefore: { default: null }, spaceAfter: { default: null } } },
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

// ---- textRanges: the selected cells, one position range per row (a cell selection's own from/to is one cell)
const cellPos = (text) => { let at = -1; doc.descendants((n, pos) => { if (at < 0 && n.type.name === 'docTableCell' && n.textContent === text) at = pos }); return at }
const paragraphsBetween = (from, to) => { const out = []; doc.nodesBetween(from, to, (n, pos) => { if (n.type.name !== 'docParagraph') return true; if (pos + n.nodeSize > from && pos < to) out.push(n.textContent); return false }); return out }

test('docsSelection: a cell selection over the whole table → textRanges reach every cell, one range per row', () => {
  const s = docsSelection(editorWith(CellSelection.create(doc, cellPos('일시'), cellPos('점검'))))
  assert.deepEqual(s.range, { row: 0, col: 0, rowEnd: 2, colEnd: 2 })
  // (the selection's own from/to: one cell — what the agent used in production and changed one paragraph of ten)
  assert.equal(paragraphsBetween(s.from, s.to).length, 1)
  assert.equal(s.textRanges.length, 3)
  assert.deepEqual(s.textRanges.map((r) => paragraphsBetween(r.from, r.to)), [['일시', '2026-11-25', '10:00'], ['참석자', '대표, 개발팀, 운영팀, 영업팀'], ['안건', '출시', '점검']])
})

test('docsSelection: a column of a table → textRanges reach those cells only (not the ones beside them)', () => {
  // (the merged cell of the second row widens the grid range; the selected cells are still these three)
  const s = docsSelection(editorWith(CellSelection.create(doc, cellPos('2026-11-25'), cellPos('출시'))))
  assert.deepEqual(s.range, { row: 0, col: 1, rowEnd: 2, colEnd: 2 })
  assert.deepEqual(s.textRanges.map((r) => paragraphsBetween(r.from, r.to)), [['2026-11-25'], ['대표, 개발팀, 운영팀, 영업팀'], ['출시']])
  const one = docsSelection(editorWith(CellSelection.create(doc, cellPos('일시'), cellPos('안건'))))
  assert.deepEqual(one.textRanges.map((r) => paragraphsBetween(r.from, r.to)), [['일시'], ['참석자'], ['안건']])
})

// ---- planCellAlign: the cell's edge spacing goes where the alignment puts the text, the total stays
// 회의록 like production's: a title, then label cells (shaded) whose paragraphs carry the document's default space after (200 twips)
const p2 = (t, attrs) => schema.node('docParagraph', attrs || null, t ? [schema.text(t)] : [])
const cell2 = (paras, attrs) => schema.node('docTableCell', attrs || null, paras)
const minutes = schema.node('doc', null, [
  p2('회의록'),
  schema.node('docTable', null, [
    tr(cell2([p2('회의명')], { fill: 'F2F4F7' }), cell2([p2('')]), cell2([p2('일시')], { fill: 'F2F4F7' }), cell2([p2('')])),
    tr(cell2([p2('장소/방식')], { fill: 'F2F4F7' }), cell2([p2('')]), cell2([p2('작성자')], { fill: 'F2F4F7' }), cell2([p2('')])),
    tr(cell2([p2('참석자')], { fill: 'F2F4F7' }), cell2([p2('')], { colspan: 3 })),
  ]),
  p2('1. 회의 목적 및 안건'),
])
const defaultSpacing = () => ({ before: 0, after: 200 })
const vAlign = (v, range) => ({ op: 'setTableCellFormat', target: { nodeType: 'table', blockIndexes: [1] }, ...(range ? { range } : {}), vAlign: v })
const reached = (d, op) => opParagraphs(d, op.target).map((x) => x.node.textContent || '·')

test('planCellAlign: centre → half of the space after goes before, every cell of the range, neighbours in one op', () => {
  const plan = planCellAlign(minutes, [vAlign('center', { row: 0, col: 0, rowEnd: 2, colEnd: 3 })], defaultSpacing)
  assert.equal(plan.cells, 10)
  assert.equal(plan.paragraphs, 10)
  assert.equal(plan.ops.length, 1)
  assert.deepEqual([plan.ops[0].op, plan.ops[0].target.blockIndexes, plan.ops[0].spaceBefore, plan.ops[0].spaceAfter], ['setParagraphFormat', [1], 100, 100])
  assert.deepEqual(reached(minutes, plan.ops[0]), ['회의명', '·', '일시', '·', '장소/방식', '·', '작성자', '·', '참석자', '·'])
  // the label column only: cells apart (other paragraphs between) take an op each
  const labels = planCellAlign(minutes, [vAlign('center', { row: 0, col: 0, rowEnd: 2, colEnd: 0 })], defaultSpacing)
  assert.deepEqual(labels.ops.map((op) => reached(minutes, op)), [['회의명'], ['장소/방식'], ['참석자']])
})

test('planCellAlign: top → all after, bottom → all before; only the range; nothing when the spacing is already there', () => {
  const bottom = planCellAlign(minutes, [vAlign('bottom', { row: 2, col: 0 })], defaultSpacing)
  assert.deepEqual(bottom.ops.map((op) => [reached(minutes, op), op.spaceBefore, op.spaceAfter]), [[['참석자'], 200, 0]])
  // top with the space already after: nothing to move (vAlign null is top too)
  assert.equal(planCellAlign(minutes, [vAlign('top', { row: 0, col: 0 })], defaultSpacing).ops.length, 0)
  assert.equal(planCellAlign(minutes, [vAlign(null, { row: 0, col: 0 })], defaultSpacing).ops.length, 0)
  // centred already (half and half), or no spacing at all
  assert.equal(planCellAlign(minutes, [vAlign('center')], () => ({ before: 100, after: 100 })).ops.length, 0)
  assert.equal(planCellAlign(minutes, [vAlign('center')], () => ({ before: 0, after: 0 })).ops.length, 0)
})

test('planCellAlign: a cell of two paragraphs moves the first one\'s space before and the last one\'s space after; other ops and tables untouched', () => {
  const d = schema.node('doc', null, [schema.node('docTable', null, [tr(cell2([p2('위'), p2('아래')]), cell2([p2('옆')]))])])
  const plan = planCellAlign(d, [vAlign('center', { row: 0, col: 0 }), { op: 'setFont', target: { blockIndexes: [0] }, bold: true }].map((op) => ({ ...op, target: { blockIndexes: [0] } })), () => ({ before: 0, after: 240 }))
  assert.deepEqual(plan.ops.map((op) => [reached(d, op), op.spaceBefore, op.spaceAfter]), [[['위'], 120, undefined], [['아래'], undefined, 120]])
  // a target that names no single table: nothing
  assert.equal(planCellAlign(minutes, [{ op: 'setTableCellFormat', target: { blockIndexes: [0] }, vAlign: 'center' }], defaultSpacing).ops.length, 0)
  assert.equal(opTable(minutes, { nodeType: 'table' }).n, 1)
})

// ---- formatFacts: what the document shows, per format op
test('formatFacts: cells with their vAlign · fill · borders and where their text sits; paragraphs with the requested fields', () => {
  const d = schema.node('doc', null, [
    p2('회의록'),
    schema.node('docTable', null, [
      tr(cell2([p2('회의명')], { fill: 'F2F4F7', vAlign: 'center' }), cell2([p2('')], { vAlign: 'center' }), cell2([p2('일시')], { fill: 'F2F4F7' })),
      tr(cell2([p2('참석자')], { fill: 'F2F4F7' }), cell2([p2('')], { colspan: 2 })),
    ]),
  ])
  const shown = {
    cell: (pos, node) => (node.textContent ? { verticalAlign: node.attrs.vAlign === 'center' ? 'middle' : 'top', background: node.attrs.fill, above: 0, below: 13.3, lines: 22 } : { verticalAlign: 'top', background: null }),
    paragraph: () => ({ textAlign: 'center', spaceBefore: 0, spaceAfter: 200 }),
  }
  const ops = [vAlign('center', { row: 0, col: 0, rowEnd: 0, colEnd: 1 }), { op: 'findReplace', find: 'a', replace: 'b' },
    { op: 'setParagraphFormat', target: { blockIndexes: [1], range: { from: 0, to: 9999 } }, align: 'center' },
    { op: 'setParagraphFormat', target: { scope: 'selection' }, align: 'center' }]
  const facts = formatFacts(d, ops, shown)
  // the format ops only; a target this page cannot resolve the same way (the live selection) gives no facts
  assert.deepEqual(facts.map((f) => [f.op, f.name]), [[0, 'setTableCellFormat'], [2, 'setParagraphFormat']])
  assert.equal(facts[0].table, 1)
  assert.deepEqual(facts[0].cells.map((c) => [c.row, c.col, c.text, c.vAlign, c.fill]), [[0, 0, '회의명', 'center', 'F2F4F7'], [0, 1, '', 'center', null]])
  assert.deepEqual(facts[0].cells[0].shown, { verticalAlign: 'middle', background: 'F2F4F7', above: 0, below: 13.3, lines: 22 })
  assert.equal(facts[2 - 1].paragraphs.length, 5)
  assert.deepEqual(facts[1].paragraphs[0], { text: '회의명', attrs: { align: null }, shown: { textAlign: 'center', spaceBefore: 0, spaceAfter: 200 } })
  // a table op whose target names no table: an entry with no cells (the caller says so)
  assert.deepEqual(formatFacts(d, [{ op: 'setTableCellFormat', target: { blockIndexes: [0] }, vAlign: 'center' }], shown), [{ op: 0, name: 'setTableCellFormat', cells: [] }])
})

test('hexOfCss: computed colours as the ops write them; transparent is none', () => {
  assert.equal(hexOfCss('rgb(242, 244, 247)'), 'F2F4F7')
  assert.equal(hexOfCss('rgba(0, 0, 0, 0)'), null)
  assert.equal(hexOfCss(''), null)
})
