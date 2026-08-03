// Customer-WIP list ↔ Status Sheet matching. Pure — rows of text in, verdicts
// out; DB access stays in the route. A customer's WIP sheet is a list of the
// items THEY are waiting on, one product per row, usually with a date beside
// it. The heavy lifting is pomatch's PO-line matcher (alias → item code →
// product code → fuzzy), because a WIP row is the same animal as a PO line:
// the customer's own words for a product, wrapped in dates and quantities.
import { matchLine, scrub } from './pomatch.js';
import { DATE_RE, toISO } from './poparse.js';

// Rows that cannot be product lines: blank, headings, totals, page furniture.
// A heading like "PENDING WIP LIST AS ON 02/08/2026" would otherwise fuzzy-hit
// some carton and mark it urgent off a title.
const SKIP_RE = /^\s*$|TOTAL|GRAND|PAGE\s*\d|AS\s+ON|WIP\s+LIST|PENDING\s+LIST|S\.?\s*NO\b|SR\.?\s*NO\b|PARTICULARS|DESCRIPTION|ITEM\s*NAME|QTY|QUANTITY|DATE\b.*STATUS|^[\d\s.,-]+$/i;

// A row must carry some letters to be a product; three is the floor a real
// name can have (an alpha-less row is serials and quantities).
const MIN_LETTERS = 3;

export function usableRow(text) {
  const t = String(text || '').trim();
  if (SKIP_RE.test(t)) return false;
  return (t.match(/[A-Za-z]/g) || []).length >= MIN_LETTERS;
}

// The date riding a row, as ISO — the customer's own WIP date for that item.
// Null when the row carries none; the caller decides the fallback (today).
export function rowDate(text) {
  const m = String(text || '').match(DATE_RE);
  return m ? toISO(m) : null;
}

// Serials and quantities. A WIP row arrives as one string ("1  ALPHA CARTON
// 10X10  12000"), so the leading serial and the qty dilute the fuzzy score in
// a way a PO's celled lines never did — a word-for-word name landed at 0.82,
// under the 0.85 auto-match bar. Standalone number tokens can never NAME a
// product, so a second attempt strips them; tokens like 10X10 / 200ML / F10
// survive untouched (a digit glued to a letter is one word, no boundary).
const BARE_NUM = /\b\d[\d,.]*\b/g;
export function stripBareNumbers(text) {
  return String(text || '').replace(BARE_NUM, ' ').replace(/\s+/g, ' ').trim();
}

// Every usable row matched against the products currently pending on the
// Status Sheet. Returns one verdict per usable row:
//   { row, text, date, status: 'matched'|'suggested'|'none',
//     product_id (matched), confidence, suggestions }
// 'suggested' carries its top candidate so the reviewer can accept it by eye —
// the confirm dialog shows matched rows ticked and suggested rows unticked,
// and 'none' rows only as a count. Nothing here writes anything.
export function matchWipRows(rowTexts = [], products = [], aliases = []) {
  const out = [];
  rowTexts.forEach((text, row) => {
    if (!usableRow(text)) return;
    // Raw first — a digit-only party item code must stay findable — then the
    // number-stripped form when raw did not clear the bar. Best verdict wins.
    let m = matchLine(text, products, aliases);
    if (m.status !== 'matched') {
      const alt = matchLine(stripBareNumbers(text), products, aliases);
      const conf = x => x.best?.confidence ?? x.suggestions?.[0]?.confidence ?? 0;
      if (alt.status === 'matched' || conf(alt) > conf(m)) m = alt;
    }
    if (m.status === 'none') { out.push({ row, text, date: rowDate(text), status: 'none' }); return; }
    const best = m.best || m.suggestions[0];
    out.push({
      row, text: scrub(text) || text, date: rowDate(text),
      status: m.status, product_id: best.product_id, confidence: best.confidence,
      suggestions: m.suggestions,
    });
  });
  return out;
}
