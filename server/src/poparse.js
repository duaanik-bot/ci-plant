// Customer-PO PDF → { scanned, header_text, po_number, po_date, delivery_date, lines }.
// pdfjs-dist positioned text, rows grouped by Y; a line item is a row with a
// description plus numbers where qty×rate≈amount (or the best fallback pick).

let pdfjs;
export async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  // pdfjs-dist's Node legacy build probes DOM rendering classes at import time.
  // Text extraction does not use them, but serverless Node has no DOM globals.
  globalThis.DOMMatrix ||= class DOMMatrix {};
  globalThis.Path2D ||= class Path2D {};
  globalThis.ImageData ||= class ImageData {};
  // The engine itself runs in pdfjs's "worker" module. Left alone, pdfjs loads
  // it under Node with `await import(GlobalWorkerOptions.workerSrc)` — a
  // *variable* specifier, marked webpackIgnore/@vite-ignore. No static tracer
  // can follow that, so @vercel/nft leaves pdf.worker.mjs out of the serverless
  // bundle: fine locally (node_modules has it), fatal on Vercel, where every PO
  // then failed as "may be corrupt". Importing it here by a literal specifier is
  // what puts the file in the bundle; assigning globalThis.pdfjsWorker is what
  // makes pdfjs use it instead of reaching for the untraceable import.
  // Guarded by the first test in poparse.test.js — do not inline this away.
  const [pdf, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);
  globalThis.pdfjsWorker ||= worker;
  pdfjs = pdf;
  return pdfjs;
}

// Exported since the Customer-WIP upload arrived: the Status Sheet's WIP
// reader wants the same Y-bucketed row texts a PO gets, without the PO's
// header/line interpretation on top.
export async function extractRows(buffer) {
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

export const DATE_RE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;
export const toISO = m => {
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
const SKIP_RE = /GSTIN|TOTAL|SUB\s*TOTAL|GRAND|FREIGHT|CGST|SGST|IGST|ROUND|AMOUNT\s+IN\s+WORDS|TERMS|PAGE\s*[:#.]?\s*\d/i;
const DATE_TOKEN_RE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g;
const KNOWN_GRADES = ['Duplex GB', 'Duplex WB', 'Chromo Paper', 'Saffire', 'FBB', 'SBS'];
const DIM = String.raw`\d+(?:\.\d+)?`;
const SIZE2 = String.raw`${DIM}\s*[x×]\s*${DIM}`;
const SIZE3 = String.raw`${DIM}\s*[x×]\s*${DIM}\s*[x×]\s*${DIM}`;

function normalizeSize(raw) {
  return String(raw || '')
    .trim()
    .replace(/[×]/g, 'x')
    .replace(/\s*x\s*/ig, 'x')
    .replace(/\s+/g, ' ')
    .replace(/\s*(MM|CM|INCHES|INCH|IN)\b/i, m => m.trim().toLowerCase());
}

// The customer's own item/SKU code (e.g. "PCS-O253") usually leads the line
// description on their PO. Best-effort only: a leading token that starts with a
// letter and carries a digit. Purely a pre-fill for the import wizard — the
// planner always sees and can edit it, so a wrong guess costs nothing.
function extractLeadCodes(desc) {
  const first = String(desc || '').split(/\s+/)[0] || '';
  if (!/^[A-Za-z][A-Za-z0-9/\-.]{3,24}$/.test(first) || !/\d/.test(first)) {
    return { item_code: null, artwork_code: extractArtworkCode(desc, null) };
  }
  const split = first.match(/^(.+?)\/([A-Za-z]\d{0,2})$/);
  if (split && /\d/.test(split[1])) {
    return { item_code: split[1], artwork_code: extractArtworkCode(desc, split[1]) || split[2].toUpperCase() };
  }
  return { item_code: first, artwork_code: extractArtworkCode(desc, first) };
}

function extractArtworkCode(desc, itemCode) {
  const labelled = String(desc || '').match(/\b(?:A\/W|AW|ARTWORK|ART)\s*(?:CODE|NO\.?|NUMBER)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/._-]{0,19})\b/i);
  if (!labelled) return null;
  const code = labelled[1].replace(/[),.;:]+$/, '');
  if (!code || /^(CODE|NO|NUMBER|NOS|PCS|QTY)$/i.test(code)) return null;
  return itemCode && code.toUpperCase() === itemCode.toUpperCase() ? null : code;
}

function extractGsm(text) {
  const m = String(text || '').match(/\b(\d{2,4})\s*(?:GSM|G\.S\.M\.?|GM\/?M2|G\/M2)\b/i);
  return m ? +m[1] : null;
}

function extractBoardGrade(text) {
  const s = String(text || '');
  const labelled = s.match(/\b(?:BOARD\s*)?(?:GRADE|QUALITY)\s*[:#-]?\s*([A-Za-z][A-Za-z0-9 ]{1,30}?)(?=\s*(?:\d{2,4}\s*GSM|GSM|BOARD|CARTON|COATING|VARNISH|UV|$))/i);
  if (labelled) return labelled[1].trim();
  const upper = s.toUpperCase();
  return KNOWN_GRADES.find(g => upper.includes(g.toUpperCase())) || null;
}

function extractCartonSize(text) {
  const s = String(text || '');
  const labelled = s.match(new RegExp(String.raw`\b(?:CARTON|BOX)?\s*(?:SIZE|DIMENSIONS?|DIMES?NSIONS?|DIMS?|L\s*[x×]\s*W\s*[x×]\s*H)\s*[:#-]?\s*(${SIZE3}\s*(?:MM|CM|INCHES|INCH|IN)?)`, 'i'));
  if (labelled) return normalizeSize(labelled[1]);
  const triple = s.match(new RegExp(String.raw`\b(${SIZE3}\s*(?:MM|CM|INCHES|INCH|IN)?)\b`, 'i'));
  return triple ? normalizeSize(triple[1]) : null;
}

function extractSheetSize(text) {
  const s = String(text || '');
  const labelled = s.match(new RegExp(String.raw`\b(?:BOARD|SHEET|PRINT(?:ING)?|PRINT\s*SHEET|CHILD\s*SHEET|CUT|PAPER)\s*(?:SIZE|DIMENSIONS?|DIMES?NSIONS?|DIMS?)?\s*[:#-]?\s*(${SIZE2}\s*(?:INCHES|INCH|IN|")?)(?!\s*[x×])`, 'i'));
  if (labelled) return normalizeSize(labelled[1]).replace(/"+$/, '');
  return null;
}

function extractDieCode(text) {
  const labelled = String(text || '').match(/\bDIE\s*(?:NO\.?|NUMBER|CODE|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/._-]{0,19})\b/i);
  if (!labelled) return null;
  const code = labelled[1].replace(/[),.;:]+$/, '');
  if (!/\d/.test(code) || /^(CUT|CODE|NO|NUMBER|NOS|SIZE|DIMS?)$/i.test(code)) return null;
  return code.toUpperCase();
}

function extractUps(text) {
  const s = String(text || '');
  const m = s.match(/\b(?:UPS|UP\/S|UP)\s*[:#-]?\s*(\d{1,3})\b/i)
    || s.match(/\b(\d{1,3})\s*(?:UPS|UP\/S|UP)\b/i);
  if (!m) return null;
  const n = +(m[1] || m[2]);
  return n > 0 && n <= 200 ? n : null;
}

function extractPastingType(text) {
  const s = String(text || '');
  if (/\bLOCK\s*BOTTOM\b|\bL\/B\b/i.test(s)) return 'LOCK BOTTOM';
  if (/\bB\.?\s*S\.?\s*O\.?\b/i.test(s)) return 'BSO';
  return null;
}

function extractCoating(text) {
  const s = String(text || '').toLowerCase();
  if (/\bdrip[\s-]*off\b/.test(s)) return 'Drip Off';
  if (/\bspot\s*uv\b/.test(s)) return 'Aqueous Varnish + Spot UV';
  if (/\bfull\s*uv\b|\buv\s*coating\b/.test(s)) return 'Full UV';
  if (/\baqueous\b|\ba\.?\s*q\.?\b|\bvarnish\b/.test(s)) return 'Aqueous Varnish';
  return null;
}

function stripForName(desc, leadCodes, spec) {
  let s = String(desc || '').trim();
  if (leadCodes.item_code) s = s.replace(/^\S+\s*/, '');
  s = s
    .replace(DATE_TOKEN_RE, ' ')
    .replace(/\b\d{2,4}\s*(?:GSM|G\.S\.M\.?|GM\/?M2|G\/M2)\b/ig, ' ')
    .replace(new RegExp(String.raw`\b${SIZE3}\s*(?:MM|CM|INCHES|INCH|IN)?\b`, 'ig'), ' ')
    .replace(/\b(?:SIZE|DIMENSIONS?|DIMES?NSIONS?|DIMS?|L\s*[x×]\s*W\s*[x×]\s*H)\b\s*[:#-]?/ig, ' ')
    .replace(new RegExp(String.raw`\b(?:BOARD|SHEET|PRINT(?:ING)?|PRINT\s*SHEET|CHILD\s*SHEET|CUT|PAPER)\s*(?:SIZE|DIMENSIONS?|DIMES?NSIONS?|DIMS?)?\s*[:#-]?\s*${SIZE2}\s*(?:INCHES|INCH|IN|")?`, 'ig'), ' ')
    .replace(/\bDIE\s*(?:NO\.?|NUMBER|CODE|#)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9\/._-]{0,19}\b/ig, ' ')
    .replace(/\b(?:A\/W|AW|ARTWORK|ART)\s*(?:CODE|NO\.?|NUMBER)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9\/._-]{0,19}\b/ig, ' ')
    .replace(/\b(?:UPS|UP\/S|UP)\s*[:#-]?\s*\d{1,3}\b|\b\d{1,3}\s*(?:UPS|UP\/S|UP)\b/ig, ' ')
    .replace(/\b(?:LOCK\s*BOTTOM|L\/B|B\.?\s*S\.?\s*O\.?)\b/ig, ' ')
    .replace(/\b(?:BOARD\s*)?(?:GRADE|QUALITY)\b\s*[:#-]?/ig, ' ')
    .replace(/\b(?:AQUEOUS|A\.?\s*Q\.?|VARNISH|DRIP[\s-]*OFF|SPOT\s*UV|FULL\s*UV|UV\s*COATING)\b/ig, ' ')
    .replace(/\b(?:NOS?|PCS?|PIECES?|UNITS?|QTY)\b/ig, ' ');
  if (spec.carton_size) s = s.replace(spec.carton_size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ' ');
  if (spec.board_grade) s = s.replace(new RegExp(`\\b${spec.board_grade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), ' ');
  if (spec.coating) s = s.replace(new RegExp(spec.coating.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  return s.replace(/\s+/g, ' ').replace(/\s+[,;:.-]\s*$/, '').trim();
}

function extractLineSpec(desc) {
  const lead = extractLeadCodes(desc);
  const spec = {
    artwork_code: lead.artwork_code,
    carton_size: extractCartonSize(desc),
    board_grade: extractBoardGrade(desc),
    gsm: extractGsm(desc),
    coating: extractCoating(desc),
    die_code: extractDieCode(desc),
    sheet_size: extractSheetSize(desc),
    ups: extractUps(desc),
    pasting_type: extractPastingType(desc),
  };
  return { ...lead, ...spec, name_text: stripForName(desc, lead, spec) };
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

function lineParts(cells) {
  const nums = [];
  const textParts = [];
  for (const c of cells) {
    const clean = c.replace(/[₹,\s]/g, '');
    if (NUM_RE.test(clean)) nums.push(parseFloat(clean));
    else textParts.push(c);
  }
  if (nums.length >= 2) {
    let descText = textParts.join(' ').trim();
    const tail = [];
    for (let i = 0; i < 2; i++) {
      const m = descText.match(/\s+₹?([\d,]+(?:\.\d+)?)\s*$/);
      if (!m) break;
      tail.unshift(parseFloat(m[1].replace(/,/g, '')));
      descText = descText.slice(0, m.index).trim();
    }
    return { nums: tail.length ? [...tail, ...nums] : nums, descText };
  }

  // Some PDFs wrap a long item row so pdfjs returns one large text cell instead
  // of separate numeric cells. In that shape the commercial numbers still sit
  // at the tail; peel only that tail so spec numbers inside the description
  // (carton size, sheet size, die, GSM) remain available to the parser.
  let descText = cells.join(' ').trim();
  const tail = [];
  for (let i = 0; i < 4; i++) {
    const m = descText.match(/\s+₹?([\d,]+(?:\.\d+)?)\s*$/);
    if (!m) break;
    tail.unshift(parseFloat(m[1].replace(/,/g, '')));
    descText = descText.slice(0, m.index).trim();
  }
  return { nums: tail.length >= 2 ? tail : nums, descText: tail.length >= 2 ? descText : textParts.join(' ') };
}

const looksLikeLineStart = text => /^\s*\d{1,3}[.)]?\s+/.test(text)
  || /^\s*(?=\S*\d)[A-Z][A-Z0-9/\-.]{3,24}\s+/.test(text);

function detectLines(rows) {
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    if (SKIP_RE.test(row.text)) continue;
    let parts = lineParts(row.cells);
    if (parts.nums.length < 2 && looksLikeLineStart(row.text) && rows[i + 1]?.page === row.page && !SKIP_RE.test(rows[i + 1].text)) {
      const combined = {
        ...row,
        cells: [...row.cells, ...rows[i + 1].cells],
        text: `${row.text} ${rows[i + 1].text}`,
      };
      const combinedParts = lineParts(combined.cells);
      if (combinedParts.nums.length >= 2) {
        row = combined;
        parts = combinedParts;
        i++;
      }
    }
    const desc = parts.descText.replace(/^\s*\d{1,3}[.)]?\s*/, '').trim();
    if (parts.nums.length < 2 || desc.replace(/[^A-Za-z]/g, '').length < 4) continue;
    // drop a leading serial number (small int in the first cell) when we still
    // have enough numbers left for qty + rate
    const firstIsSerial = NUM_RE.test((row.cells[0] || '').replace(/[₹,\s]/g, '')) && parseFloat(row.cells[0]) <= 200 && parts.nums.length > 2;
    const pick = assignQtyRate(firstIsSerial ? parts.nums.slice(1) : parts.nums);
    if (!pick || pick.qty < 1) continue;
    lines.push({ raw_text: desc, qty: pick.qty, rate: pick.rate, ...extractLineSpec(desc) });
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
