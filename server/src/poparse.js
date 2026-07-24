// Customer-PO PDF → { scanned, header_text, po_number, po_date, delivery_date, lines }.
// pdfjs-dist positioned text, rows grouped by Y; a line item is a row with a
// description plus numbers where qty×rate≈amount (or the best fallback pick).

let pdfjs;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // pdfjs-dist's Node legacy build probes DOM rendering classes at import time.
  // Text extraction does not use them, but serverless Node has no DOM globals.
  globalThis.DOMMatrix ||= class DOMMatrix {};
  globalThis.Path2D ||= class Path2D {};
  globalThis.ImageData ||= class ImageData {};
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

async function extractRows(buffer) {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ str: String(it.str).trim(), x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.str);
    const byY = [];
    for (const it of items) {
      const bucket = byY.find(b => Math.abs(b.y - it.y) < 2.5);
      if (bucket) bucket.items.push(it); else byY.push({ y: it.y, items: [it] });
    }
    for (const b of byY.sort((a, z) => z.y - a.y)) {
      const cells = b.items.sort((a, z) => a.x - z.x).map(i => i.str);
      rows.push({ page: p, cells, text: cells.join(' ') });
    }
  }
  return rows;
}

const DATE_RE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;
const toISO = m => {
  const [, d, mo, yRaw] = m;
  const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const findDate = (rows, labelRe) => {
  for (const row of rows) {
    if (!labelRe.test(row.text)) continue;
    // prefer a date after the label on the same row, else any date in the row
    const after = row.text.slice(row.text.search(labelRe));
    const m = after.match(DATE_RE) || row.text.match(DATE_RE);
    if (m) return toISO(m);
  }
  return null;
};

function findPoNumber(rows) {
  for (const row of rows) {
    const m = row.text.match(/(?:P\.?\s*O\.?|PURCHASE\s+ORDER|ORDER)\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-._]{2,})/i);
    if (m && !/^(DATE|NO|NUMBER)$/i.test(m[1])) return m[1];
  }
  return null;
}

const NUM_RE = /^[₹]?[\d,]+(\.\d+)?$/;
const SKIP_RE = /GSTIN|TOTAL|SUB\s*TOTAL|GRAND|FREIGHT|CGST|SGST|IGST|ROUND|AMOUNT\s+IN\s+WORDS|TERMS|PAGE\s+\d/i;

// The customer's own item/SKU code (e.g. "PCS-O253") usually leads the line
// description on their PO. Best-effort only: a leading token that starts with a
// letter and carries a digit. Purely a pre-fill for the import wizard — the
// planner always sees and can edit it, so a wrong guess costs nothing.
function extractItemCode(desc) {
  const first = String(desc || '').split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z0-9/\-.]{3,19}$/.test(first) && /\d/.test(first) ? first : null;
}

function assignQtyRate(nums) {
  // strongest signal: some triple with qty × rate ≈ amount
  for (const a of nums) for (const b of nums) {
    if (a === b || !Number.isInteger(a) || a < 1) continue;
    const prod = a * b;
    if (nums.some(c => c !== a && c !== b && prod > 0 && Math.abs(c - prod) / prod < 0.02)) return { qty: a, rate: b };
  }
  const ints = nums.filter(n => Number.isInteger(n) && n >= 1);
  if (!ints.length) return null;
  const qty = Math.max(...ints);
  const rate = nums.find(n => !Number.isInteger(n)) ?? nums.find(n => n !== qty && n < qty) ?? null;
  return { qty, rate };
}

function detectLines(rows) {
  const lines = [];
  for (const row of rows) {
    if (SKIP_RE.test(row.text)) continue;
    const nums = [];
    const textParts = [];
    for (const c of row.cells) {
      const clean = c.replace(/[₹,\s]/g, '');
      if (NUM_RE.test(clean)) nums.push(parseFloat(clean));
      else textParts.push(c);
    }
    const desc = textParts.join(' ').replace(/^\s*\d{1,3}[.)]?\s*/, '').trim();
    if (nums.length < 2 || desc.replace(/[^A-Za-z]/g, '').length < 4) continue;
    // drop a leading serial number (small int in the first cell) when we still
    // have enough numbers left for qty + rate
    const firstIsSerial = NUM_RE.test((row.cells[0] || '').replace(/[₹,\s]/g, '')) && parseFloat(row.cells[0]) <= 200 && nums.length > 2;
    const pick = assignQtyRate(firstIsSerial ? nums.slice(1) : nums);
    if (!pick || pick.qty < 1) continue;
    lines.push({ raw_text: desc, qty: pick.qty, rate: pick.rate, item_code: extractItemCode(desc) });
  }
  return lines;
}

export async function parsePO(buffer) {
  const rows = await extractRows(buffer);
  const allText = rows.map(r => r.text).join(' ');
  if (allText.replace(/\s/g, '').length < 40) {
    return { scanned: true, header_text: '', po_number: null, po_date: null, delivery_date: null, lines: [] };
  }
  const headerRows = rows.filter(r => r.page === 1).slice(0, 25);
  return {
    scanned: false,
    header_text: headerRows.map(r => r.text).join(' '),
    po_number: findPoNumber(rows),
    po_date: findDate(rows, /P\.?\s*O\.?\s*DATE|ORDER\s*DATE|\bDATED?\b/i),
    delivery_date: findDate(rows, /DELIVERY|DEL\.?\s*DATE|SUPPLY\s*BY|DUE\s*DATE/i),
    lines: detectLines(rows),
  };
}
