import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { buildProof, STRIP_MM, stampText } from './artwork-proof.js';

// The proof: the designer's export, untouched, on a taller page with the proof strip and the stamp below it.
const MM = 72 / 25.4;
async function exportPdf(pages = [[138, 96.5]]) {
  const d = await PDFDocument.create();
  for (const [w, h] of pages) {
    const p = d.addPage([w * MM, h * MM]);
    p.drawRectangle({ x: 5, y: 5, width: 20, height: 20, color: rgb(0, 0.5, 1) });
  }
  return d.save();
}
const info = { proof_no: 'PRF-CI-AW-0001-R0.1-1', date: '2026-11-17T07:35:00Z', customer: 'Example Pharma Ltd', product_name: 'ALPHA CARTON',
  client_item_code: 'PCS-X001', label: 'R0.1', colours: ['Cyan', 'Magenta', 'PANTONE 286 C'] };

test('every page of the export is kept, the same width, with the strip added below it', async () => {
  const out = await buildProof({ pdfBytes: await exportPdf([[138, 96.5], [200, 50]]), info });
  const d = await PDFDocument.load(out.bytes);
  assert.equal(d.getPageCount(), 2);
  const [a, b] = d.getPages().map(p => p.getSize());
  assert.ok(Math.abs(a.width - Math.max(138, 190) * MM) < 0.5 || Math.abs(a.width - 138 * MM) < 0.5);
  assert.ok(Math.abs(a.height - (96.5 + STRIP_MM) * MM) < 0.5, 'strip added below');
  assert.ok(Math.abs(b.height - (50 + STRIP_MM) * MM) < 0.5);
  assert.equal(out.page_w_mm, 138);
  assert.equal(out.page_h_mm, 96.5);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});

test('the strip says what the proof is: number, date, client, product, code, size, colours, not for print', async () => {
  const out = await buildProof({ pdfBytes: await exportPdf(), info });
  const all = out.lines.join('\n');
  for (const want of ['PRF-CI-AW-0001-R0.1-1', '17 Nov 2026', 'Example Pharma Ltd', 'ALPHA CARTON', 'PCS-X001 R0.1', '138 × 96.5 mm', 'Cyan, Magenta, PANTONE 286 C', 'FOR APPROVAL — NOT FOR PRINT']) {
    assert.ok(all.includes(want), `${want} missing from: ${all}`);
  }
});

test('the stamp: COLOUR IMPRESSIONS round the ring, APPROVAL OF DESIGN & TEXT across, proof number and date inside', () => {
  const s = stampText(info);
  assert.equal(s.ring, 'COLOUR IMPRESSIONS');
  assert.deepEqual(s.band, ['APPROVAL OF', 'DESIGN & TEXT']);
  assert.equal(s.no, 'PRF-CI-AW-0001-R0.1-1');
  assert.equal(s.date, '17 NOV 2026');
});

test('a name with characters the PDF font cannot draw does not stop the proof', async () => {
  const out = await buildProof({ pdfBytes: await exportPdf(), info: { ...info, product_name: 'ALPHA ✓ CARTON — 10’s', customer: 'Ünïcode Pharma' } });
  assert.ok(out.bytes.length > 1000);
  assert.ok(out.lines.join(' ').includes('ALPHA ? CARTON'));
});

test('a file that is not a PDF is refused with words a person understands', async () => {
  await assert.rejects(buildProof({ pdfBytes: Buffer.from('not a pdf'), info }), /could not be read as a PDF/);
});
