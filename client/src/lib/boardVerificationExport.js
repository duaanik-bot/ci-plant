// The Board Stock Verification report's export spec — pure, no React, no DOM.
//
// It lives apart from the page for two reasons. The obvious one is that a spec
// this large is worth unit-testing. The load-bearing one is that a PDF can only
// be judged by looking at it, and a plain module can be rendered headlessly
// against real plant data; a spec trapped inside a component cannot.
//
// Excel and paper are given DIFFERENT column sets on purpose — see `pdfColumns`
// in exporter.js. A spreadsheet wants one fact per column so it can be sorted
// and filtered; an A4 page wants few enough columns that each still holds a
// word. Every fact dropped from the printed page survives in the workbook.
import { fmt } from '../api.js';
import { customerInitials } from './customerCode.js';
import { squash } from './searchKey.js';

// The verification vocabulary. Defined here rather than in the page so the
// export, the screen and the tests cannot drift into three spellings — the same
// reason the board verdict lives in one module.
export const VERIF_LABEL = {
  pending: 'Pending Verification',
  verified: 'Physically Verified',
  mismatch: 'Quantity Mismatch',
  not_found: 'Material Not Found',
  partial: 'Partially Available',
};

export const CUT_LABEL = {
  not_sent: 'Not Sent to Cutting',
  waiting: 'Waiting for Cutting',
  planned: 'Cutting Planned',
  started: 'Cutting Started',
};

export const sizeOf = b => (b?.sheet_l && b?.sheet_w ? `${+b.sheet_l}×${+b.sheet_w}"` : '—');

// The spec line printed under a board's name — grade, GSM and sheet size.
//
// Returns EMPTY when the name already says it, which on live data is almost
// always: the plant composes board names as "Saffire · 340 GSM · 25x36", so an
// unconditional sub-line printed every board twice. It still earns its place on
// the boards whose names carry nothing (placeholders, legacy spellings), which
// is exactly where a warehouseman needs the size spelled out.
//
// Compared through `squash`, the same normaliser the search box uses, and for
// the same reason: the NAME writes the size with the letter x ("25x36") while
// `sizeOf` writes it with the multiplication sign ("25×36"). Merely stripping
// punctuation keeps the one and drops the other, so the two spellings never
// matched and every board still printed twice. squash collapses the dimension
// separator FIRST — that ordering is the whole point of the helper.
export function boardSpecLine(b) {
  const spec = [b?.grade, b?.gsm ? `${b.gsm} GSM` : null, sizeOf(b)].filter(Boolean).join(' · ');
  if (!spec || spec === '—') return '';
  return squash(b?.board_name).includes(squash(spec)) ? '' : spec;
}

// Stacked printed cell: the lines that exist, joined by a real newline.
// exporter.js keeps "\n" through its WinAnsi sanitizer precisely for this.
const stack = (...lines) => lines.filter(Boolean).join('\n');

// A date that prints nothing rather than an em dash when absent, so a stacked
// cell does not grow a line saying "—".
const dateOr = (d, prefix = '') => (d ? `${prefix}${fmt.date(d)}` : '');

// The client as the floor says it: SGLS, not "Swiss Garnier Life Sciences".
// A printed column wide enough for the registered name is a column stolen from
// the product, and the full name is one sheet away in the workbook.
export const clientShort = name => customerInitials(name) || name || '—';

export function verificationText(b) {
  const v = b.verification;
  if (!v || b.verification_status === 'pending') return VERIF_LABEL.pending;
  return `${VERIF_LABEL[v.status]}${v.physical_qty != null ? ` · counted ${fmt.num(v.physical_qty)}` : ''}`
    + ` · ${v.verified_by || '—'} · ${fmt.dt(v.created_at)}${b.verification_stale ? ' · STALE — requirement moved' : ''}`;
}

const prText = j => (j.pr_covered ? 'PR raised for this job'
  : j._board?.pr_pending_qty > 0 ? 'Board PR pending' : '—');

// `boardFull` is injected: the board verdict's wording belongs to BoardStatus,
// which is a component module (JSX + icons) this file must not pull in to stay
// headless-testable. The page passes the real map; a test asserting the page
// passes it is cheaper than the coupling.
export function buildBoardVerificationSpec({
  boards = [], totalBoards = 0, records = [], meta = [], summary = [], boardFull = {},
} = {}) {
  const jobRows = boards.flatMap(b => b.jobs.map(j => ({ ...j, _board: b })));
  const docRows = boards.flatMap(b => [
    ...b.prs.map(x => ({
      kind: 'PR', number: x.pr_number, board: b.board_name, qty: x.qty,
      status: fmt.title(x.status), when: fmt.date(x.created_at),
    })),
    ...b.pos.map(x => ({
      kind: 'PO', number: x.po_number, board: b.board_name, qty: x.pending_qty,
      status: fmt.title(x.status),
      when: x.expected_date ? `expected ${fmt.date(x.expected_date)}` : '—',
    })),
  ]);

  return {
    name: 'Board Stock Verification',
    title: 'Board Stock Verification Report',
    subtitle: 'Physical stock check before cutting — jobs awaiting cutting only',
    orientation: 'landscape',
    sheetPerSection: true,
    meta,
    summary,
    sections: [
      {
        heading: 'Board Verification Summary',
        // Excel: one fact per column.
        columns: [
          { key: 'board_name', label: 'Board Name' },
          { key: 'grade', label: 'Board Type', export: b => b.grade || '—' },
          { key: 'gsm', label: 'GSM', align: 'right', export: b => b.gsm || '—' },
          { key: 'size', label: 'Sheet Size', export: b => sizeOf(b) },
          { key: 'required', label: 'Cumulative Required', align: 'right', export: b => b.required },
          { key: 'job_count', label: 'Jobs', align: 'right', export: b => b.job_count },
          { key: 'available', label: 'Available Stock', align: 'right', export: b => b.available },
          { key: 'committed', label: 'Booked (All Jobs)', align: 'right', export: b => b.committed },
          { key: 'on_order_total', label: 'On Order', align: 'right', export: b => b.pr_pending_qty + b.po_pending_qty },
          { key: 'shortage', label: 'Shortage', align: 'right', export: b => b.shortage },
          { key: 'uncovered', label: 'Uncovered', align: 'right', export: b => b.uncovered },
          { key: 'stock_state', label: 'Stock Position', export: b => boardFull[b.stock_state] || b.stock_state },
          { key: 'verification', label: 'Physical Verification', export: verificationText },
          { key: 'remarks', label: 'Verification Remarks', export: b => b.verification?.remarks || '—' },
        ],
        // Paper: the board's identity in one cell, the two shortage figures in
        // one cell, the verification and who took it in one cell.
        pdfColumns: [
          {
            key: 'board_name', label: 'Board', pdfWeight: 18,
            export: b => stack(b.board_name, boardSpecLine(b)),
          },
          { key: 'job_count', label: 'Jobs', align: 'right', pdfWeight: 5, export: b => b.job_count },
          { key: 'required', label: 'Required', align: 'right', pdfWeight: 8, export: b => fmt.num(b.required) },
          // Wide enough that "WAREHOUSE" fits on one line — a numeric column
          // narrower than its own heading breaks the heading, not the numbers.
          { key: 'available', label: 'In Warehouse', align: 'right', pdfWeight: 11, export: b => fmt.num(b.available) },
          { key: 'committed', label: 'Booked', align: 'right', pdfWeight: 8, export: b => fmt.num(b.committed) },
          { key: 'on_order_total', label: 'On Order', align: 'right', pdfWeight: 8, export: b => fmt.num(b.pr_pending_qty + b.po_pending_qty) },
          {
            key: 'shortage', label: 'Shortage', align: 'right', pdfWeight: 10,
            // The second line says what is happening about the shortfall, and
            // never repeats the figure above it: when nothing is on order the
            // two numbers are equal, and printing both reads as two shortages.
            export: b => (b.shortage > 0
              ? stack(fmt.num(b.shortage),
                b.uncovered <= 0 ? 'on order'
                  : b.uncovered >= b.shortage ? 'none on order'
                    : `${fmt.num(b.uncovered)} uncovered`)
              : '—'),
          },
          { key: 'stock_state', label: 'Stock Position', pdfWeight: 12, export: b => boardFull[b.stock_state] || b.stock_state },
          { key: 'verification', label: 'Physical Verification', pdfWeight: 17, export: verificationText },
          { key: 'remarks', label: 'Remarks', pdfWeight: 12, export: b => b.verification?.remarks || '—' },
        ],
        rows: boards,
      },
      {
        heading: 'Board-wise Product Details',
        columns: [
          { key: 'board', label: 'Board', export: j => j._board.board_name },
          { key: 'customer_name', label: 'Client', export: j => j.customer_name },
          { key: 'po_number', label: 'Sales Order / PO', export: j => `${j.po_number}${j.po_date ? ` · ${fmt.date(j.po_date)}` : ''}` },
          { key: 'jc_number', label: 'Job Card', export: j => (j.jc_number ? `${j.jc_number} · ${fmt.date(j.jc_created_at)}` : 'Not created') },
          { key: 'product_name', label: 'Product', export: j => `${j.product_name}${j.gang_number ? ` (${j.gang_number})` : ''}` },
          { key: 'product_code', label: 'Product Code', export: j => j.product_code || '—' },
          { key: 'party_artwork_code', label: 'Artwork Code', export: j => j.party_artwork_code || j.internal_carton_code || '—' },
          { key: 'order_qty', label: 'Order Qty', align: 'right', export: j => j.order_qty ?? '—' },
          { key: 'planned_qty', label: 'To Produce', align: 'right', export: j => j.planned_qty ?? '—' },
          { key: 'need', label: 'Board Needed', align: 'right', export: j => j.need },
          { key: 'open_need', label: 'Still to Source', align: 'right', export: j => j.open_need },
          { key: 'planned_date', label: 'Planned Cutting', export: j => fmt.date(j.planned_date) },
          { key: 'delivery_date', label: 'Dispatch Date', export: j => fmt.date(j.delivery_date) },
          { key: 'cutting_status', label: 'Cutting Status', export: j => CUT_LABEL[j.cutting_status] },
          { key: 'pr_status', label: 'PR Status', export: prText },
          { key: 'line_notes', label: 'Remarks', export: j => j.line_notes || '—' },
        ],
        // Sixteen columns is what shredded this section on paper. Nine, each
        // stacking its own related facts, is what a warehouse can read.
        pdfColumns: [
          {
            key: 'board', label: 'Board', pdfWeight: 13,
            export: j => stack(j._board.board_name, boardSpecLine(j._board)),
          },
          { key: 'customer_name', label: 'Client', pdfWeight: 5, export: j => clientShort(j.customer_name) },
          { key: 'po_number', label: 'Sales Order', pdfWeight: 10, export: j => stack(j.po_number, dateOr(j.po_date)) },
          { key: 'jc_number', label: 'Job Card', pdfWeight: 10, export: j => (j.jc_number ? stack(j.jc_number, dateOr(j.jc_created_at)) : 'Not created') },
          {
            key: 'product_name', label: 'Product', pdfWeight: 25,
            export: j => stack(
              `${j.product_name}${j.gang_number ? ` (${j.gang_number})` : ''}`,
              [j.product_code, j.party_artwork_code || j.internal_carton_code].filter(Boolean).join(' · '),
            ),
          },
          { key: 'order_qty', label: 'Order Qty', align: 'right', pdfWeight: 7, export: j => (j.order_qty != null ? fmt.num(j.order_qty) : '—') },
          {
            key: 'need', label: 'Board Needed', align: 'right', pdfWeight: 9,
            // The PR flag rides on the "buy" line rather than taking a column:
            // it only ever has something to say about a job that is short.
            export: j => stack(
              fmt.num(j.need),
              [j.open_need > 0 ? `buy ${fmt.num(j.open_need)}` : '', j.pr_covered ? 'PR' : ''].filter(Boolean).join(' · '),
            ),
          },
          {
            // Dispatch was a column of its own until live data settled it: the
            // delivery date is null on almost every open line, so the column
            // printed 57 blank cells and charged the product column for the
            // width. It rides here now, on the rows that actually have one.
            key: 'cutting_status', label: 'Cutting', pdfWeight: 13,
            export: j => stack(
              CUT_LABEL[j.cutting_status],
              dateOr(j.planned_date),
              j.delivery_date ? `disp ${fmt.date(j.delivery_date)}` : '',
            ),
          },
        ],
        rows: jobRows,
      },
      {
        heading: 'Stock Shortage Report',
        columns: [
          { key: 'board_name', label: 'Board Name', pdfWeight: 24 },
          { key: 'gsm', label: 'GSM', align: 'right', pdfWeight: 6, export: b => b.gsm || '—' },
          { key: 'size', label: 'Sheet Size', pdfWeight: 10, export: b => sizeOf(b) },
          // Grouped like every other sheet. Excel still reads these as numbers —
          // its coercion strips the separators before typing the cell.
          { key: 'required', label: 'Required', align: 'right', pdfWeight: 9, export: b => fmt.num(b.required) },
          { key: 'available', label: 'Available', align: 'right', pdfWeight: 9, export: b => fmt.num(b.available) },
          { key: 'shortage', label: 'Shortage', align: 'right', pdfWeight: 9, export: b => fmt.num(b.shortage) },
          { key: 'on_order_total', label: 'On Order (PR+PO)', align: 'right', pdfWeight: 10, export: b => fmt.num(b.pr_pending_qty + b.po_pending_qty) },
          { key: 'uncovered', label: 'Uncovered', align: 'right', pdfWeight: 9, export: b => fmt.num(b.uncovered) },
          { key: 'earliest_planned_date', label: 'Earliest Cutting', pdfWeight: 11, export: b => fmt.date(b.earliest_planned_date) },
          { key: 'stock_state', label: 'Risk', pdfWeight: 14, export: b => boardFull[b.stock_state] || b.stock_state },
        ],
        rows: boards.filter(b => b.shortage > 0),
      },
      {
        heading: 'Pending PR and PO Report',
        columns: [
          { key: 'kind', label: 'Type', pdfWeight: 6 },
          { key: 'number', label: 'Number', pdfWeight: 14 },
          { key: 'board', label: 'Board', pdfWeight: 34 },
          { key: 'qty', label: 'Pending Qty', align: 'right', pdfWeight: 12, export: r => fmt.num(r.qty) },
          { key: 'status', label: 'Status', pdfWeight: 14 },
          { key: 'when', label: 'Raised / Expected', pdfWeight: 20 },
        ],
        rows: docRows,
      },
      {
        heading: 'Physical Verification Records',
        columns: [
          { key: 'board_name', label: 'Board', pdfWeight: 24 },
          { key: 'status_label', label: 'Status', pdfWeight: 15, export: r => r.status_label || VERIF_LABEL[r.status] || r.status },
          { key: 'physical_qty', label: 'Counted', align: 'right', pdfWeight: 8, export: r => (r.physical_qty == null ? '—' : fmt.num(r.physical_qty)) },
          { key: 'required_qty', label: 'Required at Count', align: 'right', pdfWeight: 9, export: r => (r.required_qty == null ? '—' : fmt.num(r.required_qty)) },
          { key: 'available_qty', label: 'Book at Count', align: 'right', pdfWeight: 9, export: r => (r.available_qty == null ? '—' : fmt.num(r.available_qty)) },
          { key: 'shortage_qty', label: 'Shortage', align: 'right', pdfWeight: 8, export: r => (r.shortage_qty == null ? '—' : fmt.num(r.shortage_qty)) },
          { key: 'excess_qty', label: 'Excess', align: 'right', pdfWeight: 8, export: r => (r.excess_qty == null ? '—' : fmt.num(r.excess_qty)) },
          { key: 'verified_by', label: 'Verified By', align: undefined, pdfWeight: 12, export: r => r.verified_by || '—' },
          { key: 'created_at', label: 'Date & Time', pdfWeight: 14, export: r => fmt.dt(r.created_at) },
          { key: 'remarks', label: 'Remarks', pdfWeight: 18, export: r => r.remarks || '—' },
        ],
        rows: records,
      },
    ],
    _totalBoards: totalBoards,
  };
}
