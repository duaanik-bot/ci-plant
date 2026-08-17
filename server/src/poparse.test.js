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

test('splits leading item/artwork code and carries carton specs from a PO line', async () => {
  const parsed = await parsePO(await makePO([
    'PURCHASE ORDER NO: SGB/2627/POS/PMP/01915',
    'PO DATE: 05/08/2026',
    '1 PCS-R455/R RENOSKY CARTON size 45x32x18mm Saffire 300gsm varnish   5000   2.05   10250',
  ]));
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].item_code, 'PCS-R455');
  assert.equal(parsed.lines[0].artwork_code, 'R');
  assert.equal(parsed.lines[0].carton_size, '45x32x18mm');
  assert.equal(parsed.lines[0].board_grade, 'Saffire');
  assert.equal(parsed.lines[0].gsm, 300);
  assert.equal(parsed.lines[0].coating, 'Aqueous Varnish');
  assert.equal(parsed.lines[0].name_text, 'RENOSKY CARTON');
  assert.doesNotMatch(parsed.lines[0].name_text, /^PCS-R455/);
});

test('reads die, sheet size, ups and pasting from a dense PO description', async () => {
  const parsed = await parsePO(await makePO([
    'PURCHASE ORDER NO: SGB/2627/POS/PMP/01916',
    '1 PCS-R455/R RENOSKY CARTON AW CODE AW-77 dimensions 100 x48x48 board size 15.75x 20.75 die D-105 8 ups Full UV LOCK BOTTOM Saffire 300gsm 5000 2.05 10250',
  ]));
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].item_code, 'PCS-R455');
  assert.equal(parsed.lines[0].artwork_code, 'AW-77');
  assert.equal(parsed.lines[0].carton_size, '100x48x48');
  assert.equal(parsed.lines[0].sheet_size, '15.75x20.75');
  assert.equal(parsed.lines[0].die_code, 'D-105');
  assert.equal(parsed.lines[0].ups, 8);
  assert.equal(parsed.lines[0].coating, 'Full UV');
  assert.equal(parsed.lines[0].pasting_type, 'LOCK BOTTOM');
  assert.equal(parsed.lines[0].board_grade, 'Saffire');
  assert.equal(parsed.lines[0].gsm, 300);
  assert.equal(parsed.lines[0].name_text, 'RENOSKY CARTON');
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

// ---------------------------------------------------------------------------
// Columnar reading.
//
// Every test below fails against the number-shape reader alone. That reader
// infers qty and rate from the SHAPE of a row's numbers, so any other integer
// on the row outranks the real quantity: the HSN code and the line's taxable
// value both win under Math.max. Across the real POs on file that produced a
// ₹63,450 quantity on a ₹2.35 carton, and nothing downstream questioned it.
//
// Fixtures print at 6pt on purpose. pdfkit at 8pt makes pdfjs merge adjacent
// cells into one positioned run ("1750.000"+"NOS" -> "1750.000NOS"), inventing
// a failure no real PO has; the templates these mimic print at about 6pt.
// ---------------------------------------------------------------------------
function makeTable(rows) {
  return new Promise(resolve => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(6);
    for (const [y, cells] of rows) {
      for (const [text, x] of cells) doc.text(text, x, y, { lineBreak: false });
    }
    doc.end();
  });
}

// Tally: one heading row, an HSN code on every line, and the unit inside the
// quantity cell ("3,000 NOS").
const TALLY = [
  [60, [['FLUENCE PHARMA PVT LTD', 38]]],
  [70, [['GSTIN/UIN : 09AABCF9274F1ZE', 38]]],
  [100, [['Sl', 40], ['Description of Goods', 102], ['HSN/SAC', 202], ['Quantity', 309], ['Rate', 369], ['Amount', 449]]],
  [108, [['No.', 40]]],
  [120, [['1', 40], ['20251010 F1D3', 102], ['48192090', 199], ['3,000 NOS', 303], ['17.490', 375], ['52,470.000', 447]]],
  [131, [['1054', 102]]],
  [142, [['2', 40], ['20251016 F3D3', 102], ['48192090', 199], ['500 NOS', 303], ['25.520', 375], ['12,760.000', 447]]],
];

test('an HSN code on the line does not become its quantity', async () => {
  const parsed = await parsePO(await makeTable(TALLY));
  assert.equal(parsed.reader, 'columns');
  assert.equal(parsed.lines.length, 2);
  // The shape reader returns 48192090 here — the HSN, the largest integer on
  // the row — and silently books an eight-digit order quantity.
  assert.deepEqual(parsed.lines.map(l => l.qty), [3000, 500]);
  assert.deepEqual(parsed.lines.map(l => l.rate), [17.49, 25.52]);
  assert.deepEqual(parsed.lines.map(l => l.amount), [52470, 12760]);
  // qty x rate == the amount the document itself prints.
  assert.ok(parsed.lines.every(l => l.reconciled));
});

test('a short item name under a numeric party code still starts a line', async () => {
  const parsed = await parsePO(await makeTable(TALLY));
  // "F1D3" carries two letters. Requiring three threw these rows into the
  // continuation branch, which dropped whole items and glued the rest onto the
  // description of the item above.
  assert.equal(parsed.lines.length, 2);
  assert.match(parsed.lines[0].raw_text, /20251010/);
  assert.match(parsed.lines[1].raw_text, /20251016/);
  // The wrapped tail of the description belongs to its own line, not the next.
  assert.match(parsed.lines[0].raw_text, /1054/);
  assert.doesNotMatch(parsed.lines[1].raw_text, /1054/);
});

test('letterhead above the table cannot weld two columns into one', async () => {
  // "State Name : Uttar Pradesh, Code : 09" is left-aligned text that spans the
  // serial, description and HSN columns at once. Grown into the heading block
  // it collapses them into a single band, which puts the serial number inside
  // the item name and loses lines.
  const parsed = await parsePO(await makeTable([
    [88, [['State Name', 38], [': Uttar Pradesh, Code : 09', 90]]],
    ...TALLY,
  ]));
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(parsed.lines.map(l => l.qty), [3000, 500]);
  assert.ok(!/^\s*1\b/.test(parsed.lines[0].raw_text),
    `serial number leaked into the item name: ${parsed.lines[0].raw_text}`);
});

// Swiss: headings stacked four rows deep, and a rate that prints on a row of
// its own a few points above the line it belongs to.
const SWISS = [
  [60, [['SWISS GARNIERS BIOTECH PRIVATE LIMITED', 38]]],
  [70, [['GSTIN : 02ABACS5319Q1Z5', 38]]],
  [100, [['Item Code', 34], ['Basic', 371], ['TAXABLE', 411]]],
  [107, [['Delivery', 259]]],
  [114, [['Sl.', 17], ['Description of Goods', 83], ['Qty.', 309], ['UOM', 337], ['Rate', 373], ['GST%', 455]]],
  [121, [['HSN/SAC', 37], ['At Site', 259], ['VALUE', 416]]],
  [133, [['2.350', 383]]],
  // The serial sits at 17, not 25: the real PO prints it 6pt from the item code
  // and pdfjs still reports two runs, but pdfkit lays them out tightly enough
  // that pdfjs coalesces them into one ("1 PMC-F146/R") — a fixture artifact,
  // not a parser fault. Spacing it restores what the real document looks like.
  [136, [['1', 17], ['PMC-F146/R', 34], ['FERINTO TABLETS PTD', 81], ['26/05/2026', 259],
         ['27000.000', 301], ['NOS', 337], ['63450.000', 419], ['5.00', 464]]],
  [147, [['MONOCARTON(2X15)SALE-R1', 81]]],
  [158, [['(DIMENSION: L80 x W18 x H79mm; SPEC: 300GSM Sapphire Board)', 80]]],
];

test('a stacked heading is read as one column model', async () => {
  const parsed = await parsePO(await makeTable(SWISS));
  assert.equal(parsed.reader, 'columns');
  assert.equal(parsed.lines.length, 1);
  const [line] = parsed.lines;
  // Read row-wise, the taxable VALUE is the biggest integer and becomes the
  // quantity (63450) while the real quantity becomes the rate (27000).
  assert.equal(line.qty, 27000);
  assert.equal(line.amount, 63450);
  assert.equal(line.reconciled, true);
});

test('a rate printed on its own row is attached to its line', async () => {
  const parsed = await parsePO(await makeTable(SWISS));
  // 2.350 sits ~3pt above its line — outside the row bucket, so it arrives as a
  // row by itself. Dropped, the line prices at 63450/27000 by division and only
  // looks right; the rate column is the figure the customer actually agreed.
  assert.equal(parsed.lines[0].rate, 2.35);
});

test('the specification paragraph feeds the spec fields, never the item name', async () => {
  const parsed = await parsePO(await makeTable(SWISS));
  const [line] = parsed.lines;
  // raw_text is what pomatch fuzzy-scores and what alias learning is keyed on.
  // Folding a spec paragraph into it re-keys every alias the plant has taught.
  assert.doesNotMatch(line.raw_text, /DIMENSION|Sapphire/i);
  assert.match(line.raw_text, /MONOCARTON/);   // the wrapped NAME still belongs
  assert.equal(line.spec_text.includes('DIMENSION'), true);
  // ...while the spec itself is still read, out of the paragraph.
  assert.equal(line.gsm, 300);
  assert.equal(line.carton_size, '80x18x79mm');
  // The customer's own SKU still leads the line, so pomatch's party-item-code
  // match keeps firing even though the code prints in its own column here.
  assert.equal(line.item_code, 'PMC-F146');
});

test('a table with no usable heading still falls back to the shape reader', async () => {
  const parsed = await parsePO(await makePO(SAMPLE));
  assert.equal(parsed.reader, 'shape');
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].qty, 5000);
});

// ---------------------------------------------------------------------------
// The OCR ingest path.
//
// A scanned PO has no text layer, so the client renders each page and OCRs it,
// and the word boxes arrive here instead of pdfjs runs. The contract that makes
// that safe is that NOTHING below extraction knows the difference: the same row
// bucketing, heading model and columnar reader must produce the same answer.
// ---------------------------------------------------------------------------
import { parseFromRows, rowsFromItems, ocrPagesToItems } from './poparse.js';

// pdfjs runs -> the canvas-space word boxes an OCR engine would have returned
// for the same page, rendered at `scale`.
async function asOcrPages(buffer, scale = 3) {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = [];
    for (const it of content.items) {
      const s = String(it.str).trim();
      if (!s) continue;
      const [, , , , x, y] = it.transform;
      const bottom = (vp.height - y) * scale;   // canvas y grows DOWNWARD
      words.push({ text: s, x0: x * scale, x1: (x + (it.width || 0)) * scale, y0: bottom - 30, y1: bottom });
    }
    pages.push({ page: p, scale, width_px: vp.width * scale, height_px: vp.height * scale, words });
  }
  return pages;
}

test('OCR word boxes convert to points with y flipped off the page height', () => {
  const items = ocrPagesToItems([{
    page: 1, scale: 2, width_px: 1190, height_px: 1684,
    words: [{ text: 'Qty.', x0: 200, y0: 100, x1: 260, y1: 140 }],
  }]);
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it.x, 100);                 // 200 / scale
  assert.equal(it.w, 30);                  // (260-200) / scale
  // A canvas box 140px from the TOP at 2x sits (1684-140)/2 = 772pt from the
  // BOTTOM, which is how pdfjs reports it. Getting this backwards flips the
  // page over and the totals read as the heading.
  assert.equal(it.y, 772);
});

test('a blank or unparseable OCR word is dropped, not turned into NaN geometry', () => {
  const items = ocrPagesToItems([{
    page: 1, scale: 1, height_px: 100,
    words: [
      { text: '  ', x0: 1, y0: 1, x1: 2, y1: 2 },
      { text: 'ok', x0: 'x', y0: 1, x1: 2, y1: 2 },
      { text: 'good', x0: 10, y0: 1, x1: 20, y1: 30 },
    ],
  }]);
  assert.deepEqual(items.map(i => i.str), ['good']);
});

test('the OCR path reads a PO identically to the text-layer path', async () => {
  // Same document, same numbers, arriving as pixels instead of runs. If these
  // ever diverge, a scanned PO and its digital twin would import differently.
  for (const fixture of [SWISS, TALLY]) {
    const buf = await makeTable(fixture);
    const direct = await parsePO(buf);
    const viaOcr = parseFromRows(rowsFromItems(ocrPagesToItems(await asOcrPages(buf))));
    assert.equal(viaOcr.reader, direct.reader);
    assert.deepEqual(
      viaOcr.lines.map(l => [l.raw_text, l.qty, l.rate, l.amount]),
      direct.lines.map(l => [l.raw_text, l.qty, l.rate, l.amount]),
    );
  }
});

test('the OCR path does not re-apply the scanned test that sent it there', async () => {
  // parsePO refuses a document with almost no text as "scanned". parseFromRows
  // must NOT repeat that check: OCR output is exactly the case that arrives
  // having already failed it, and re-testing would reject the rescue.
  const buf = await makeTable(TALLY);
  const parsed = parseFromRows(rowsFromItems(ocrPagesToItems(await asOcrPages(buf))));
  assert.equal(parsed.scanned, false);
  assert.ok(parsed.lines.length >= 2);
});

test('rowsFromItems keeps pages apart and orders rows down the page', () => {
  const rows = rowsFromItems([
    { page: 2, str: 'second-page', x: 10, y: 500, w: 20 },
    { page: 1, str: 'lower', x: 10, y: 100, w: 20 },
    { page: 1, str: 'upper', x: 10, y: 700, w: 20 },
    { page: 1, str: 'beside-upper', x: 40, y: 700.5, w: 20 },
  ]);
  assert.deepEqual(rows.map(r => [r.page, r.text]), [
    [1, 'upper beside-upper'],   // within 2.5pt -> one row, ordered by x
    [1, 'lower'],
    [2, 'second-page'],
  ]);
});

test('a derived figure is never reported as reconciled', async () => {
  // A table with no amount column at all: the amount can only be qty x rate.
  // Checking that product against the multiplication that produced it is not a
  // check, and reporting it as one puts a tick beside a figure nobody printed.
  // This is the ORDINARY way OCR fails — a column drops out — so the tick would
  // have appeared exactly where it was least deserved.
  const parsed = await parsePO(await makeTable([
    [60, [['ACME LABS PRIVATE LIMITED', 38]]],
    [70, [['GSTIN : 02ABACS5319Q1Z5', 38]]],
    [100, [['Sl', 40], ['Description of Goods', 102], ['Quantity', 309], ['Rate', 369]]],
    [120, [['1', 40], ['WIDGET CARTON', 102], ['500 NOS', 303], ['12.500', 375]]],
  ]));
  assert.equal(parsed.reader, 'columns');
  const [line] = parsed.lines;
  assert.equal(line.qty, 500);
  assert.equal(line.rate, 12.5);
  assert.equal(line.amount, 6250);          // still offered, as a convenience
  assert.equal(line.amount_derived, true);  // ...but flagged as ours, not theirs
  assert.equal(line.reconciled, null,       // and emphatically not "true"
    'a derived amount cannot corroborate the numbers it was derived from');
});

test('both figures read off the page still reconcile normally', async () => {
  const parsed = await parsePO(await makeTable(TALLY));
  assert.ok(parsed.lines.every(l => l.rate_derived === false && l.amount_derived === false));
  assert.ok(parsed.lines.every(l => l.reconciled === true));
});

test('with no readable heading, the figures name their own columns', async () => {
  // The real failure on a scan: every data row read perfectly while "Qty." came
  // back as "aty.", so the heading model found no quantity column and the whole
  // table was lost. The columns are recoverable from the figures — but only on
  // the document's own evidence, that qty x rate equals the amount on EVERY row.
  const buf = await makeTable(NO_HEADING_BUT_CONSISTENT);
  const rows = rowsFromItems(ocrPagesToItems(await asOcrPages(buf)));
  const strict = parseFromRows(rows, { allowShapeFallback: false });
  assert.equal(strict.reader, 'columns');
  assert.deepEqual(strict.lines.map(l => [l.qty, l.rate, l.amount]), [[500, 12.5, 6250], [250, 10, 2500]]);
  // Both figures were READ, so the arithmetic is a real check and says so.
  assert.ok(strict.lines.every(l => l.reconciled === true && !l.amount_derived));
  // The serial must not end up inside the item name.
  assert.match(strict.lines[0].raw_text, /^WIDGET/);
});

test('when the arithmetic does not hold, nothing is read rather than guessed', async () => {
  // Same shape, but the amounts are not the product of anything on the row —
  // so no triple of columns can be confirmed. The guessing reader would happily
  // answer here; on a scan its answer is a plausible wrong quantity that a
  // planner has no way to catch, so the honest output is none at all.
  const buf = await makeTable(NO_HEADING_INCONSISTENT);
  const rows = rowsFromItems(ocrPagesToItems(await asOcrPages(buf)));
  const strict = parseFromRows(rows, { allowShapeFallback: false });
  assert.deepEqual(strict.lines, []);
  assert.equal(strict.reader, null, 'no reader may be claimed when nothing was read');
  // The text-layer path still has its last resort, where the digits are exact.
  assert.equal((await parsePO(buf)).reader, 'shape');
});

// A table whose heading names no column at all — what an unreadable heading
// leaves behind. Here the money adds up: 500 x 12.50 = 6250, 250 x 10 = 2500.
const NO_HEADING_BUT_CONSISTENT = [
  [60, [['ACME LABS PRIVATE LIMITED', 38]]],
  [70, [['GSTIN : 02ABACS5319Q1Z5', 38]]],
  [120, [['1', 40], ['WIDGET CARTON', 102], ['500', 303], ['12.500', 375], ['6250.000', 447]]],
  [140, [['2', 40], ['GADGET CARTON', 102], ['250', 303], ['10.000', 375], ['2500.000', 447]]],
];

// The same table with amounts that are the product of nothing on the row.
const NO_HEADING_INCONSISTENT = [
  [60, [['ACME LABS PRIVATE LIMITED', 38]]],
  [70, [['GSTIN : 02ABACS5319Q1Z5', 38]]],
  [120, [['1', 40], ['WIDGET CARTON', 102], ['500', 303], ['12.500', 375], ['7777.000', 447]]],
  [140, [['2', 40], ['GADGET CARTON', 102], ['250', 303], ['10.000', 375], ['3333.000', 447]]],
];
