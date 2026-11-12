import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { kldPdf } from './kld-pdf.js';
import { kldBlank } from '../../client/src/lib/kld.js';

// The die maker's copy of a KLD: the blank at 1:1 on page one, the sheet layout on page two.
const PT = 72 / 25.4;
const KLD = {
  v: 1, rev: 2, construction: 'LOCK', reading: 'lock', tube: 66, face: 92, w: 80, style: 'LOCK', size_key: '92x80x66',
  layout: { sheet_long: 25, sheet_short: 15, ups: 4, m: 1, n: 4, across_on: 'short' },
  drawn_at: '2026-11-12T10:00:00Z', drawn_by: 'Test Planner', drive: [],
};

test('the PDF opens and page one holds the blank at 1:1 with room for the dimensions', async () => {
  const bytes = await kldPdf({ kld: KLD, title: 'TEST CARTON 92 × 80 × 66' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
  const blank = kldBlank({ construction: 'LOCK', tube: 66, face: 92, w: 80 });
  const { width, height } = doc.getPage(0).getSize();
  assert.ok(width >= (blank.width + 30) * PT, `page width ${width / PT} mm`);
  assert.ok(height >= (blank.height + 30) * PT, `page height ${height / PT} mm`);
});

test('a reverse tuck KLD draws too, and a KLD with no layout leaves out page two', async () => {
  const bytes = await kldPdf({ kld: { ...KLD, construction: 'RTE', reading: 'top-open', tube: 100, face: 65, w: 40, layout: null }, title: 'TEST 65 × 40 × 100' });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
});
