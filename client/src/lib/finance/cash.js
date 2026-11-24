// Cash & Bank entries as pure functions (spec §5.1 entry lines, §5.2 cash warnings,
// §5.3 float top-up, §5.6 TDS on a receipt or payment), and below them the Cash & Bank
// screen's pure half (spec §5, §5.1–§5.7, §6.4, §7.5, §7.7): what its pickers offer, the
// links into it, the book's window and rows, the adjustment's preview rows and ticks, the
// warnings beside the form, and the HR inbox in words. The screen
// (pages/finance/CashBank.jsx and its components) draws what these say;
// server/src/finance-cash-wiring.test.js pins them.
//
// Amounts are whole paise. The only imports are the rupee formatter and the calendar
// (money.js and fy.js, which import nothing); no React, no DOM, so the server imports this
// file by relative path and the browser bundles it as written.

import { finFormatINR } from './money.js';
import { finDayBefore, finIsValidDate } from './fy.js';

export const FIN_CASH_LIMITS = Object.freeze({ s269stPaise: 20_000_000, s40a3Paise: 1_000_000 });

const line = (ledger_id, debit_paise, credit_paise) => ({ ledger_id, debit_paise, credit_paise });

// receive  Dr account (amount) · Dr TDS (if any) · Cr other (amount + TDS)
// pay      Dr other (amount + TDS) · Cr account (amount) · Cr TDS (if any)
// transfer Dr other (the to-account) · Cr account (the from-account)
export function finCashLines({ entry_type, account_ledger_id, other_ledger_id, amount_paise, tds_paise = 0, tds_ledger_id = null }) {
  if (!Number.isSafeInteger(amount_paise) || amount_paise <= 0) {
    throw new RangeError('amount_paise must be a whole number of paise above zero');
  }
  if (!Number.isSafeInteger(tds_paise) || tds_paise < 0) {
    throw new RangeError('tds_paise must be a whole number of paise, zero or more');
  }
  if (tds_paise > 0 && entry_type === 'transfer') throw new RangeError('A transfer carries no TDS');
  if (tds_paise > 0 && tds_ledger_id == null) throw new RangeError('TDS needs a TDS ledger');
  const total = amount_paise + tds_paise;

  if (entry_type === 'receive') {
    return [
      line(account_ledger_id, amount_paise, 0),
      ...(tds_paise > 0 ? [line(tds_ledger_id, tds_paise, 0)] : []),
      line(other_ledger_id, 0, total),
    ];
  }
  if (entry_type === 'pay') {
    return [
      line(other_ledger_id, total, 0),
      line(account_ledger_id, 0, amount_paise),
      ...(tds_paise > 0 ? [line(tds_ledger_id, 0, tds_paise)] : []),
    ];
  }
  if (entry_type === 'transfer') {
    return [line(other_ledger_id, amount_paise, 0), line(account_ledger_id, 0, amount_paise)];
  }
  throw new RangeError(`Unknown entry_type "${entry_type}"`);
}

// Fixed order: ON_ACCOUNT, S269ST, S40A3, BELOW_ZERO or HOLDER_SHORT.
export function finCashWarnings({ entry_type, is_cash, is_holder, account_name, party_cash_today_paise, balance_after_paise, on_account_paise }) {
  const out = [];
  if (on_account_paise > 0) {
    out.push({ code: 'ON_ACCOUNT', sentence: `${finFormatINR(on_account_paise)} stays on account.` });
  }
  if (is_cash && entry_type === 'receive' && party_cash_today_paise >= FIN_CASH_LIMITS.s269stPaise) {
    out.push({ code: 'S269ST', sentence: 'Cash received from this party today reaches ₹2,00,000 (Income-tax Act s.269ST).' });
  }
  if (is_cash && entry_type === 'pay' && party_cash_today_paise > FIN_CASH_LIMITS.s40a3Paise) {
    out.push({ code: 'S40A3', sentence: 'Cash paid to this party today is over ₹10,000 (Income-tax Act s.40A(3)).' });
  }
  if (balance_after_paise < 0) {
    out.push(is_holder
      ? { code: 'HOLDER_SHORT', sentence: `${account_name} holds less than this.` }
      : { code: 'BELOW_ZERO', sentence: `This takes ${account_name} below zero.` });
  }
  return out;
}

// What it takes to bring a holder back to the float; nothing when there is no float.
export function finTopUpPaise({ float_paise, holds_paise }) {
  if (float_paise == null) return 0;
  return Math.max(0, float_paise - holds_paise);
}

// ── The Cash & Bank screen's pure half ─────────────────────────────────────────────────────

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The ledger roles whose ledger no entry of the screen names: staff money, which is entered in
// HR (spec §5.2, §7.1), and Cash Short & Excess, which only a count clears (ruling R10). The
// server refuses them (finance-cash.js: FIN_STAFF_IN_HR, FIN_DIFFERENCE_VIA_COUNT); the
// pickers do not offer them.
export const FIN_CASH_UNOFFERED_ROLES = Object.freeze(['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense', 'cash_difference']);

// The ledger ids a book's role map keeps off the pickers: GET /finance/hr-setup's `roles`,
// { role: ledger_id }. Anything that is not a map is none.
export function finUnofferedLedgerIds(roles) {
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) return new Set();
  return new Set(FIN_CASH_UNOFFERED_ROLES.filter(role => has(roles, role)).map(role => roles[role]).filter(Number.isSafeInteger));
}

// What an entry form's two pickers offer (spec §5.1–§5.3), in the order they offer it:
//   accounts  what money comes into or goes out of: `accounts` is the tiles' list (GET
//             /finance/cash/accounts: office cash, then the holders, then the banks), each kept
//             while its ledger is switched on and open to typed entries;
//   others    who it comes from or goes to. A transfer's is another of those accounts, never
//             `except` (the one it comes from). A receive offers the customers first and a pay
//             the vendors first (party_side), then every other ledger the entry may name:
//             switched on, open to typed entries, no bank or cash account (money between two
//             is a Transfer), none of `unoffered` (finUnofferedLedgerIds).
// `ledgers` are GET /finance/books/:id/ledgers' rows; each group keeps that list's order (by name).
export function finEntryChoices({ entry_type, ledgers, accounts, unoffered = new Set(), except = null } = {}) {
  const list = Array.isArray(ledgers) ? ledgers : [];
  const usable = l => l.active === true && l.manual_entry === true;
  const byId = new Map(list.map(l => [l.id, l]));
  const money = (Array.isArray(accounts) ? accounts : []).map(a => byId.get(a.ledger_id)).filter(l => l && usable(l));
  if (entry_type === 'transfer') return { accounts: money, others: money.filter(l => l.id !== except) };
  const first = entry_type === 'pay' ? 'vendor' : 'customer';
  const rest = list.filter(l => usable(l) && !l.is_bank_cash && !unoffered.has(l.id) && l.id !== except);
  return { accounts: money, others: [...rest.filter(l => l.party_side === first), ...rest.filter(l => l.party_side !== first)] };
}

// A link into the screen (spec §11 items 4 and 6, the ERP's own doors): ?receive_customer=<ERP
// customer id> opens Receive from that customer, ?pay_vendor=<ERP vendor id> Pay to that vendor.
// { entry_type, party_type, party_id }, party_id null when the link names nobody it could be;
// null when there is no link. `params` is a URLSearchParams.
const FIN_LINK_ID = /^[1-9][0-9]{0,9}$/;
export function finCashLinkIn(params) {
  if (!params || typeof params.get !== 'function') return null;
  for (const [key, entry_type, party_type] of [['receive_customer', 'receive', 'customer'], ['pay_vendor', 'pay', 'vendor']]) {
    const text = params.get(key);
    if (text == null || text === '') continue;
    const id = FIN_LINK_ID.test(text) ? Number(text) : null;
    return { entry_type, party_type, party_id: id != null && id <= 2147483647 ? id : null };
  }
  return null;
}

// The book's ledger an ERP customer or vendor is linked to (party_type and party_id), switched on,
// or null.
export function finLedgerOfParty(ledgers, { party_type, party_id } = {}) {
  if (!Array.isArray(ledgers) || party_id == null) return null;
  return ledgers.find(l => l.active === true && l.party_type === party_type && l.party_id === party_id) ?? null;
}

// The calendar month `delta` months from the one `day` falls in: { from, to }.
const monthStart = n => `${String(Math.floor(n / 12)).padStart(4, '0')}-${String((n % 12) + 1).padStart(2, '0')}-01`;
export function finMonthWindow(day, delta = 0) {
  const n = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return { from: monthStart(n), to: finDayBefore(monthStart(n + 1)) };
}

// The window the book opens on (spec §5: the current month): the month `today` falls in, or, while
// the books have not begun (nothing but the Opening is posted before then), the month they begin in.
export function finCashWindow(today, booksBegin) {
  return finMonthWindow(finIsValidDate(booksBegin) && today < booksBegin ? booksBegin : today);
}

// The day an entry form opens on (spec §5.1: the last one used): `remembered` while it is a day;
// otherwise today, or the day the books begin while they have not begun.
export function finEntryDate(remembered, today, booksBegin) {
  if (finIsValidDate(remembered)) return remembered;
  return finIsValidDate(booksBegin) && today < booksBegin ? booksBegin : today;
}

// The book's rows as the table draws them (spec §5): the opening, the posted entries in the
// server's order (date, then entry order: the running balance is true only in it, so it is never
// re-sorted), and the closing with the window's totals. `_row` is the table's key.
export function finBookRows(book) {
  if (!book || !Array.isArray(book.entries)) return [];
  return [
    { _row: 'opening', kind: 'opening', date: book.from, balance_paise: book.opening_paise },
    ...book.entries.map((entry, i) => ({ ...entry, _row: `e${i}`, kind: 'entry' })),
    { _row: 'closing', kind: 'closing', date: book.to, in_paise: book.total_in_paise, out_paise: book.total_out_paise, balance_paise: book.closing_paise },
  ];
}

// What waits for approval, apart from the book and outside its balance (spec §5), with its own
// subtotal: { rows, in_paise, out_paise }.
export function finPendingRows(book) {
  const pending = Array.isArray(book?.pending) ? book.pending : [];
  return {
    rows: pending.map((row, i) => ({ ...row, _row: `p${i}` })),
    in_paise: pending.reduce((sum, row) => sum + row.in_paise, 0),
    out_paise: pending.reduce((sum, row) => sum + row.out_paise, 0),
  };
}

// ── The book's lines, lean (ruling R65) ──────────────────────────────────────────────────────
// A busy account's month is thousands of lines, and as objects every key is spelled out on every line: 2,033 lines were 466 KB, and
// Vercel's Fast Origin Transfer meters the bytes before the edge compresses them, so it is the shape that counts. The station
// workspace's convention (lib/sectionLean.js): the screen asks for lean rows (finWithLeanRows: `rows=lean`), GET /finance/cash/book then
// sends each of its two lists as its column names once and one array per line (finLeanBook, on the server), and the page puts the
// objects back once per response, before it keeps the answer (finRehydrateBook), so everything past that point (the table, search, the
// export and print) reads exactly the rows it read before. Asked for nothing, the route answers the objects, as it always has.
export const FIN_LEAN_ROWS_QUERY = 'rows=lean';
export const finWithLeanRows = path => `${path}${path.includes('?') ? '&' : '?'}${FIN_LEAN_ROWS_QUERY}`;
// Exactly the string: an array (`?rows=lean&rows=lean`) or any other value gets the objects.
export const finLeanRowsAsked = query => query?.rows === 'lean';

// The columns of the book's two lists: the keys of the objects finCashBook builds (finance-cash.js), in their order.
export const FIN_BOOK_ENTRY_COLUMNS = Object.freeze([
  'date', 'voucher_id', 'number', 'voucher_type', 'particulars', 'narration', 'adjustment', 'in_paise', 'out_paise', 'balance_paise',
]);
export const FIN_BOOK_PENDING_COLUMNS = Object.freeze([
  'date', 'voucher_id', 'voucher_type', 'particulars', 'narration', 'in_paise', 'out_paise', 'submitted_by',
]);

// Objects → { columns, rows }: the column names once, then one array per object, its values in the columns' order. An object whose keys
// are not exactly `columns`, in that order, is a bug in the caller: it throws, rather than drop a field a screen reads.
export function finLeanRows(objects, columns) {
  const rows = objects.map(object => {
    const keys = Object.keys(object);
    if (keys.length !== columns.length || keys.some((key, i) => key !== columns[i])) {
      throw new Error(`A lean row takes exactly the columns ${columns.join(', ')}, in that order; this one has ${keys.join(', ')}`);
    }
    return columns.map(column => object[column]);
  });
  return { columns: [...columns], rows };
}

// { columns, rows } → the objects, each with its keys in the columns' order. Anything else (a list of objects) is handed back as it came.
const finIsLean = list => list != null && !Array.isArray(list) && Array.isArray(list.columns) && Array.isArray(list.rows);
export function finRehydrateRows(list) {
  if (!finIsLean(list)) return list;
  return list.rows.map(row => Object.fromEntries(list.columns.map((column, i) => [column, row[i]])));
}

// The book with its entries and pending lines lean (the server's side), and the lean book put back (the page's side), every other key
// as it was and in its place. A book that is not lean (one asked for plainly) is handed back as the same object.
export function finLeanBook(book) {
  return { ...book, entries: finLeanRows(book.entries, FIN_BOOK_ENTRY_COLUMNS), pending: finLeanRows(book.pending, FIN_BOOK_PENDING_COLUMNS) };
}
export function finRehydrateBook(book) {
  if (!book || (!finIsLean(book.entries) && !finIsLean(book.pending))) return book;
  return { ...book, entries: finRehydrateRows(book.entries), pending: finRehydrateRows(book.pending) };
}

// A preview's list as the adjustment draws it (spec §5.1's sketch): each item the preview sent,
// with what it gets (`gets_paise`, its allocation, 0 for none) and what is left open of it after
// (`left_paise`); `settles` is 'all' when it is settled in full, 'part' when only some, null when
// it gets nothing.
export function finAdjustRows(items, allocations) {
  const gets = new Map();
  for (const a of Array.isArray(allocations) ? allocations : []) gets.set(a.line_id, (gets.get(a.line_id) ?? 0) + a.amount_paise);
  return (Array.isArray(items) ? items : []).map(item => {
    const got = gets.get(item.line_id) ?? 0;
    const left = item.open_paise - got;
    return { ...item, gets_paise: got, left_paise: left, settles: got === 0 ? null : left === 0 ? 'all' : 'part' };
  });
}

// What a redo or an Adjust saved (PUT /finance/lines/:id/allocations' answer), in a sentence.
export function finAdjustedText({ allocations, on_account_paise } = {}) {
  const bills = new Set((Array.isArray(allocations) ? allocations : []).map(a => a.line_id)).size;
  const left = finFormatINR(Number.isSafeInteger(on_account_paise) ? on_account_paise : 0);
  return bills === 0 ? `Nothing settled: ${left} on account` : `Adjusted: ${bills} bill${bills === 1 ? '' : 's'}, ${left} on account`;
}

// A Pick's ticks (spec §6.4), in tick order: [{ line_id, amount_paise }], amount_paise null for
// all that is open (the allocator trims the last to what is left). A tick adds the bill at the end
// and a second one takes it away; an amount typed for a ticked bill replaces its null, and a
// cleared one (null) puts it back. Neither changes the list it is given.
export function finTogglePick(picks, lineId) {
  const list = Array.isArray(picks) ? picks : [];
  return list.some(p => p.line_id === lineId) ? list.filter(p => p.line_id !== lineId) : [...list, { line_id: lineId, amount_paise: null }];
}
export function finPickAmount(picks, lineId, amountPaise) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.some(p => p.line_id === lineId)) return list;
  return list.map(p => (p.line_id === lineId ? { ...p, amount_paise: amountPaise ?? null } : p));
}

// The warnings beside an entry form (spec §5.6; they never refuse), from what the screen knows
// before it saves: the account's tile (its kind, its name, its balance as at today), this entry's
// amount, and the party's preview: what stays on account, and the party's cash that day
// (party_cash_day_paise, ruling R59: its cash receipts or payments in the book that day, posted and
// waiting for approval, this entry left out), to which this entry is added for s.269ST and s.40A(3).
export function finEntryWarnings({ entry_type, account, amount_paise, preview = null } = {}) {
  if (!account || !Number.isSafeInteger(amount_paise) || amount_paise <= 0) return [];
  const isCash = account.account_kind === 'cash' || account.account_kind === 'holder';
  const isHolder = account.account_kind === 'holder';
  const earlier = Number.isSafeInteger(preview?.party_cash_day_paise) ? preview.party_cash_day_paise : 0;
  return finCashWarnings({
    entry_type, is_cash: isCash, is_holder: isHolder, account_name: isHolder ? account.holder_name ?? account.name : account.name,
    party_cash_today_paise: isCash && entry_type !== 'transfer' ? earlier + amount_paise : 0,
    balance_after_paise: isCash && entry_type !== 'receive' ? account.balance_paise - amount_paise : null,
    on_account_paise: preview?.on_account_paise ?? 0,
  });
}

// How long a read held to once every `everyMs` waits (the HR line on a realtime tick, finding F3): nothing
// when the last read was that long ago or more, else the rest of the wait, and never more than all of it
// (a clock that went back).
export function finThrottleWait(now, lastAt, everyMs) {
  return Math.min(everyMs, Math.max(0, lastAt + everyMs - now));
}

// ── The HR inbox in words (spec §7.5, §7.7). Kinds of entry, HR document numbers and the
// server's own sentences: never a person (§7.4). ─────────────────────────────────────────

// An HR event's kind (finance-hr-catchup.js: an exception's `type`).
export const FIN_HR_EVENT_TEXT = Object.freeze({
  advance: 'Advance given', sheet: 'Advance sheet line', sheetAdvances: 'Advances on the payroll sheet', loan: 'Loan given',
  prepay: 'Loan repaid', batch: 'Salary paid', line: 'Salary paid (one line)', run: 'Payroll month', waiver: 'Advance waived',
  hidden: 'Combined salary entry',
});
export function finHrEventText({ type, document_no } = {}) {
  const what = typeof type === 'string' && has(FIN_HR_EVENT_TEXT, type) ? FIN_HR_EVENT_TEXT[type] : 'HR entry';
  return document_no ? `${what} · ${document_no}` : what;
}

// The fix an exception names (§7.7: map the channel, reopen the month, or ask the MD; and retry, when Finance was only busy, ruling
// R73), as the screen says it. A fix it does not know is the MD's.
export const FIN_HR_FIX_TEXT = Object.freeze({
  map_channel: 'Map the pay channel, or set the missing ledger, in Finance Setup → HR & payroll, then retry.',
  reopen_month: 'Reopen the month, or add its financial year, in Finance Setup → Months & Years, then retry.',
  retry: 'Nothing to fix: retry it, or Bring in from HR.',
  ask_md: 'Ask the MD.',
});
export const finHrFixText = fix => (typeof fix === 'string' && has(FIN_HR_FIX_TEXT, fix) ? FIN_HR_FIX_TEXT[fix] : FIN_HR_FIX_TEXT.ask_md);

// What one "Bring in from HR" did (POST /finance/hr/bring-in: { posted, submitted, skipped,
// exceptions, more }), and what to do when it stopped with more to go (ruling R38a).
export const FIN_BRING_IN_MORE = 'More to bring in: press Bring in again';
export function finBringInText({ posted = 0, submitted = 0, skipped = 0, exceptions = [] } = {}) {
  const failed = Array.isArray(exceptions) ? exceptions.length : 0;
  const parts = [
    posted > 0 && `Posted ${posted}`,
    submitted > 0 && `${submitted} waiting for approval`,
    skipped > 0 && `${skipped} skipped`,
    failed > 0 && `${failed} exception${failed === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing to bring in';
}

// The control check (spec §7.5; GET /finance/hr/status's `control`) in a few words: { tone, text }.
// Salary payable is null when the book pays the month when it is paid, and then it is not counted.
const FIN_CONTROL_ITEMS = Object.freeze([
  ['advances', 'Staff advances differ'], ['loans', 'Staff loans differ'], ['salary_payable', 'Salary payable differs'],
]);
export function finControlText(control) {
  if (control === null || typeof control !== 'object') return { tone: 'neutral', text: '—' };
  const gaps = FIN_CONTROL_ITEMS.filter(([key]) => control[key] != null && control[key].gap_paise !== 0);
  if (gaps.length === 0) return { tone: 'good', text: 'matches' };
  if (gaps.length > 1) return { tone: 'warn', text: `${gaps.length} differences` };
  const [key, says] = gaps[0];
  return { tone: 'warn', text: `${says} by ${finFormatINR(Math.abs(control[key].gap_paise))}` };
}
