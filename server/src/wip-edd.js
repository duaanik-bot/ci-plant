// Reading the customer's EDD out of their WIP list.
//
// A WIP row often carries TWO dates — the day the customer marked the item, and
// the day they want it. Joined into one string those are indistinguishable, and
// picking the wrong one writes a wrong delivery date onto a real order, which is
// what the plant schedules against. So this reads the sheet BY ITS COLUMNS, the
// same lesson the Tally PO import learned: find the heading, then take that
// column's cell.
//
// Nothing here writes. Every date it returns is shown in the review dialog and
// stays editable before anything is applied — which is what makes the positional
// fallback below safe enough to offer at all.

import { DATE_RE, toISO } from './poparse.js';

// What a customer calls the date they want the goods. Deliberately generous —
// these sheets are written by hand in a dozen houses — but every alternative
// names a DELIVERY, never a marking: "as on" and "WIP date" must not match here
// or the two dates swap and every EDD lands a month early.
export const EDD_HEADER_RE =
  /\b(e\.?\s*d\.?\s*d\.?|expected\s*deliver\w*|deliver\w*\s*(date|by)?|due\s*(date|by)?|dispatch\s*(date|by)?|target\s*date|required\s*(by|date)|sched\w*\s*date|want\w*\s*by)\b/i;

// The other date, named so it can be told apart rather than guessed at.
export const WIP_HEADER_RE = /\b(w\.?\s*i\.?\s*p\.?|as\s*on|marked|pending\s*since|status\s*date)\b/i;

// A row is a header if any cell names a date column we recognise. Scanned over
// the first rows only: a customer's own item called "Delivery Tablets" further
// down must not be mistaken for a heading.
const HEADER_SCAN_ROWS = 12;

const cellsOf = row => (Array.isArray(row?.cells) ? row.cells : [])
  .map(c => String(c ?? '').trim());
const textOf = row => String(row?.text ?? row ?? '');

// Which column holds the EDD, if the sheet says so.
//
// Returns the FIRST cell whose text names a delivery date and which is not also
// naming the WIP date — a sheet with "WIP DATE" and "DELIVERY DATE" side by side
// must resolve to the second, and a single "DATE" column names neither.
export function findEddColumn(rows = []) {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const cells = cellsOf(rows[i]);
    if (cells.length < 2) continue;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      if (!cell || WIP_HEADER_RE.test(cell)) continue;
      if (EDD_HEADER_RE.test(cell)) return { headerIndex: i, eddCol: c, label: cell };
    }
  }
  return null;
}

// Every date in a row's text, in the order they appear.
export function datesIn(text) {
  const out = [];
  const re = new RegExp(DATE_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) out.push(toISO(m));
  return out;
}

// How this file's EDD will be read, decided once for the whole upload so the
// review can SAY which rule it used.
//
//   header      the sheet names a delivery column — take that cell
//   positional  no heading, but the rows consistently carry a second date;
//               it is offered as the EDD and flagged for the planner's eye
//   none        nothing to read; the import marks WIP and leaves EDD alone
//
// The positional rule requires a MAJORITY of usable rows to carry exactly two
// dates. One stray row with two dates in a file that otherwise has one is a
// typo, not a column, and reading it as an EDD would move a delivery date on
// the strength of a smudge.
export function eddPlan(rows = []) {
  const header = findEddColumn(rows);
  if (header) return { mode: 'header', ...header };

  const dated = rows.map(r => datesIn(textOf(r))).filter(ds => ds.length > 0);
  if (dated.length < 2) return { mode: 'none' };
  const two = dated.filter(ds => ds.length >= 2).length;
  if (two > dated.length / 2) return { mode: 'positional' };
  return { mode: 'none' };
}

// The EDD for one row under the plan. Null whenever the sheet does not clearly
// say — an absent EDD leaves the order's existing date alone, which is always
// safer than writing a guess over it.
export function eddForRow(row, plan) {
  if (!plan || plan.mode === 'none') return null;
  if (plan.mode === 'header') {
    const cells = cellsOf(row);
    const cell = cells[plan.eddCol];
    if (!cell) return null;
    const m = String(cell).match(DATE_RE);
    return m ? toISO(m) : null;
  }
  // positional: the second date on the row, never the first (that one is the
  // day the customer marked it, which /wip-match already reads as the WIP date)
  const ds = datesIn(textOf(row));
  return ds.length >= 2 ? ds[1] : null;
}

// EDD lives on the ORDER, not the line — one delivery date covers every product
// on that PO. So a file that asks for two different dates on one order is asking
// for something the schema cannot hold, and the last write would silently win.
//
// Returns one entry per order that is being pulled two ways. The caller refuses
// those rather than picking for the planner: a delivery date the plant schedules
// against must never be decided by row order.
export function eddConflicts(items = []) {
  const byOrder = new Map();
  for (const it of items) {
    if (!it || it.edd == null || it.order_id == null) continue;
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, new Set());
    byOrder.get(it.order_id).add(it.edd);
  }
  return [...byOrder.entries()]
    .filter(([, dates]) => dates.size > 1)
    .map(([order_id, dates]) => ({ order_id, dates: [...dates].sort() }));
}
