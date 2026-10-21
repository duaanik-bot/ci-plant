// The voucher entry screen's arithmetic and keys, the pure half (spec §10). The form (components/finance/VoucherForm.jsx)
// holds the lines a person types; this file says what they add up to, which of them go to the server, and what a key press
// means. Nothing here reads the DOM, the clock or the API, so the server tests pin every rule by relative path.
//
// A form line is { ledger_id, debit_paise, credit_paise, narration, bill_ref, bill_date, due_date }. Amounts are WHOLE
// PAISE (money.js); the form keeps what was typed beside them, and these functions look only at the paise.
//
// Pure ESM, no React, no DOM, no bare imports: the server tests import this file by relative path and the browser bundles it
// as written. The relative imports are money.js and fy.js (this folder) and amountWords.js, which import nothing.
import { finFormatINR, finToPaiseTyped } from './money.js';
import { finFyOf, finIsValidDate, finMonthsOfFy } from './fy.js';
import { words, rupeesInWords } from '../amountWords.js';

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const noLedger = line => line.ledger_id == null || line.ledger_id === '';
const paiseOf = value => (Number.isFinite(value) ? value : 0);

// Debits less credits, in paise: positive when the debits are ahead, negative when the credits are.
export function finDifference(lines) {
  return lines.reduce((sum, line) => sum + paiseOf(line.debit_paise) - paiseOf(line.credit_paise), 0);
}

// What the NEXT line should hold to make the voucher balance (Tally's behaviour): the credit that answers an excess of
// debits, or the debit that answers an excess of credits. null when it already balances.
export function finBalancingLine(lines) {
  const difference = finDifference(lines);
  if (difference === 0) return null;
  return difference > 0
    ? { debit_paise: 0, credit_paise: difference }
    : { debit_paise: -difference, credit_paise: 0 };
}

// A line with no ledger and no amount: the blank row at the foot of the grid, or one a person added and never used.
// Narration or bill details typed on such a line do not make it a line.
export const finIsEmptyLine = line => noLedger(line) && paiseOf(line.debit_paise) <= 0 && paiseOf(line.credit_paise) <= 0;

// The lines as the API takes them: empty lines dropped wherever they sit, and only the API's own fields kept (the form's
// keys, typed text and error notes stay behind). Blank text is nothing, which is how the server reads it too. A half-filled
// line (a ledger and no amount, an amount and no ledger) is NOT dropped: the server names what it lacks.
export function finFormLinesToApi(lines) {
  const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  return lines.filter(line => !finIsEmptyLine(line)).map(line => ({
    ledger_id: noLedger(line) ? null : line.ledger_id,
    debit_paise: paiseOf(line.debit_paise),
    credit_paise: paiseOf(line.credit_paise),
    narration: text(line.narration),
    bill_ref: text(line.bill_ref),
    bill_date: text(line.bill_date),
    due_date: text(line.due_date),
  }));
}

// What a key press in the entry grid means: 'save' (Ctrl or Cmd with Enter, from anywhere), 'prev' (Shift+Enter), 'add-line'
// (Enter on the last field of the last line while the voucher does not balance: the next line is the one that balances it)
// or 'next' (any other Enter); null for every other key. `atLastField` and `difference` are the form's to say.
export function finVoucherKey({ key, ctrlKey, metaKey, shiftKey } = {}, { atLastField, difference } = {}) {
  if (key !== 'Enter') return null;
  if (ctrlKey || metaKey) return 'save';
  if (shiftKey) return 'prev';
  return atLastField && Number.isFinite(difference) && difference !== 0 ? 'add-line' : 'next';
}

// ── Lines on the form ────────────────────────────────────────────────────────────────────────
// A form line also keeps what was TYPED in each amount cell and the complaint about it:
//   { ledger_id, debit_text, credit_text, debit_paise, credit_paise, debit_error, credit_error,
//     narration, bill_ref, bill_date, due_date }
// The text is the truth: the paise are read from it, never the other way round, so a figure that never parsed cannot ride
// along as a stale amount. The form gives each line a React key of its own; that is not part of the line.

// The typed amount of a cell, as { paise, error }: blank is nothing (0, no complaint), a good figure is its paise, and
// anything else is 0 with the one sentence money.js says (it throws; a form must not).
export function finParseAmountText(text) {
  if (String(text ?? '').trim() === '') return { paise: 0, error: null };
  try {
    return { paise: finToPaiseTyped(text), error: null };
  } catch (e) {
    return { paise: 0, error: e.message };
  }
}

// Paise as a cell shows them: '1,250.50' with the grouping the typed form accepts, and nothing at all for no amount (a cell
// is left empty rather than showing 0.00, so a blank side reads as blank).
export function finAmountText(paise) {
  if (!Number.isFinite(paise) || paise <= 0) return '';
  return finFormatINR(paise).replace(/^₹/, '');
}

export const finBlankLine = () => ({
  ledger_id: null, debit_text: '', credit_text: '', debit_paise: 0, credit_paise: 0, debit_error: null, credit_error: null,
  narration: '', bill_ref: '', bill_date: '', due_date: '',
});

// A line as the API sends it (a voucher's lines) to a form line, for editing a draft.
export function finLineFromApi(line) {
  const debit = paiseOf(line.debit_paise);
  const credit = paiseOf(line.credit_paise);
  return {
    ledger_id: line.ledger_id ?? null,
    debit_text: finAmountText(debit), credit_text: finAmountText(credit),
    debit_paise: debit, credit_paise: credit, debit_error: null, credit_error: null,
    narration: line.narration ?? '', bill_ref: line.bill_ref ?? '', bill_date: line.bill_date ?? '', due_date: line.due_date ?? '',
  };
}

// A keystroke in an amount cell (`side` is 'debit' or 'credit'). The text is kept as typed, the paise follow it, and a figure
// that does not parse yet ('12.' on its way to '12.5') is nothing for the moment and complains of nothing: the complaint
// waits until the cell is left (finSettleAmounts). A line has ONE side, so an amount typed on one side empties the other.
export function finSetAmount(line, side, text) {
  const other = side === 'debit' ? 'credit' : 'debit';
  const { paise } = finParseAmountText(text);
  const next = { ...line, [`${side}_text`]: text, [`${side}_paise`]: paise, [`${side}_error`]: null };
  if (paise > 0) Object.assign(next, { [`${other}_text`]: '', [`${other}_paise`]: 0, [`${other}_error`]: null });
  return next;
}

// Leaving a cell, and before a save: both sides read afresh from their text. Good text is tidied ('1250.5' becomes
// '1,250.50', '0' becomes an empty cell); bad text stays as typed, with its sentence, for the person to fix.
export function finSettleAmounts(line) {
  const next = { ...line };
  for (const side of ['debit', 'credit']) {
    const { paise, error } = finParseAmountText(line[`${side}_text`]);
    next[`${side}_paise`] = paise;
    next[`${side}_error`] = error;
    if (!error) next[`${side}_text`] = finAmountText(paise);
  }
  return next;
}

// Which form rows go to the server, by index. The server counts the lines it was SENT ("Line 2 needs a ledger", a field of
// lines[1]), and the form may hold blank rows between them, so this is how the two countings meet.
export const finSentRows = lines => lines.flatMap((line, i) => (finIsEmptyLine(line) ? [] : [i]));

// Where a refusal's `field` belongs on the form, given finSentRows: { row, column } for a cell of a line (column null when the
// whole line is named), { name } for a field of the voucher itself ('narration', 'voucher_date', 'reference', 'lines'), or
// null when it names nothing the form has (no field, or a line that was never sent).
const LINE_FIELD = /^lines\[(\d+)\](?:\.([a-z_]+))?$/;
export function finFieldTarget(field, sentRows) {
  if (typeof field !== 'string' || field === '') return null;
  const hit = LINE_FIELD.exec(field);
  if (!hit) return { name: field };
  const row = sentRows[Number(hit[1])];
  return row === undefined ? null : { row, column: hit[2] ?? null };
}

// The body of a draft save. A NEW draft (`create` = { bookId, type, clientKey }) names its book, its type and its save key;
// an edit sends only what can change (its date, narration, reference and all its lines). The save key belongs to the
// create alone: the server answers a repeat of it with the draft the first save made, edits and all unapplied.
export function finDraftBody({ date, narration, reference, lines }, create = null) {
  const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const body = { voucher_date: date, narration: text(narration), reference: text(reference), lines: finFormLinesToApi(lines) };
  return create ? { book_id: create.bookId, voucher_type: create.type, client_key: create.clientKey, ...body } : body;
}

// ── The writes of a save (ruling R55) ────────────────────────────────────────────────────────
// A POST whose answer is lost may still have made the draft. The server answers a repeat of the POST's save key with THAT draft,
// edits unapplied, so a save that went out twice cannot trust what the second POST hands back: what is on screen has to be PUT to the
// draft before it is submitted, or before it is reported kept. The order of the writes lives here, as a plan and a runner that takes the
// sending as a parameter, so it is tested with a fake server; the form only supplies `send`.

// An answer the server gave to a refusal: a 4xx. The transaction behind it rolled back, so nothing was written. No answer at all (the
// connection dropped) or a 5xx (a gateway that gave up, a handler that failed) says nothing of whether the commit happened.
const refusedCleanly = status => Number.isInteger(status) && status >= 400 && status < 500;
const knownOf = ({ savedId = null, keySent = false } = {}) => ({ savedId, keySent });

// The writes of a save, in order, from where the form stands:
//   savedId  the draft the server is known to hold for this form (a POST answered with it, or it is the draft being edited), or null
//   keySent  a POST carrying this form's save key went out and was not refused cleanly: the server MAY hold a draft made from it
// A form that holds the draft PUTs to it. A form that may have made one POSTs again with the same key, to learn which, and then PUTs
// what is on screen. Otherwise it makes the draft. `thenSubmit` is Save; without it the save is Keep as draft.
export function finSavePlan(state, thenSubmit = false) {
  const { savedId, keySent } = knownOf(state);
  const steps = savedId != null ? ['put'] : keySent ? ['post', 'put'] : ['post'];
  if (thenSubmit) steps.push('submit');
  return steps;
}

// What the form knows after a write. Only a POST changes it: answered with a draft, the form holds that draft; refused cleanly, nothing
// was made and the key is as unsent as it was; with no answer, the server may hold a draft, so the key counts as sent. A PUT or a
// submit changes nothing about WHICH draft the server holds. `outcome` is { ok, id } for an answer or { ok: false, status } (status
// absent when no answer reached us).
export function finSaveAfter(state, step, { ok, id, status } = {}) {
  const { savedId, keySent } = knownOf(state);
  if (step !== 'post') return { savedId, keySent };
  if (ok) return { savedId: Number.isInteger(id) ? id : savedId, keySent: true };
  return { savedId, keySent: keySent || !refusedCleanly(status) };
}

// Runs a save's writes in the order finSavePlan gives, each through `send(step, known)` (which makes the request and answers with the
// voucher, or throws). Stops at the first write that fails, and says where and what the form knows by then; it never sends a PUT or a
// submit to a draft the server has not named. { ok: true, voucher, state } or { ok: false, step, error, state, voucher }.
export async function finRunSave({ state, thenSubmit = false, send }) {
  let now = knownOf(state);
  let voucher = null;
  for (const step of finSavePlan(now, thenSubmit)) {
    if (step !== 'post' && now.savedId == null) {
      return { ok: false, step, error: new Error('The server did not say which draft this is, so nothing more was sent.'), state: now, voucher };
    }
    try {
      voucher = await send(step, now);
    } catch (error) {
      return { ok: false, step, error, state: finSaveAfter(now, step, { ok: false, status: error?.status }), voucher };
    }
    now = finSaveAfter(now, step, { ok: true, id: voucher?.id });
  }
  return { ok: true, voucher, state: now };
}

// What the form says after a save that failed at `step`. A refusal is the server's own answer, so what it did not do is certain. No
// answer is not: the write may have gone through, and the Day Book is where to look. Never "not submitted" for a submit whose answer
// was merely lost.
const FIN_MAYBE_SAVED = "We couldn't confirm that this voucher was saved. It may be in the Day Book already, so look there before you press Save again.";
const FIN_NO_LONGER_DRAFT = 'This voucher is no longer a draft. It was most likely submitted already, so check the Day Book before you press Save again.';
export function finSaveNotice({ step, error, state } = {}) {
  const refused = refusedCleanly(error?.status);
  // A write to a draft that the server says is no longer one: an earlier submit whose answer was lost went through after all.
  if ((step === 'put' || step === 'submit') && error?.data?.code === 'FIN_NOT_DRAFT') return FIN_NO_LONGER_DRAFT;
  if (step === 'post') return refused && !state?.keySent ? '' : FIN_MAYBE_SAVED;
  if (step === 'put') {
    return refused
      ? 'The draft is saved, but your latest changes are not in it. Fix what the message says and press Save again.'
      : "We couldn't confirm that your latest changes were saved. Check the Day Book before you press Save again.";
  }
  if (step === 'submit') {
    return refused
      ? 'The draft is saved, but it was not submitted. Fix what the message says and press Save again.'
      : "The draft is saved, but we couldn't confirm that it was submitted. Check the Day Book before you press Save again.";
  }
  return '';
}

// api.js toasts what the SERVER said (an HTTP error). A write that got no answer at all, because the connection dropped, said nothing,
// so the screen says this itself.
export const FIN_NO_ANSWER_NOTE = "Couldn't reach the server — check the connection and try again.";
export const finIsNoAnswer = error => error != null && !Number.isInteger(error.status);

// ── How a voucher reads on a list, a detail and a print ──────────────────────────────────────

// The type names, one table with the server's (FIN_VOUCHER_TYPES in finance-rules.js, pinned by finance-voucher-ui.test.js).
export const FIN_TYPE_LABELS = Object.freeze({
  journal: 'Journal', receipt: 'Receipt', payment: 'Payment', contra: 'Contra',
  opening: 'Opening', sales: 'Sales', purchase: 'Purchase', credit_note: 'Credit Note', debit_note: 'Debit Note',
});

// The four a person types; the rest are made by the app.
export const FIN_ENTRY_TYPES = Object.freeze(['journal', 'receipt', 'payment', 'contra']);

export const finTypeLabel = type => (type == null ? '—' : has(FIN_TYPE_LABELS, type) ? FIN_TYPE_LABELS[type] : String(type));

// A voucher's state in the words a person uses: a submitted entry is "waiting approval", and a posted one with a reversal
// against it is "reversed". `key` picks the colour, `label` is the word.
export function finStatusOf(voucher) {
  const status = voucher?.status;
  if (status === 'draft') return { key: 'draft', label: 'Draft' };
  if (status === 'submitted') return { key: 'waiting', label: 'Waiting approval' };
  if (status === 'posted') return voucher.reversed_by_id != null ? { key: 'reversed', label: 'Reversed' } : { key: 'posted', label: 'Posted' };
  if (status === 'discarded') return { key: 'discarded', label: 'Discarded' };
  return { key: String(status ?? ''), label: String(status ?? '—') };
}

// What to call a voucher in a title: its number, which it gets when it posts and never before; until then what it is.
export function finNumberText(voucher) {
  if (voucher?.number) return voucher.number;
  const status = voucher?.status;
  return status === 'draft' ? 'Draft' : status === 'submitted' ? 'Awaiting approval' : status === 'discarded' ? 'Discarded draft' : '—';
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A calendar day for the screen: '17 Oct 2026'. Read from the text, never through a Date, because a Date at UTC midnight is the
// day before in every zone west of Greenwich; '—' for anything that is not a real day.
export function finDateText(day) {
  if (!finIsValidDate(day)) return '—';
  const [year, month, date] = day.split('-');
  return `${date} ${MONTH_SHORT[Number(month) - 1]} ${year}`;
}

// The calendar month a day falls in, { from, to }, for the "posted this month" figure. A day that is no day is refused (fy.js).
export function finMonthOf(day) {
  const month = finMonthsOfFy(finFyOf(day).label).find(m => m.start_date <= day && day <= m.end_date);
  return { from: month.start_date, to: month.end_date };
}

// The dates the Day Book opens on, and comes back to when its filters are reset: the month `today` falls in (ruling R72). A
// book's whole history, up to 5,000 rows, asked again on every realtime tick, is what pauses every project on the ERP's Vercel
// plan; widening the dates is one change away.
export const finDayBookWindow = today => finMonthOf(today);

// The counts the Vouchers page shows (ruling R72), each one GET /finance/vouchers with count=1 and the filters of what it counts:
// { key, view, filters }. The server counts with the list's own query, so a figure always agrees with the list it opens. The
// caller's drafts and approvals are asked only of a login that has them (entering, approving); the rest of every login.
//   drafts     the caller's drafts (the Drafts tab and its figure)
//   approvals  what waits for the caller to approve (the Approvals tab)
//   waiting    everything waiting in the book, the caller's own included
//   today      posted, dated today; month: posted, dated in `month` ({ from, to }: the calendar month of `today` unless the page
//              names its own, as the Vouchers page does, so the figure, its label and the Day Book it opens all agree).
//              Voucher dates, as the list filters on them.
export function finVoucherCountAsks({ today, month = finMonthOf(today), mayApprove = false, mayEnter = false }) {
  return [
    mayEnter && { key: 'drafts', view: 'drafts', filters: { count: '1' } },
    mayApprove && { key: 'approvals', view: 'approvals', filters: { count: '1' } },
    { key: 'waiting', view: 'daybook', filters: { status: 'submitted', count: '1' } },
    { key: 'today', view: 'daybook', filters: { status: 'posted', from: today, to: today, count: '1' } },
    { key: 'month', view: 'daybook', filters: { status: 'posted', from: month.from, to: month.to, count: '1' } },
  ].filter(Boolean);
}

// Whether a voucher prints as ONE fitted A4 sheet (.print-fit: kept whole on its page) or flows across as many pages as it takes, its
// table header repeated on each (final review M-9). Up to FIN_PRINT_FIT_LINES lines, with the header, the words and the signatures, is
// a page; the Opening voucher can have thousands, which no sheet kept whole can hold.
export const FIN_PRINT_FIT_LINES = 15;
export const finPrintFits = lines => (Array.isArray(lines) ? lines.length : 0) <= FIN_PRINT_FIT_LINES;

// The date a new voucher opens on: the last one used (kept in storage), while that is still a real day, otherwise today.
export const finPickDate = (remembered, today) => (finIsValidDate(remembered) ? remembered : today);

// A total in words for the print. amountWords.js drops the paise by rounding, which would print Rs 1,234.50 as "One Thousand
// Two Hundred Thirty Five", so the rupees and the paise are said apart.
export function finAmountWords(paise) {
  const total = Math.max(0, Math.round(paiseOf(paise)));
  const rupees = Math.floor(total / 100);
  const rest = total % 100;
  return rest ? `Rupees ${words(rupees)} and ${words(rest)} Paise Only` : rupeesInWords(rupees);
}

// Whether a DRAFT can be edited, from the facts a list row carries. The Opening voucher and a reversal are built by the app and
// never edited by hand (ruling R24). The voucher view's `can` stays the authority wherever there is one; this is for the
// Drafts tab, whose rows come without it, and finance-voucher-ui.test.js pins it to finVoucherCan.
export const finDraftEditable = row => row.voucher_type !== 'opening' && row.reversal_of_id == null;

// A save key for a new draft: a UUID the server takes (finClientKey), made once per opened form. crypto.randomUUID exists only
// in a secure context (https or localhost), and a tablet may reach the ERP over plain http, so without it the key is built
// from random bytes: a version 4 UUID all the same.
export function finNewSaveKey(cryptoObj = globalThis.crypto) {
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// What the Number column sorts by: the financial year, then the serial (CI-JV-2627-0012 is 2627 and 12). The table's own sort
// reads a text that looks like a date AS a date, and V8 takes 'CI-JV-2627-0012' for one, so the numbers would come out in
// an order that means nothing. A voucher with no number yet sorts first.
export function finNumberKey(number) {
  const hit = /-(\d{4})-(\d+)$/.exec(typeof number === 'string' ? number : '');
  return hit ? Number(hit[1]) * 1e7 + Number(hit[2]) : 0;
}

// ── Sentences the Vouchers page owes ─────────────────────────────────────────────────────────

// The Day Book list stops here (FIN_LIST_MAX in finance-vouchers.js, pinned by the test) and says so when it does.
export const FIN_LIST_CAP = 5000;
export const FIN_TRUNCATED_NOTE = `The list stops at ${FIN_LIST_CAP.toLocaleString('en-IN')} vouchers. Narrow the dates to see the rest.`;

// A phone approves and reads; entering a voucher is for a computer or a tablet.
export const FIN_PHONE_ENTRY_NOTE = 'Use a computer or tablet to enter vouchers.';
