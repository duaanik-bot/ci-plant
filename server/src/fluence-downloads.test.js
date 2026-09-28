// Every file the Fluence module hands out — a list as PDF or Excel, a kit's
// customer report, a printed page — goes on record first. For a customer's own
// login the record is an audit line plus a notice to CI management, and the
// file wears Colour Impressions: across every PDF page, behind every Excel
// sheet, in the print. A Colour Impressions login's file is made as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { downloadDetail } from './routes/fluence.js';
import { normalizeWatermark } from '../../client/src/lib/exporter.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

const WM = { text: 'COLOUR IMPRESSIONS', line: 'Colour Impressions copy · Downloaded by Fluence Pharma (ID fluence01) · 28 Sept 2026, 1:12 pm · Ref FD-9', ref: 'FD-9' };

test('the server records a customer\'s download before any file exists, and tells management in the same transaction', () => {
  const route = read('server/src/routes/fluence.js');
  const at = route.indexOf("r.post('/fluence/downloads'");
  assert.ok(at > 0, 'the route exists');
  const body = route.slice(at, route.indexOf('\n});', at));
  assert.match(body, /if \(!req\.user\?\.outside\) return res\.json\(\{ watermark: null \}\);/, 'staff: no watermark, no record');
  assert.match(body, /await tx\(async \(qc, oc\) => \{\s*const row = await oc\(`\s*INSERT INTO audit_log/);
  assert.match(body, /VALUES \('fluence_download', \$1, \$2, \$3, \$4\) RETURNING id, created_at/);
  assert.match(body, /const ref = `FD-\$\{row\.id\}`;\s*await tellManagementOfDownload\(req\.user, \{ what, detail: `\$\{detail\}\. Ref \$\{ref\}` \}, qc\);/);
  assert.match(body, /text: 'COLOUR IMPRESSIONS',/);
  assert.match(body, /line: `Colour Impressions copy · Downloaded by \$\{req\.user\.name\} · \$\{istStamp\(out\.at\)\} · Ref \$\{out\.ref\}`/);
  const tell = route.slice(route.indexOf('export async function tellManagementOfDownload'));
  assert.match(tell, /if \(!user\?\.outside\) return;/);
  assert.match(tell, /notificationRecipients\(users, 'is_management', user\.id\)/);
  assert.match(tell, /kind: 'fluence_download',/);
  assert.match(tell, /title: `\$\{what\} — downloaded by \$\{user\.name\}`/);
  assert.match(read('server/src/notify-categories.js'), /fluence_download: 'alerts'/);
  // The Change log lists them.
  assert.match(route, /WHEN a\.entity = 'fluence_download' THEN a\.action/);
  assert.match(route, /WHERE a\.entity IN \('fluence_inner_product', 'kit_studio', 'fluence_download'\)/);
  assert.match(read('client/src/pages/Fluence.jsx'), /download_pdf: 'Downloaded · PDF', download_xlsx: 'Downloaded · Excel', download_print: 'Printed'/);
});

test('what the record and the notice say', () => {
  assert.equal(downloadDetail({ what: 'Fluence products', format: 'xlsx', rows: 61, filter: 'Search: "skin"' }), 'Fluence products — Excel, 61 rows, Search: "skin"');
  assert.equal(downloadDetail({ what: 'Kit report — NEW M4', format: 'pdf', rows: 1, filter: '' }), 'Kit report — NEW M4 — PDF, 1 row');
  assert.equal(downloadDetail({ what: 'Printed the page /fluence', format: 'print', rows: null, filter: '' }), 'Printed the page /fluence — Printed');
});

test('a watermark is only what the server gave', () => {
  assert.equal(normalizeWatermark(null), null);
  assert.equal(normalizeWatermark({ text: '  ' }), null);
  assert.deepEqual(normalizeWatermark(WM), WM);
});

test('an Excel file a customer downloads wears the watermark; a Colour Impressions one does not', async () => {
  let blob = null;
  globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } };
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = b => { blob = b; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  try {
    const { exportXLSX } = await import('../../client/src/lib/exporter.js');
    const ExcelJS = (await import('exceljs')).default;
    const spec = { title: 'Fluence Products', columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Product' }],
      rows: [{ code: 'FP-1', name: 'A' }, { code: 'FP-2', name: 'B' }, { code: 'FP-3', name: 'C' }] };
    const open = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await blob.arrayBuffer())); return wb; };

    await exportXLSX({ ...spec, watermark: WM });
    let wb = await open();
    let ws = wb.worksheets[0];
    assert.equal(ws.getCell('A4').value, `COLOUR IMPRESSIONS — ${WM.line}`, 'a banner above the table');
    assert.match(ws.headerFooter.oddHeader, /COLOUR IMPRESSIONS/, 'the printed header');
    assert.match(ws.headerFooter.oddFooter, /Ref FD-9/, 'the printed footer');
    assert.equal(wb.creator, 'Colour Impressions');
    assert.equal(wb.subject, WM.line);
    const head = ws.getRow(6);
    assert.equal(head.getCell(2).value, 'Code', 'the table follows the banner');
    assert.equal(ws.getRow(8).getCell(2).fill?.fgColor?.argb, undefined, 'rows left unfilled so the name behind them shows');

    await exportXLSX(spec);
    wb = await open();
    ws = wb.worksheets[0];
    assert.equal(ws.getCell('A4').value, null, 'no banner');
    assert.ok(!ws.headerFooter?.oddHeader, 'no header');
    assert.notEqual(wb.creator, 'Colour Impressions');
    assert.equal(ws.getRow(5).getCell(2).value, 'Code');
    assert.equal(ws.getRow(7).getCell(2).fill?.fgColor?.argb, 'FFF6F9FE', 'the zebra stays');
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    delete globalThis.document;
  }
});

test('the PDF: the name across every page, whose copy it is under the footer', () => {
  const src = read('client/src/lib/exporter.js');
  const pdf = src.slice(src.indexOf('function watermarkPdf('), src.indexOf('// Excel header/footer codes'));
  assert.match(pdf, /for \(let p = 1; p <= pages; p\+\+\) \{\s*doc\.setPage\(p\);/, 'every page');
  assert.match(pdf, /doc\.setGState\(new doc\.GState\(\{ opacity: 0\.09 \}\)\);/, 'light enough to read through');
  assert.match(pdf, /doc\.text\(wm\.text, x, y, \{ angle \}\);/);
  assert.match(pdf, /doc\.text\(pdfText\(wm\.line\), M, H - 3\.4\);/);
  assert.match(src, /if \(spec\.watermark\) \{\s*watermarkPdf\(doc, spec\.watermark, \{ W, H, M \}\);/);
  assert.match(src, /if \(imageId != null\) ws\.addBackgroundImage\(imageId\);/, 'Excel: the name behind the cells');
});

test('every way a file leaves the module asks first', () => {
  // The ERP's tables: the export menu runs the gate before it makes the file.
  const ui = read('client/src/components/ui.jsx');
  assert.match(ui, /const file = gate \? await gate\(kind, spec\) : spec;\s*if \(kind === 'pdf'\) await exportPDF\(file\); else await exportXLSX\(file\);/);
  assert.equal((ui.match(/<ExportMenu build=\{buildExport\} gate=\{exportGate\} \/>/g) || []).length, 2);
  const page = read('client/src/pages/Fluence.jsx');
  assert.equal((page.match(/exportGate=\{GATE\.(products|customer|changes)\}/g) || []).length, 3, 'all three lists');
  const lib = read('client/src/lib/fluenceDownloads.js');
  assert.match(lib, /api\.post\('\/fluence\/downloads', \{ what, format, rows, filter \}\)/);
  assert.match(lib, /return watermark \? \{ \.\.\.spec, watermark \} : spec;/);
  // Kit Studio: its lists through the host's exporter, its own report on record first.
  const frame = read('client/src/components/fluence/KitStudioFrame.jsx');
  assert.match(frame, /const gated = await fluenceExportGate\(/);
  assert.match(frame, /recordDownload\(info = \{\}\)/);
  const html = read('client/public/kit-studio-app/index.html');
  for (const list of ['kits', 'products', 'drafts']) assert.ok(html.includes(`listExportBtns('${list}')`), `${list} list has its PDF / Excel buttons`);
  assert.match(html, /if\(X&&X\.beforeDownload\)\{ try\{ wm=await X\.beforeDownload\(/, 'the kit report asks first');
  assert.match(html, /The download could not be recorded, so the PDF was not made/, 'no record, no file');
  assert.match(html, /let out; try\{ out=await buildPdf\(data,R,wm\); \}/);
  assert.match(html, /if\(wm&&wm\.text\)\{ const th=Math\.atan2\(PH,PW\)/, 'and wears the watermark');
  assert.match(html, /if\(kind\.includes\(':'\)\)\{ const \[k,f\]=kind\.split\(':'\); return listExport\(k,f,'all',null\); \}/, 'Export & settings goes through the ERP too');
  const bridge = read('client/public/kit-studio-app/erp-bridge.js');
  assert.match(bridge, /exportList: typeof host\.exportList === 'function'/);
  assert.match(bridge, /beforeDownload: typeof host\.recordDownload === 'function'/);
  // A printed page from a customer's login: watermarked by the print stylesheet, and recorded.
  const shell = read('client/src/components/AppLayout.jsx');
  assert.match(shell, /const printMark = outside \? <PrintWatermark user=\{user\} \/> : null;/);
  assert.equal((shell.match(/<Outlet \/>\s*\{printMark\}/g) || []).length, 3, 'phone, tablet and desktop shells');
  assert.match(shell, /className="pointer-events-none fixed inset-0 z-\[2147483647\] hidden items-center justify-center print:flex"/, 'print only');
  assert.match(shell, /recordDownload\(\{ what: `Printed the page \$\{where\}`, format: 'print' \}\)/);
  assert.match(shell, /window\.addEventListener\('beforeprint', onPrint\);/);
});
