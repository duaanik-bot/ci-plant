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
      // `w` is the printed width of the run. Keeping it is what lets the
      // columnar reader below place a figure by the span it occupies rather
      // than by the point it starts at — right-aligned money columns start at
      // wildly different x for "5.00" and "63450.000" but occupy one band.
      .map(it => ({ str: String(it.str).trim(), x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
      .filter(it => it.str);
    const byY = [];
    for (const it of items) {
      const bucket = byY.find(b => Math.abs(b.y - it.y) < 2.5);
      if (bucket) bucket.items.push(it); else byY.push({ y: it.y, items: [it] });
    }
    for (const b of byY.sort((a, z) => z.y - a.y)) {
      const sorted = b.items.sort((a, z) => a.x - z.x);
      const cells = sorted.map(i => i.str);
      rows.push({ page: p, y: b.y, items: sorted, cells, text: cells.join(' ') });
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
  // Swiss labels each axis inside the spec paragraph — "DIMENSION: L80 x W18 x
  // H79mm". Read before the bare-triple fallback below, which otherwise seizes
  // the pack configuration out of "OUTERCARTON(10X2X15)" and calls it a size.
  const axes = String.raw`L\s*${DIM}\s*[x×]\s*W\s*${DIM}\s*[x×]\s*H\s*${DIM}`;
  const lwh = s.match(new RegExp(String.raw`\b(?:CARTON|BOX)?\s*(?:SIZE|DIMENSIONS?|DIMS?)?\s*[:#-]?\s*(${axes}\s*(?:MM|CM)?)`, 'i'));
  if (lwh) return normalizeSize(lwh[1].replace(/[LWH]\s*(?=\d)/ig, ''));
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

// `extra` is the specification paragraph the columnar reader peels off the
// description column. The spec fields are read from description AND paragraph;
// the NAME is stripped from the description alone, so the paragraph never
// reaches raw_text or the alias key.
function extractLineSpec(desc, extra = '') {
  const lead = extractLeadCodes(desc);
  const specSrc = extra ? `${desc} ${extra}` : desc;
  const spec = {
    artwork_code: lead.artwork_code || extractArtworkCode(specSrc, lead.item_code),
    carton_size: extractCartonSize(specSrc),
    board_grade: extractBoardGrade(specSrc),
    gsm: extractGsm(specSrc),
    coating: extractCoating(specSrc),
    die_code: extractDieCode(specSrc),
    sheet_size: extractSheetSize(specSrc),
    ups: extractUps(specSrc),
    pasting_type: extractPastingType(specSrc),
  };
  return { ...lead, ...spec, spec_text: extra || null, name_text: stripForName(desc, lead, spec) };
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

// ---------------------------------------------------------------------------
// Columnar reader
//
// detectLines() below infers qty and rate from the SHAPE of the numbers on a
// row. That inference is wrong the moment a row carries other integers: an
// 8-digit HSN code outranks a 3,000 quantity under Math.max, and a line's
// taxable value reads as its quantity. Eleven of the twenty-three real POs on
// file parsed to numbers that were not merely off but absurd — a ₹63,450 rate
// on a ₹2.35 carton — and nothing downstream questioned them.
//
// When a table prints its own headings we can stop guessing: read the headings,
// turn them into x bands, and take each figure from the column it is actually
// printed under. Two properties of real POs make this harder than it sounds and
// are the reason for the shape of the code below:
//
//  1. Headings STACK. Swiss Garnier prints "Basic" over "Rate" and "TAXABLE"
//     over "VALUE", three and four rows deep. Any single-row reading of that
//     heading sees a Qty with no Rate, or a Rate with no Amount, and mis-prices
//     every line. So the model is built from a BLOCK of consecutive heading
//     rows, clustered by overlapping x spans.
//  2. Figures drift off their row. On the same template the rate prints ~2.5px
//     above its own line — just outside the row bucket — so it arrives as a row
//     of its own. Those fragments are re-attached to the nearest line that is
//     missing that column (see attachFragments).
//
// Anything without a usable heading falls through to detectLines() untouched.
// ---------------------------------------------------------------------------

// Tested in order — "TAXABLE VALUE" must land on amount before "RATE" claims
// it, and a bare "VALUE" is an amount, not a rate.
const ROLE_PATTERNS = [
  ['amount', /TAXABLE\s*VALUE|NET\s*AMOUNT|TOTAL\s*VALUE|\bAMOUNT\b|\bVALUE\b/],
  ['rate', /\bRATE\b|\bBASIC\b|\bUNIT\s*PRICE\b|\bPRICE\b/],
  ['qty', /\bQTY\b|\bQUANTITY\b/],
  ['desc', /\bDESCRIPTION\b|\bPARTICULARS?\b|\bGOODS\b/],
  ['code', /\bITEM\s*CODE\b|\bHSN\b|\bSAC\b|\bPART\s*(?:NO|CODE)\b|\bSKU\b/],
  ['uom', /^(?:UOM|UNITS?|PER)$/],
  ['sl', /^(?:SL|SR|S\s*NO|SERIAL|#)\b/],
];

const roleOf = label => {
  const s = String(label).toUpperCase().replace(/[^A-Z0-9%]+/g, ' ').trim();
  return ROLE_PATTERNS.find(([, re]) => re.test(s))?.[0] || null;
};

const spanOf = it => ({ x0: it.x, x1: it.x + (it.w || 0) });
const centreOf = it => it.x + (it.w || 0) / 2;

// A heading row carries labels, not figures. Excluding numeric rows is what
// stops the block from swallowing the first data line.
const HEAD_NUM_RE = /^[₹]?[\d,]+(?:\.\d+)?$/;
const isHeadingRow = row => row.items.length > 0
  && !row.items.some(it => it.str.length >= 2 && HEAD_NUM_RE.test(it.str.replace(/[₹,\s]/g, '')));

// Cluster heading items into columns by overlapping x spans. Strictly
// overlapping — a 3px tolerance is enough to weld Tally's "Sl"(39-49) onto its
// neighbouring "No. & Kind"(51-90) and collapse two columns into one.
function clusterHeadings(headRows) {
  const items = headRows.flatMap(r => r.items.map(it => ({ ...it })));
  const clusters = [];
  for (const it of items.sort((a, z) => a.x - z.x)) {
    const s = spanOf(it);
    const hit = clusters.find(c => s.x0 < c.x1 && c.x0 < s.x1);
    if (hit) {
      hit.x0 = Math.min(hit.x0, s.x0);
      hit.x1 = Math.max(hit.x1, s.x1);
      hit.parts.push(it);
    } else {
      clusters.push({ x0: s.x0, x1: s.x1, parts: [it] });
    }
  }
  return clusters.map(c => {
    // Top row first, so a stacked heading reads "Basic Rate", not "Rate Basic".
    const label = c.parts.sort((a, z) => z.y - a.y || a.x - z.x).map(p => p.str).join(' ');
    return { x0: c.x0, x1: c.x1, label, role: roleOf(label) };
  });
}

// Midpoint boundaries between neighbouring columns. A figure belongs to the
// band its CENTRE falls in.
function toBands(clusters) {
  const s = [...clusters].sort((a, z) => a.x0 - z.x0);
  return s.map((c, i) => ({
    ...c,
    lo: i === 0 ? -Infinity : (s[i - 1].x1 + c.x0) / 2,
    hi: i === s.length - 1 ? Infinity : (c.x1 + s[i + 1].x0) / 2,
  }));
}

// A model is only worth trusting when the table names what a line item IS and
// both what was ordered and what it costs. Description + qty + (rate or
// amount): with an amount but no rate the rate is recoverable by division, and
// vice versa, but neither is recoverable from a description alone.
function usableModel(bands) {
  const roles = new Set(bands.map(b => b.role).filter(Boolean));
  return roles.has('desc') && roles.has('qty') && (roles.has('rate') || roles.has('amount'));
}

// Scans ONE page's rows. Multi-page POs repeat the whole letterhead — buyer and
// consignee addresses, state codes — above the table on every sheet, and all of
// it sits under the description column. Searching the document as one run made
// page two's address block read as a continuation of page one's last item.
// Anchor on the one row that names the table, then grow the block outwards to
// pick up the stacked halves of the headings.
//
// The growth rule is the load-bearing part: a row may join only if it does not
// REDUCE the number of distinct columns. Everything above a Tally table is
// left-aligned address text — "State Name : Uttar Pradesh, Code : 09" spans the
// serial, packet-count and description columns at once — so a block grown by
// "is this row free of digits?" alone swallows the letterhead and welds three
// columns into one. That is what put the serial number inside the item name and
// dropped sixteen of thirty lines on Sales Order_4. A genuine stacked heading
// ("Basic" over "Rate") only ever merges WITHIN a column, never across two.
export function findColumnModel(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (!isHeadingRow(rows[i])) continue;
    const anchor = clusterHeadings([rows[i]]);
    // The anchor only has to be the row that identifies a line ITEM. Demanding
    // the money columns here too rejects the Swiss variant that prints
    // "Sl. | Description of Goods | Qty. | UOM" on one row and
    // "HSN/SAC | Rate | VALUE | IGST" on the next — neither row qualifies alone.
    // The full desc+qty+(rate|amount) gate is applied to the assembled block.
    const anchorRoles = new Set(anchor.map(c => c.role).filter(Boolean));
    if (!anchorRoles.has('desc') || !anchorRoles.has('qty')) continue;
    let block = [rows[i]];
    let count = anchor.length;
    let last = i;
    // Compared against the block built SO FAR, not against the anchor: the
    // stacked rows legitimately add columns, and measuring against the anchor's
    // original count leaves that much slack for a later row to weld two of them
    // back together. On PO 119 that let "Transport Mode :" join the block and
    // swallow the serial column into the item code.
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (!isHeadingRow(rows[j])) break;
      const cand = [rows[j], ...block];
      const n = clusterHeadings(cand).length;
      if (n < count) break;
      block = cand; count = n;
    }
    for (let j = i + 1; j < rows.length && j <= i + 3; j++) {
      if (!isHeadingRow(rows[j])) break;
      const cand = [...block, rows[j]];
      const n = clusterHeadings(cand).length;
      if (n < count) break;
      block = cand; count = n; last = j;
    }
    const bands = toBands(clusterHeadings(block));
    if (usableModel(bands)) return { bands, start: last + 1 };
  }
  return null;
}

// Everything below these belongs to the footer, not the table.
const TABLE_END_RE = /AMOUNT\s+CHARGEABLE|\(IN\s+WORDS\)|IN\s+WORDS\s*[:)]|DECLARATION|TERMS\s*&?\s*CONDITIONS?|GROSS\s+VALUE|BANK\s+DETAIL|JURISDICTION/i;

const firstNumber = text => {
  const m = String(text || '').match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Continuation text under the Description column is either the rest of the
// item's NAME or the specification paragraph that follows it. Only the name
// may join raw_text: raw_text is what pomatch fuzzy-scores and what alias
// learning is keyed on, and folding a five-line spec paragraph into it would
// re-key learned aliases across the whole catalogue.
// GSM is written "350GSM" as often as "350 GSM", so it cannot be anchored with
// a leading \b — that miss routed a whole board specification into the item
// name on every Tally line.
const SPEC_PARA_RE = /DIMENSION|SPEC\s*[:.]|GSM\b|DESIGN\s*\/?\s*STYLE|ARTWORK\s*CODE|APPROVED\s*AW|TUCK\s*IN|LOCK\s*BOTTOM|DRIP\s*OFF|SPOT\s*UV|EMBOSS|\bBOARD\b|COLOUR\s*&/i;
const isSpecPara = t => /^\s*\(/.test(t) || SPEC_PARA_RE.test(t);
// "Mfg:" and friends — a stray column label, not part of any name.
const isStrayLabel = t => /^[A-Za-z]{1,6}\s*:?$/.test(t.trim());

function cellsByRole(row, bands) {
  const out = {};
  for (const it of row.items) {
    const c = centreOf(it);
    const band = bands.find(b => c >= b.lo && c < b.hi);
    if (band?.role) (out[band.role] ||= []).push(it.str);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(' ').trim()]));
}

// A figure that drifted onto a row of its own belongs to the nearest line that
// has nothing in that column yet. Nearest by |Δy| and NOT direction-specific:
// this template floats the rate above its line, and scanned POs have been seen
// printing amounts below theirs.
function attachFragments(lines, fragments) {
  if (!lines.length) return;
  const pitch = lines.length > 1
    ? Math.abs(lines[0].y - lines[lines.length - 1].y) / (lines.length - 1)
    : 20;
  const reach = Math.max(8, Math.min(pitch * 1.4, 40));
  for (const f of fragments) {
    for (const role of ['rate', 'amount', 'qty']) {
      if (f[role] == null) continue;
      const target = lines
        .filter(l => l.page === f.page && l[role] == null && Math.abs(l.y - f.y) <= reach)
        .sort((a, z) => Math.abs(a.y - f.y) - Math.abs(z.y - f.y))[0];
      if (target) target[role] = f[role];
    }
  }
}

function readPage(pageRows, bands, start, lines, fragments) {
  // Scoped to this page: a description may only continue onto rows of the same
  // sheet, so a page break can never glue a letterhead onto an item name.
  let current = null;
  for (let i = start; i < pageRows.length; i++) {
    const row = pageRows[i];
    if (TABLE_END_RE.test(row.text)) break;
    if (SKIP_RE.test(row.text)) continue;
    const cell = cellsByRole(row, bands);

    const qty = firstNumber(cell.qty);
    const desc = String(cell.desc || '').trim();
    // What starts a line is a quantity against a description, corroborated by
    // the row's own serial number or its money column — NOT the description
    // having three letters in it. Tally names its cartons "F1D3" and "M1O2"
    // under a bare numeric party code, so a letter-count test threw those rows
    // back into the continuation branch: five items vanished outright and six
    // more were glued onto the description of the item above them.
    const rate = firstNumber(cell.rate);
    const amount = firstNumber(cell.amount);
    const corroborated = /\d/.test(String(cell.sl || ''))
      || rate != null || amount != null
      || desc.replace(/[^A-Za-z]/g, '').length >= 3;

    if (qty != null && qty > 0 && desc && corroborated) {
      // The customer's own item code sits in its own column on this template
      // rather than leading the description. Put it back at the front so
      // extractLeadCodes and pomatch's party-item-code hit still see it — but
      // only when it is a code, not the row's HSN.
      const code = String(cell.code || '').trim();
      const lead = /[A-Za-z]/.test(code) && !/^\d+$/.test(code) ? `${code} ` : '';
      current = {
        page: row.page, y: row.y,
        desc: `${lead}${desc}`.trim(),
        spec: '',
        qty, rate, amount,
      };
      lines.push(current);
      continue;
    }

    // No quantity: either the rest of the description, or a drifting figure.
    if (desc && current) {
      const t = desc.trim();
      if (isStrayLabel(t)) continue;
      if (isSpecPara(t)) current.spec = `${current.spec} ${t}`.trim();
      else current.desc = `${current.desc} ${t}`.trim();
      continue;
    }
    if (!desc && (cell.rate || cell.amount || cell.qty)) {
      fragments.push({
        page: row.page, y: row.y,
        rate: firstNumber(cell.rate), amount: firstNumber(cell.amount), qty,
      });
    }
  }
}

function detectLinesColumnar(rows) {
  const pages = [];
  for (const row of rows) {
    if (!pages.length || pages[pages.length - 1].page !== row.page) pages.push({ page: row.page, rows: [] });
    pages[pages.length - 1].rows.push(row);
  }
  const lines = [];
  const fragments = [];
  let bands = null;
  for (const pg of pages) {
    const model = findColumnModel(pg.rows);
    // A continuation sheet sometimes drops the heading; carry the last model
    // over rather than losing the page, but never invent one out of nothing.
    if (model) bands = model.bands;
    else if (!bands) continue;
    readPage(pg.rows, bands, model ? model.start : 0, lines, fragments);
  }
  if (!lines.length) return [];

  attachFragments(lines, fragments);

  return lines.map(l => {
    // Rate and amount each recover the other, so a line only needs one of them.
    let { qty, rate, amount } = l;
    if (rate == null && amount != null && qty) rate = Math.round((amount / qty) * 1000) / 1000;
    if (amount == null && rate != null && qty) amount = Math.round(qty * rate * 100) / 100;
    // The line's own arithmetic is the only check that does not depend on
    // trusting the reader that produced it.
    const reconciled = amount != null && rate != null && qty
      ? Math.abs(qty * rate - amount) / Math.max(amount, 1) < 0.02
      : null;
    return {
      raw_text: l.desc, qty, rate, amount, reconciled,
      ...extractLineSpec(l.desc, l.spec),
    };
  }).filter(l => l.qty > 0);
}

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
  // Read the table by its own headings when it prints them; fall back to the
  // number-shape heuristic otherwise. The columnar result is only accepted if
  // it actually found lines — a heading that parses but yields nothing must not
  // silently turn a readable PO into an empty one.
  const columnar = detectLinesColumnar(rows);
  const lines = columnar.length ? columnar : detectLines(rows);
  return {
    scanned: false,
    reader: columnar.length ? 'columns' : 'shape',
    header_text: headerRows.map(r => r.text).join(' '),
    po_number: findPoNumber(rows),
    po_date: findDate(rows, /P\.?\s*O\.?\s*DATE|ORDER\s*DATE|\bDATED?\b/i),
    delivery_date: findDate(rows, /DELIVERY|DEL\.?\s*DATE|SUPPLY\s*BY|DUE\s*DATE/i),
    lines,
  };
}
