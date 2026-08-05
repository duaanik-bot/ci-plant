import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildBoardVerificationSpec, boardSpecLine, clientShort, verificationText,
  VERIF_LABEL, CUT_LABEL, sizeOf, STOCK_TONE, VERIF_TONE_KEY, CUT_TONE_KEY,
} from '../../client/src/lib/boardVerificationExport.js';
import { PDF_TONE } from '../../client/src/lib/exporter.js';

const BOARD_FULL = {
  covered: 'Stock OK',
  on_order: 'PR Raised — Stock Pending',
  short: 'Stock Short — No PR Raised',
};

const job = (over = {}) => ({
  order_line_id: 1, customer_name: 'Swiss Garnier Life Sciences',
  po_number: 'PMP/01438', po_date: '2026-07-05',
  jc_number: 'CI-JC-0057', jc_created_at: '2026-08-04',
  product_name: 'NICODUCE OD 10 TABLETS(NEW) PTD MONOCARTON SALE-: AT21058',
  product_code: 'SW-423', party_artwork_code: 'AT21058',
  order_qty: 40000, planned_qty: 40000, need: 1669, open_need: 1669,
  cutting_status: 'planned', planned_date: '2026-08-04', delivery_date: null,
  pr_covered: false, line_notes: null, gang_number: null, ...over,
});

const board = (over = {}) => ({
  material_id: 7, board_name: 'FBB · 280 GSM · 20x38', grade: 'FBB', gsm: 280,
  sheet_l: 20, sheet_w: 38, sheets_per_packet: 144,
  available: 5100, committed: 4784, required: 4784, job_count: 1,
  shortage: 0, uncovered: 0, pr_pending_qty: 0, po_pending_qty: 0,
  stock_state: 'covered', verification_status: 'pending', verification: null,
  verification_stale: false, prs: [], pos: [], jobs: [job()], ...over,
});

const spec = (boards = [board()], extra = {}) =>
  buildBoardVerificationSpec({ boards, totalBoards: boards.length, records: [], boardFull: BOARD_FULL, ...extra });

const section = (s, heading) => s.sections.find(x => x.heading === heading);
const pdfCols = (s, heading) => section(s, heading).pdfColumns || section(s, heading).columns;
const cell = (s, heading, key, row) => pdfCols(s, heading).find(c => c.key === key).export(row);

// ── The failure this file exists to prevent ─────────────────────────────────

test('the printed product table stays narrow enough for a word to fit', () => {
  const cols = pdfCols(spec(), 'Board-wise Product Details');
  assert.ok(cols.length <= 9, `printed product columns must stay under ten, got ${cols.length}`);
  // Landscape A4 minus margins and the serial column ≈ 260mm. Every column
  // must clear the width of its own uppercased heading, or jsPDF breaks the
  // HEADING one letter per line — the exact defect reported from the plant.
  const usable = 297 - 2 * 14 - 9;
  const total = cols.reduce((n, c) => n + c.pdfWeight, 0);
  for (const c of cols) {
    const mm = usable * c.pdfWeight / total;
    // ~1.55mm per uppercase character at 6.7pt Helvetica bold, plus padding.
    const longestWord = Math.max(...c.label.toUpperCase().split(' ').map(w => w.length));
    assert.ok(mm >= longestWord * 1.55 + 3.2,
      `"${c.label}" gets ${mm.toFixed(1)}mm — too narrow for its own heading`);
  }
});

test('every printed column declares a weight, or autoTable starves it again', () => {
  for (const s of spec().sections) {
    for (const c of (s.pdfColumns || s.columns)) {
      assert.ok(+c.pdfWeight > 0, `${s.heading} → "${c.label}" has no pdfWeight`);
    }
  }
});

test('the workbook keeps every fact the page had to drop', () => {
  const s = spec();
  const xlsx = section(s, 'Board-wise Product Details').columns.map(c => c.key);
  for (const key of ['party_artwork_code', 'product_code', 'planned_qty', 'open_need',
    'delivery_date', 'line_notes', 'customer_name', 'pr_status']) {
    assert.ok(xlsx.includes(key), `Excel must still carry ${key}`);
  }
  // …and the client's full name, not the initials the page prints.
  assert.equal(
    section(s, 'Board-wise Product Details').columns.find(c => c.key === 'customer_name').export(job()),
    'Swiss Garnier Life Sciences');
});

// ── Stacked cells ───────────────────────────────────────────────────────────

test('a stacked cell uses real newlines — the sanitizer keeps them', () => {
  const v = cell(spec(), 'Board-wise Product Details', 'product_name', job());
  assert.ok(v.includes('\n'), 'product cell must stack name over codes');
  assert.equal(v.split('\n').length, 2);
  assert.ok(v.startsWith('NICODUCE'), 'the name leads');
  assert.ok(v.endsWith('SW-423 · AT21058'), 'codes sit under it');
});

test('the client prints as initials, and an unknown name still prints something', () => {
  assert.equal(clientShort('Swiss Garnier Life Sciences'), 'SGLS');
  assert.equal(clientShort('Herboveda'), 'HERB');
  assert.equal(clientShort(''), '—');
});

test('missing dates add no line rather than a line reading "—"', () => {
  const v = cell(spec(), 'Board-wise Product Details', 'jc_number', job({ jc_number: null }));
  assert.equal(v, 'Not created');
  const so = cell(spec(), 'Board-wise Product Details', 'po_number', job({ po_date: null }));
  assert.equal(so, 'PMP/01438', 'no trailing blank line');
});

test('dispatch rides in the cutting cell only when the line has one', () => {
  const without = cell(spec(), 'Board-wise Product Details', 'cutting_status', job());
  assert.equal(without.split('\n').length, 2, 'status + planned date only');
  const withDisp = cell(spec(), 'Board-wise Product Details', 'cutting_status',
    job({ delivery_date: '2026-08-12' }));
  assert.match(withDisp, /disp 12 Aug 2026/);
});

test('the PR flag rides on the buy line, never its own column', () => {
  const cols = pdfCols(spec(), 'Board-wise Product Details').map(c => c.key);
  assert.ok(!cols.includes('dispatch_pr'), 'no column that is blank on live data');
  const v = cell(spec(), 'Board-wise Product Details', 'need', job({ pr_covered: true }));
  assert.match(v, /buy 1,669 · PR/);
  const covered = cell(spec(), 'Board-wise Product Details', 'need', job({ open_need: 0 }));
  assert.equal(covered, '1,669', 'a covered job says nothing extra');
});

// ── boardSpecLine: the duplicate that printed every board twice ─────────────

test('boardSpecLine says nothing when the name already carries the spec', () => {
  assert.equal(boardSpecLine({ board_name: 'FBB · 280 GSM · 20x38', grade: 'FBB', gsm: 280, sheet_l: 20, sheet_w: 38 }), '');
});

test('boardSpecLine survives the x/× spelling difference — the bug that defeated it', () => {
  // The NAME writes 25x36 with a letter; sizeOf writes 25×36 with the
  // multiplication sign. Stripping punctuation alone kept one and dropped the
  // other, so nothing ever matched and every board printed its spec twice.
  assert.equal(boardSpecLine({ board_name: 'Duplex GB · 296 GSM · 25x36', grade: 'Duplex GB', gsm: 296, sheet_l: 25, sheet_w: 36 }), '');
});

test('boardSpecLine still speaks up for a board whose name says nothing', () => {
  const v = boardSpecLine({ board_name: 'Unspecified board', grade: null, gsm: 300, sheet_l: 25, sheet_w: 36 });
  assert.equal(v, '300 GSM · 25×36"');
});

test('boardSpecLine is silent when there is no spec at all', () => {
  assert.equal(boardSpecLine({ board_name: 'Unspecified board' }), '');
});

// ── Shape ───────────────────────────────────────────────────────────────────

test('the five worksheets are all present and named', () => {
  const s = spec();
  assert.deepEqual(s.sections.map(x => x.heading), [
    'Board Verification Summary',
    'Board-wise Product Details',
    'Stock Shortage Report',
    'Pending PR and PO Report',
    'Physical Verification Records',
  ]);
  assert.equal(s.sheetPerSection, true);
  assert.equal(s.orientation, 'landscape');
});

test('the shortage sheet carries only boards that are short', () => {
  const s = spec([board(), board({ material_id: 8, shortage: 400, uncovered: 400 })]);
  assert.equal(section(s, 'Stock Shortage Report').rows.length, 1);
});

test('the shortage cell never prints the same figure twice', () => {
  const all = cell(spec([board({ shortage: 6729, uncovered: 6729 })]), 'Board Verification Summary', 'shortage',
    board({ shortage: 6729, uncovered: 6729 }));
  assert.deepEqual(all.split('\n'), ['6,729', 'none on order']);
  const part = cell(spec(), 'Board Verification Summary', 'shortage', board({ shortage: 400, uncovered: 250 }));
  assert.deepEqual(part.split('\n'), ['400', '250 uncovered']);
  const covered = cell(spec(), 'Board Verification Summary', 'shortage', board({ shortage: 400, uncovered: 0 }));
  assert.deepEqual(covered.split('\n'), ['400', 'on order']);
});

test('a job row carries its board through so the PDF can name it', () => {
  const s = spec();
  const row = section(s, 'Board-wise Product Details').rows[0];
  assert.equal(row._board.board_name, 'FBB · 280 GSM · 20x38');
});

test('verification text names the state, the count and the counter', () => {
  assert.equal(verificationText(board()), VERIF_LABEL.pending);
  const v = verificationText(board({
    verification_status: 'mismatch',
    verification: { status: 'mismatch', physical_qty: 450, verified_by: 'Storekeeper', created_at: '2026-08-05T06:00:00Z' },
    verification_stale: true,
  }));
  assert.match(v, /Quantity Mismatch · counted 450 · Storekeeper/);
  assert.match(v, /STALE/);
});

test('vocabulary covers every status the server can send', () => {
  for (const k of ['pending', 'verified', 'mismatch', 'not_found', 'partial']) assert.ok(VERIF_LABEL[k]);
  for (const k of ['not_sent', 'waiting', 'planned', 'started']) assert.ok(CUT_LABEL[k]);
  assert.equal(sizeOf({ sheet_l: 20, sheet_w: 38 }), '20×38"');
  assert.equal(sizeOf({}), '—');
});

// ── Source guards ───────────────────────────────────────────────────────────

test('the page imports the vocabulary rather than re-declaring it', () => {
  const src = readFileSync(new URL('../../client/src/pages/BoardStockVerification.jsx', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/lib\/boardVerificationExport\.js'/);
  assert.doesNotMatch(src, /^const VERIF_LABEL = \{/m, 'a second copy of the verification words');
  assert.doesNotMatch(src, /^const CUT_LABEL = \{/m, 'a second copy of the cutting words');
  assert.match(src, /buildBoardVerificationSpec\(\{/, 'the page must build its export from the shared spec');
  assert.match(src, /boardFull: BOARD_FULL/, 'the real board vocabulary must be injected');
});

test('the exporter keeps newlines and refuses to slice a row across a page', () => {
  const src = readFileSync(new URL('../../client/src/lib/exporter.js', import.meta.url), 'utf8');
  assert.match(src, /\[\^\\x20-\\x7E\\n/, 'the WinAnsi strip must whitelist \\n or stacked cells glue together');
  assert.match(src, /rowPageBreak: 'avoid'/);
  assert.match(src, /overflow: 'linebreak'/);
  assert.match(src, /pdfWeight/, 'the width engine must still be wired');
});

// ── Grouping: the board is said once, in a band, not on every row ───────────

test('the product section groups by board and drops the repeated Board column', () => {
  const s = spec();
  const sec = section(s, 'Board-wise Product Details');
  assert.ok(sec.pdfGroup, 'the printed product table must be grouped');
  assert.equal(sec.pdfGroup.by(sec.rows[0]), 7, 'grouped on the board id');
  const printed = sec.pdfColumns.map(c => c.key);
  assert.ok(!printed.includes('board'),
    'the board is the band — a Board column would print it on every row again');
  // …but Excel keeps it, because a flat sheet needs the key on every row.
  assert.ok(sec.columns.map(c => c.key).includes('board'));
});

test('the band names the board, its job count and what must be found', () => {
  const sec = section(spec(), 'Board-wise Product Details');
  const label = sec.pdfGroup.label(sec.rows);
  assert.match(label, /FBB · 280 GSM · 20x38/);
  assert.match(label, /1 job\b/);
  assert.match(label, /1,669 sheets to verify/);
  assert.match(label, /5,100 in warehouse/);
  // The spec is not repeated inside the band either.
  assert.doesNotMatch(label.replace('FBB · 280 GSM · 20x38', ''), /280 GSM/);
});

test('the band carries the verdict, and it never disagrees with the summary', () => {
  const sec = section(spec(), 'Board-wise Product Details');
  assert.equal(sec.pdfGroup.status(sec.rows), 'STOCK OK');
  const shortSec = section(spec([board({ shortage: 400, uncovered: 400, stock_state: 'short' })]), 'Board-wise Product Details');
  assert.equal(shortSec.pdfGroup.status(shortSec.rows), 'SHORT 400 · 400 UNCOVERED');
  const onOrder = section(spec([board({ shortage: 400, uncovered: 0, stock_state: 'on_order' })]), 'Board-wise Product Details');
  assert.equal(onOrder.pdfGroup.status(onOrder.rows), 'SHORT 400 · ON ORDER');
});

test('a page that opens mid-group can still name its board', () => {
  const sec = section(spec(), 'Board-wise Product Details');
  assert.equal(sec.pdfGroup.shortLabel(sec.rows), 'FBB · 280 GSM · 20x38',
    'the continuation header needs the name without the counts');
});

test('two boards make two groups, one board one group', () => {
  const sec = section(spec([board(), board({ material_id: 8, board_name: 'Saffire · 300 GSM · 23x36' })]), 'Board-wise Product Details');
  const keys = [...new Set(sec.rows.map(r => sec.pdfGroup.by(r)))];
  assert.deepEqual(keys, [7, 8]);
});

// ── Significance: colour must mean something, and never be the only signal ──

test('both troubled states are red and DEPTH separates them, as on screen', () => {
  assert.equal(STOCK_TONE.covered, 'ok');
  assert.equal(STOCK_TONE.on_order, 'alert', 'someone has acted — soft');
  assert.equal(STOCK_TONE.short, 'alarm', 'nobody has acted — hard');
  assert.ok(PDF_TONE.alert.rail[0] > 200 && PDF_TONE.alarm.rail[0] > 200, 'both reds');
  assert.ok(PDF_TONE.alarm.fill[1] < PDF_TONE.alert.fill[1], 'the hard tone is the deeper wash');
});

test('every tone a spec can name actually exists in the palette', () => {
  const used = new Set([
    ...Object.values(STOCK_TONE), ...Object.values(VERIF_TONE_KEY), ...Object.values(CUT_TONE_KEY),
  ]);
  for (const t of used) assert.ok(PDF_TONE[t], `unknown tone "${t}"`);
});

test('a toned cell still says the word — colour is never the only signal', () => {
  const s = spec([board({ stock_state: 'short', shortage: 400, uncovered: 400 })]);
  const b = board({ stock_state: 'short', shortage: 400, uncovered: 400 });
  const col = pdfCols(s, 'Board Verification Summary').find(c => c.key === 'stock_state');
  assert.equal(col.pdfTone(b), 'alarm');
  assert.equal(col.export(b), 'Stock Short — No PR Raised', 'the words carry it in mono');
});

test('the cutting column is toned by its own status', () => {
  const col = pdfCols(spec(), 'Board-wise Product Details').find(c => c.key === 'cutting_status');
  assert.equal(col.pdfTone(job({ cutting_status: 'planned' })), 'info');
  assert.equal(col.pdfTone(job({ cutting_status: 'waiting' })), 'warn');
  assert.equal(col.pdfTone(job({ cutting_status: 'not_sent' })), 'muted');
});

test('board needed is amber only while somebody still has to find board', () => {
  const col = pdfCols(spec(), 'Board-wise Product Details').find(c => c.key === 'need');
  assert.equal(col.pdfTone(job({ open_need: 1669, pr_covered: false })), 'warn');
  assert.equal(col.pdfTone(job({ open_need: 1669, pr_covered: true })), 'alert');
  assert.equal(col.pdfTone(job({ open_need: 0 })), null, 'a covered job is not coloured at all');
});

test('uncovered is GREEN at nil — the column exists to say the gap is bought', () => {
  const col = section(spec(), 'Stock Shortage Report').columns.find(c => c.key === 'uncovered');
  assert.equal(col.pdfTone({ uncovered: 0 }), 'ok');
  assert.equal(col.pdfTone({ uncovered: 250 }), 'alarm');
});

test('ungrouped sections carry a rail that means something', () => {
  const s = spec();
  assert.equal(section(s, 'Board Verification Summary').pdfRowTone(board({ stock_state: 'on_order' })), 'alert');
  assert.equal(section(s, 'Stock Shortage Report').pdfRowTone({ uncovered: 0 }), 'alert');
  assert.equal(section(s, 'Stock Shortage Report').pdfRowTone({ uncovered: 9 }), 'alarm');
  assert.equal(section(s, 'Physical Verification Records').pdfRowTone({ status: 'not_found' }), 'alarm');
});

test('Excel is never grouped — a band row would break its filters', () => {
  const src = readFileSync(new URL('../../client/src/lib/exporter.js', import.meta.url), 'utf8');
  const xlsx = src.slice(src.indexOf('export async function exportXLSX'));
  assert.doesNotMatch(xlsx, /pdfGroup/, 'grouping must not reach the workbook');
});

test('the exporter draws the rail and bands the groups', () => {
  const src = readFileSync(new URL('../../client/src/lib/exporter.js', import.meta.url), 'utf8');
  assert.match(src, /export const PDF_TONE/);
  assert.match(src, /didParseCell/);
  assert.match(src, /didDrawCell/);
  assert.match(src, /doc\.rect\(data\.cell\.x, data\.cell\.y, RAIL_W/, 'the rail is drawn, not declared');
  assert.match(src, /continued/, 'a page opening mid-group must name its group');
});
