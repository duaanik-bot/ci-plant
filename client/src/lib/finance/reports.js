// What the Reports screen decides without drawing anything (spec §9.2, §10): which report a path names, the period every report
// runs over, the links from one report to another, who is offered an export, and the small rules of the statement, the register
// and the parallel run. The components in components/finance/ and pages/finance/Reports.jsx only draw what these say.
//
// Dates are 'YYYY-MM-DD' text and are read as text, never through a Date, so the zone the browser is in can never move a day.
//
// Pure ESM, no React, no DOM: the server tests import this file by relative path and the browser bundles it as written. The
// relative imports are money.js, fy.js, voucher.js and tb.js (this folder) and dayOf.js, and none of them imports anything outside
// the client.
import { finFormatINR } from './money.js';
import { finFyOf, finIsValidDate } from './fy.js';
import { finDateText } from './voucher.js';
import { FIN_TB_FOOT } from './tb.js';
import { dayOf } from '../dayOf.js';

// ── The tabs and the period ──────────────────────────────────────────────────────────────────────────────────────

// The five reports, in the order of the spec. The key is the part of the path after /finance/reports/, and also the name of the
// report's route on the server (/finance/reports/<key>).
export const FIN_REPORT_TABS = Object.freeze([
  Object.freeze({ key: 'trial-balance', label: 'Trial Balance' }),
  Object.freeze({ key: 'ledger', label: 'Ledger' }),
  Object.freeze({ key: 'journal-register', label: 'Journal Register' }),
  Object.freeze({ key: 'parallel-run', label: 'Parallel Run' }),
  Object.freeze({ key: 'self-approved', label: 'Self-approved' }),
]);

// The tab the rest of a /finance/reports/... path names: its first part. Nothing, or anything that is not a tab, is the trial
// balance. Looked up in the list and never on an object, so 'constructor' is not a tab.
export function finReportTab(path) {
  const first = String(path ?? '').split('/').filter(Boolean)[0];
  return FIN_REPORT_TABS.some(t => t.key === first) ? first : FIN_REPORT_TABS[0].key;
}

const dayParam = (params, name) => {
  const value = params?.get?.(name);
  return finIsValidDate(value) ? value : null;
};

// The day a period that runs to `day` opens on when nobody chose: the later of the financial year's start (finFyOf, the 1st of April)
// and the day the books begin (ruling R58). In the books' first year the two differ: they begin on 1 January, inside FY 2026-27, and the
// Opening voucher is dated the day before. From 1 April it counts as MOVEMENT (Opening nil, the whole opening under Debit and Credit);
// from the day the books begin it is the OPENING, as in Tally. No closing moves either way, and later years are not touched.
// Books that have not begun by `day` have nothing to clamp to, so it is the year's start: the default must still be a period that starts
// before it ends. A day the books begin that is no real day is ignored.
export function finPeriodStart(day, booksBegin) {
  const start = finFyOf(day).start;
  return finIsValidDate(booksBegin) && start < booksBegin && booksBegin <= day ? booksBegin : start;
}

// The period a report runs over, from the page's query string: ?from and ?to, each a real day or else its default. The default is
// the financial year to date (finPeriodStart: from the later of 1 April and the day the books begin), ending today. `today` is the
// caller's: the browser's own day (dayOf), because the accountant's clock is the one that says what "today" means. A period that was
// chosen is never moved, and the default start follows the end that was chosen (the year THAT day falls in).
export function finReportRange(params, today, booksBegin) {
  const to = dayParam(params, 'to') ?? today;
  return { from: dayParam(params, 'from') ?? finPeriodStart(to, booksBegin), to };
}

// The sentence for a period that ends before it starts (the server's own wording, finRange), or '' when it is fine. A report is
// not asked for such a period: it would only be refused.
export const finRangeProblem = (from, to) => (from > to ? 'The start date comes after the end date.' : '');

// '1 Apr 2026 to 18 Oct 2026', or the one day when the period is a day.
export const finPeriodText = (from, to) => (from === to ? finDateText(from) : `${finDateText(from)} to ${finDateText(to)}`);

// ── Links between the reports ────────────────────────────────────────────────────────────────────────────────────

// A trial balance row opens its ledger's statement for the same period. The ledger and the period live in the URL, so the link
// can be shared and Back returns to where it came from.
export function finLedgerPath(ledgerId, from, to) {
  return `/finance/reports/ledger?${new URLSearchParams({ ledger: String(ledgerId), from, to })}`;
}

// Another tab, keeping the period only if it was chosen (it is in the URL as a real day). Everything else a tab keeps in the
// query (a ledger, an open voucher) belongs to that tab and is left behind.
export function finTabPath(tab, params) {
  const carry = new URLSearchParams();
  for (const name of ['from', 'to']) {
    const day = dayParam(params, name);
    if (day) carry.set(name, day);
  }
  const query = carry.toString();
  return `/finance/reports/${tab}${query ? `?${query}` : ''}`;
}

// A click on a tab: the path to move to, or null for the tab the page is already on. Clicking the tab you are on goes nowhere: moving to
// it would drop what that tab keeps in the query (the ledger of the Ledger tab) and add a history entry for a page that did not change.
export const finTabMove = (current, key, params) => (key === current ? null : finTabPath(key, params));

// ── Export ───────────────────────────────────────────────────────────────────────────────────────────────────────

// The props that make a DataTable offer an export (it offers one only when exportName is set). Only a book whose grant has
// can_export is handed them, and only a real `true` counts. The gate is on the screen and nowhere else: the export is built in the
// browser from rows the login may already read, and the server decides who may read (spec §8.1).
export function finExportProps(book, { name, subtitle, meta, summary, columns }) {
  if (book?.can_export !== true) return {};
  return {
    exportName: name,
    exportSubtitle: subtitle,
    ...(meta ? { exportMeta: meta } : {}),
    ...(summary ? { exportSummary: summary } : {}),
    ...(columns ? { exportColumns: columns } : {}),
  };
}

// DataTable sorts by default, which would put a running balance out of order. A table that must keep its order has every column
// unsortable, and this is how it says so: nothing is left to a column someone adds later.
export const finUnsorted = columns => columns.map(column => ({ ...column, sortable: false }));

// The figures an export carries above its rows: a statement's opening, its two sides and its closing, and the trial balance's
// three pairs of sides. Signed the ledger way where a balance is signed (Dr for positive, Cr for negative).
export function finStatementSummary(statement) {
  return [
    { label: 'Opening', value: finFormatINR(statement.opening_paise, { drcr: true }) },
    { label: 'Debits', value: finFormatINR(statement.total_debit_paise) },
    { label: 'Credits', value: finFormatINR(statement.total_credit_paise) },
    { label: 'Closing', value: finFormatINR(statement.closing_paise, { drcr: true }) },
  ];
}

// One tile for each side of each pair (final wave item 13): the PDF draws a tile at most a fifth of the page wide, and the two sides of
// a pair in one tile ran past it (68 mm in 59). The labels are the cards' own words: each card's heading (FIN_TB_FOOT in tb.js, up to
// its ' · ') and the side as the card names it, so the file says what its totals add up, as the screen does.
export function finTbSummary(totals) {
  const heading = key => FIN_TB_FOOT[key].split(' · ')[0];
  const tile = (key, side, paise) => ({ label: `${heading(key)} ${side}`, value: finFormatINR(paise) });
  return [
    tile('opening', 'Dr', totals.opening_dr), tile('opening', 'Cr', totals.opening_cr),
    tile('period', 'Debit', totals.debit), tile('period', 'Credit', totals.credit),
    tile('closing', 'Dr', totals.closing_dr), tile('closing', 'Cr', totals.closing_cr),
  ];
}

// ── The register ─────────────────────────────────────────────────────────────────────────────────────────────────

// A voucher's lines in one cell of the register: the first few, then how many more there are. An Opening voucher has a line for
// every ledger in the book, and its cell must not run to hundreds of lines; the voucher itself shows them all.
export const FIN_REGISTER_LINES_SHOWN = 6;
export function finRegisterLines(lines, max = FIN_REGISTER_LINES_SHOWN) {
  const all = Array.isArray(lines) ? lines : [];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// 'Dr Alpha Bank ₹1,234.56': a line is on one side only.
export function finLineText(line) {
  const debit = line.debit_paise > 0;
  return `${debit ? 'Dr' : 'Cr'} ${line.ledger_name} ${finFormatINR(debit ? line.debit_paise : line.credit_paise)}`;
}

// ── The parallel run ─────────────────────────────────────────────────────────────────────────────────────────────

// A row where Tally and Finance differ is red (the shared ci-row-alarm wash). Compared as the server says it (difference_paise is
// Tally less Finance), and a row that arrives with no verdict is not taken for one that agrees.
export const finParallelRowClass = row => (row.difference_paise !== 0 ? 'ci-row-alarm' : '');

// The second line under a ledger's name: what Tally called it, when that is not the same name (capitals and spaces do not count),
// or that Tally has no row for it at all.
export function finLedgerNameNote(row) {
  if (row.tally_name == null) return 'Not in the Tally file';
  const plain = text => String(text).toLowerCase().replace(/\s+/g, '');
  return plain(row.tally_name) === plain(row.ledger_name) ? '' : `Tally: ${row.tally_name}`;
}

// An upload in the picker: the month end it covers, who sent it, and the day (the browser's own).
export function finImportLabel(imp) {
  const parts = [`As at ${finDateText(imp.as_at)}`];
  if (imp.uploaded_by || imp.uploaded_at) {
    parts.push(`uploaded${imp.uploaded_by ? ` by ${imp.uploaded_by}` : ''}${imp.uploaded_at ? ` on ${finDateText(dayOf(imp.uploaded_at))}` : ''}`);
  }
  return parts.join(' · ');
}

// ── What is on screen is what was asked for ──────────────────────────────────────────────────────────────────────

// Which answer a report screen may show for the request it is making now, from what it has heard: `answer` is { url, data } (the
// newest answer to land, and the request it answered) and `failedUrl` the request that last failed. An answer is shown only for
// the very request it answered, so figures of another period, ledger or upload are never drawn under this one's name; a failure
// counts only against the request that failed. `url` is null while nothing is being asked for.
export function finReportShown({ answer, failedUrl }, url) {
  return { data: url && answer.url === url ? answer.data : null, failed: Boolean(url) && failedUrl === url };
}

// Whether the ledger the page names is one of THIS book's, from the book's ledgers (null while they load; `listFailed` when they
// could not be read): 'none' (no ledger chosen), 'loading', 'in' or 'elsewhere'. A statement is asked for only when it is 'in'. When the
// list could not be read nothing can be said against the ledger, so it is asked for, and the answer's own book is checked instead
// (finStatementBelongs).
export function finLedgerStatus(ledgerId, ledgers, listFailed) {
  if (ledgerId == null) return 'none';
  if (listFailed) return 'in';
  if (ledgers == null) return 'loading';
  return ledgers.some(l => l.id === ledgerId) ? 'in' : 'elsewhere';
}

// A statement is of this book only if its ledger says so. The answer is the authority and not the request: a ledger of the other
// book, asked for by a pasted link, is never drawn as this book's.
export const finStatementBelongs = (statement, bookId) => Boolean(statement) && statement.ledger?.book_id === bookId;

// The upload the parallel run shows: the pick while it is still one of the book's uploads, otherwise the newest (the list is newest first).
export const finPickImport = (imports, pick) => (Array.isArray(imports) ? imports.find(i => i.id === pick) ?? imports[0] ?? null : null);

// ── A report that has not come ───────────────────────────────────────────────────────────────────────────────────

// What an empty table says. A table whose answer has never come is not an empty one: it is loading, or it could not load.
// `known` is whether an answer for what is on screen has ever arrived. `blocked` is the sentence for a report that is not being
// asked for at all, yet (no ledger chosen, a period that ends before it starts): that is neither loading nor failed.
export const finReportEmpty = ({ known, failed, none, blocked }) => (
  known ? none : blocked || (failed ? 'The report couldn’t load' : 'Loading…'));
