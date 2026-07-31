// PO parsing — and the serverless guard that keeps it alive on Vercel.
//
// The bug this file exists to prevent: pdfjs-dist runs its PDF engine in a
// "worker" module. Under Node it defaults to `GlobalWorkerOptions.workerSrc =
// "./pdf.worker.mjs"` and loads it with `await import(<variable>)`, annotated
// webpackIgnore/@vite-ignore. No static tracer can follow a variable specifier,
// so @vercel/nft — the tracer that decides what ships in the Vercel function —
// left pdf.worker.mjs out of the bundle. Locally the file sits in node_modules
// and everything passes; in production the import failed, parsePO() threw, and
// every single PO came back as "may be corrupt".
//
// The fix is to import the worker with a *static* specifier (traceable) and hand
// it to pdfjs via globalThis.pdfjsWorker, which short-circuits the untraceable
// dynamic import entirely. That is what the first test below locks down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { parsePO, loadPdfjs } from './poparse.js';

function makePO(lines) {
  return new Promise(resolve => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    let y = 50;
    for (const line of lines) { doc.fontSize(10).text(line, 50, y); y += 20; }
    doc.end();
  });
}

const SAMPLE = [
  'SWISS GARNIER BIOTECH LIMITED',
  'GSTIN: 27AAACC1234A1Z5',
  'PURCHASE ORDER NO: SGB/2627/POS/PMP/01796',
  'PO DATE: 25/07/2026',
  'DELIVERY DATE: 05/08/2026',
  '1  PCS-O253 Nicoduce Mono Carton 250gsm   5000   12.50   62500',
  '2  PCS-O254 Bifibless Mono Carton 250gsm  3000   11.00   33000',
  'TOTAL                                                    95500',
];

// Must stay the FIRST test in this file: it asserts on state that exists only
// before anything has opened a PDF. pdf.worker.mjs assigns globalThis.pdfjsWorker
// itself once it loads, so parsing first would mask the very thing under test.
test('loadPdfjs preloads the worker itself, before any document is opened', async () => {
  assert.equal(globalThis.pdfjsWorker, undefined,
    'precondition: no PDF may be parsed before this test — move it back to the top of the file');
  await loadPdfjs();
  // Set by loadPdfjs() from a *static* import specifier, which @vercel/nft can
  // follow into the function bundle. If this is undefined, we have fallen back
  // to pdfjs's own `import("./pdf.worker.mjs")` — untraceable, so the worker is
  // pruned from the Vercel bundle and every PO fails as "may be corrupt", while
  // every local test still passes.
  assert.equal(typeof globalThis.pdfjsWorker?.WorkerMessageHandler, 'function',
    'pdfjs worker must be preloaded via a statically traceable import');
});

test('reads header fields and line items off a text PO', async () => {
  const parsed = await parsePO(await makePO(SAMPLE));
  assert.equal(parsed.scanned, false);
  assert.equal(parsed.po_number, 'SGB/2627/POS/PMP/01796');
  assert.equal(parsed.po_date, '2026-07-25');
  assert.equal(parsed.delivery_date, '2026-08-05');
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].qty, 5000);
  assert.equal(parsed.lines[0].rate, 12.5);
  assert.equal(parsed.lines[0].item_code, 'PCS-O253');
  assert.match(parsed.lines[0].raw_text, /Nicoduce/);
  assert.match(parsed.header_text, /SWISS GARNIER/);
});

test('page furniture never becomes a line item', async () => {
  // Real Swiss Garnier POs print "Page : 1 / 2" on every sheet, and the PDF
  // positions each piece separately, so the row's cells arrive as
  // [Page :, 1, /, 2] — two numbers plus four letters of text, exactly the
  // shape of a line item. Every sheet minted a phantom line with qty=2.
  const pdf = await new Promise(resolve => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(10);
    // separate draw calls -> separate positioned items -> separate cells
    // wide gaps so pdfjs cannot merge adjacent pieces into one item
    doc.text('Page :', 50, 40, { lineBreak: false });
    doc.text('1', 120, 40, { lineBreak: false });
    doc.text('/', 190, 40, { lineBreak: false });
    doc.text('2', 260, 40, { lineBreak: false });
    doc.text('PURCHASE ORDER NO: SGB/2627/POS/PMP/00769', 50, 60, { lineBreak: false });
    doc.text('1  PCS-E243 EUGI SACHETS CARTON 10X1g   4000   3.10   12400', 50, 80, { lineBreak: false });
    doc.end();
  });
  const parsed = await parsePO(pdf);
  assert.equal(parsed.lines.length, 1, JSON.stringify(parsed.lines));
  assert.match(parsed.lines[0].raw_text, /EUGI/);
});

test('a PDF with no extractable text is reported as scanned, not as an error', async () => {
  const parsed = await parsePO(await makePO(['x']));
  assert.equal(parsed.scanned, true);
  assert.deepEqual(parsed.lines, []);
});

// Kept last: it deliberately points pdfjs's worker path at nothing and leaves it
// that way, which is the whole point — nothing after it should need that path.
test('parsing survives an unresolvable worker path (the production failure mode)', async () => {
  const pdfjs = await loadPdfjs();
  pdfjs.GlobalWorkerOptions.workerSrc = '/nonexistent/pdf.worker.mjs';
  // With the worker preloaded this is a no-op. Without it, pdfjs rejects with
  // `Setting up fake worker failed: "Cannot find module ..."` — which is exactly
  // what a Vercel bundle missing pdf.worker.mjs produced for every PO.
  const parsed = await parsePO(await makePO(SAMPLE));
  assert.equal(parsed.po_number, 'SGB/2627/POS/PMP/01796');
  assert.equal(parsed.lines.length, 2);
});

test('a genuinely unreadable PDF throws a pdfjs content error, not a generic one', async () => {
  // This is the only shape of failure that may legitimately reach the planner
  // as "may be corrupt" — routes/import.js keys its 422 off the exception name.
  await assert.rejects(
    () => parsePO(Buffer.from('%PDF-1.4\nthis is not a real pdf body')),
    e => e.name === 'InvalidPDFException',
  );
});
